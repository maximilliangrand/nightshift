/**
 * Meters `openclaw agent`, one turn of an OpenClaw agent run through its
 * gateway (or embedded with --local).
 *
 * Two facts about OpenClaw, observed on 2026.4.10 rather than assumed:
 *
 * 1. `--json` prints a single pretty-printed envelope on stdout, and only
 *    when the turn is over. It carries the aggregate usage of the turn
 *    (input, output, total), the model and provider, the session id and the
 *    reply payloads. No dollars, no cache tokens, no per-call breakdown, and
 *    nothing at all while the turn is running. The CLI is a thin client: the
 *    model calls happen inside the gateway process.
 *
 * 2. While the turn runs, the gateway appends every model message to the
 *    session transcript under `<state dir>/agents/<agent>/sessions/`, each
 *    with usage (input, output, cacheRead, cacheWrite) and the cost OpenClaw
 *    computed from its own model catalog. The store next to it
 *    (`sessions.json`) maps the session key to that file and is written at
 *    run start, so the transcript can be found before the run ends.
 *
 * So the meter reads both. The transcript tailer gives a live count that a
 * budget can act on; the final envelope is the authoritative aggregate and a
 * floor under whatever the tailer saw. Dollars come from the transcript's
 * own cost when OpenClaw priced the model, from list prices when the model
 * is a Claude id, and from the ceiling price otherwise, so the budget is
 * never blind. OpenClaw has no budget flag of its own; nightshift is the only
 * line.
 *
 * Attribution is never a guess by time. Without a --session-id of its own the
 * run gets one, `nightshift-<run id>`, and the tailer reads only the store
 * entry carrying that id (or the id the envelope names). A session that
 * existed before the run is read from where it stood when the run found it,
 * so a reused session bills only what this run appended.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../redact.js";
import { fmtCount, fmtDuration } from "../units.js";
import { basename, emptyUsage, forcedInstrumentation, type Adapter, type InstrumentOptions, type Instrumentation, type Meter, type MeterHooks } from "./adapter.js";
import { CEILING_PRICE, costOf, priceFor } from "./claude.js";

/** Global options of the openclaw CLI that consume the next argument. */
const GLOBAL_VALUE_OPTIONS = new Set(["--container", "--profile", "--log-level"]);
const MAX_COMMANDS_KEPT = 200;
const DEFAULT_POLL_MS = 1000;
/** The store is megabytes on a busy machine; do not parse it more often than this while looking for the session. */
const STORE_LOOKUP_GAP_MS = 2000;
/** The store entry is written at run start; allow a little clock skew between the gateway and us. */
const START_SLACK_MS = 2000;
/** One poll reads at most this much; the rest waits for the next poll rather than one giant buffer. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** The transcript's first line is a small header object; this is more than enough to hold it. */
const HEADER_BYTES = 4096;

/** Is this argv `openclaw agent ...`? Global options may precede the subcommand. */
export function isOpenClawCommand(argv: string[]): boolean {
  const base = basename(argv);
  if (base !== "openclaw" && base !== "openclaw.mjs") return false;
  return subcommand(argv) === "agent";
}

function subcommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("-")) {
      if (GLOBAL_VALUE_OPTIONS.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return null;
}

function hasOption(argv: string[], name: string): boolean {
  return argv.some((a) => a === name || a.startsWith(`${name}=`));
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const arg = argv[index] ?? "";
  return arg.includes("=") ? arg.slice(name.length + 1) : argv[index + 1];
}

/** The session id a run gets when the command names none. OpenClaw creates it; the store key ends in `:explicit:<this>`. */
export function isolatedSessionId(runId: string): string {
  return `nightshift-${runId}`;
}

/**
 * Make an `openclaw agent` invocation observable: add --json when absent and
 * render the reply back as text; leave an explicit --json alone and just
 * listen. Give the run its own session id when the command has none, so the
 * transcript can be found by id rather than guessed by time. There is no
 * budget flag to pass through, so the notes say who is enforcing the budget
 * and where the kill can and cannot reach.
 */
export function instrumentOpenClawArgv(argv: string[], opts: InstrumentOptions): Instrumentation {
  const args = [...argv];
  if (opts.forced && !isOpenClawCommand(args)) return forcedInstrumentation(args, "openclaw");
  const notes: string[] = [];
  const hadJson = args.includes("--json");
  if (!hadJson) args.push("--json");
  if (opts.runId && !hasOption(args, "--session-id")) {
    const sessionId = isolatedSessionId(opts.runId);
    args.push("--session-id", sessionId);
    notes.push(`run isolated in its own OpenClaw session ${sessionId}; pass --session-id yourself to continue an existing one`);
  }
  if (opts.budgetUsd !== undefined) {
    notes.push("openclaw agent has no budget flag; --budget is enforced by nightshift alone, live from the session transcript and finally from the JSON result");
    if (!args.includes("--local")) {
      notes.push("the turn runs inside the OpenClaw gateway: a kill stops the wait, not the gateway's run; pass --local for a run the kill reaches");
    }
  }
  return { argv: args, renders: !hadJson, metered: true, notes };
}

interface MessageUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cost as OpenClaw computed it, when its catalog had a price. */
  costUsd: number;
}

/** Which session this run is in, as far as argv says. Used to pick the right transcript. */
export interface SessionSelector {
  sessionId?: string;
  agentId?: string;
}

export function sessionSelector(argv: string[]): SessionSelector {
  return { sessionId: optionValue(argv, "--session-id"), agentId: optionValue(argv, "--agent") };
}

/** A leading `~` means the home directory, the way OpenClaw reads its own paths. */
function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/")) return path.join(os.homedir(), value.slice(1));
  return value;
}

/**
 * Where OpenClaw keeps its state, resolved the way OpenClaw resolves it:
 * OPENCLAW_STATE_DIR (a `~` expands, a relative path is relative to the
 * agent's cwd), else `.openclaw-dev` for --dev or `.openclaw-<profile>` for
 * --profile, else `.openclaw`, under OPENCLAW_HOME when set and the home
 * directory otherwise.
 */
export function openClawStateDir(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return path.resolve(cwd, expandHome(override));
  const homeOverride = env.OPENCLAW_HOME?.trim();
  const home = homeOverride ? path.resolve(cwd, expandHome(homeOverride)) : os.homedir();
  if (argv.includes("--dev")) return path.join(home, ".openclaw-dev");
  const profile = optionValue(argv, "--profile");
  return path.join(home, profile ? `.openclaw-${profile}` : ".openclaw");
}

export interface OpenClawMeterOptions {
  stateDir: string;
  selector: SessionSelector;
  startedAt: number;
  /** 0 disables the timer; sync() can still be called by hand. */
  pollMs: number;
}

interface StoreEntry {
  key: string;
  sessionId?: string;
  sessionFile?: string;
  startedAt?: number;
  updatedAt?: number;
}

export class OpenClawMeter implements Meter {
  readonly totals = emptyUsage();
  private buffer = "";
  private perMessage = new Map<string, MessageUsage>();
  private warnedModels = new Set<string>();
  private transcript: string | null = null;
  private tailed: StoreEntry | null = null;
  private transcriptOffset = 0;
  private transcriptRest = "";
  private lastStoreLookup = 0;
  private timer: NodeJS.Timeout | null = null;
  private resultSeen = false;
  private envelopeSessionId: string | undefined;
  private readFailed = false;
  private readonly opts: OpenClawMeterOptions;

  constructor(
    private readonly hooks: MeterHooks = {},
    opts: Partial<OpenClawMeterOptions> = {},
  ) {
    this.opts = { stateDir: openClawStateDir([]), selector: {}, startedAt: Date.now(), pollMs: DEFAULT_POLL_MS, ...opts };
    if (this.opts.pollMs > 0) {
      // sync() guards itself; the outer guard is for a hook that throws, which must not take the timer down with it.
      this.timer = setInterval(() => {
        try {
          this.sync();
        } catch {
          // Reported by the next poll that manages to run.
        }
      }, this.opts.pollMs);
      this.timer.unref();
    }
  }

  feed(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    this.drain();
  }

  /** The stream ended: stop polling, read the transcript one last time, flush stragglers. */
  end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drain();
    const rest = this.buffer.trim();
    this.buffer = "";
    for (const line of rest.split("\n")) if (line.trim()) this.hooks.onText?.(line + "\n");
    this.sync(true);
    if (!this.transcript) {
      this.hooks.onNote?.(`openclaw transcript never located under ${this.opts.stateDir}; usage came from the final envelope only`);
    }
  }

  /**
   * Read whatever the transcript has gained since last time. Never throws:
   * the timer and end() both call it, and an unreadable transcript is a
   * note in the report, not a supervisor with no report. Public so a test
   * can drive it without a timer; the guard tick reads `totals` after.
   */
  sync(force = false): void {
    try {
      this.tail(force);
    } catch (err) {
      this.readFailure(err);
    }
  }

  private tail(force: boolean): void {
    if (!this.transcript) this.locate(force);
    if (!this.transcript) return;
    const size = fs.statSync(this.transcript).size;
    if (size <= this.transcriptOffset) return;
    const chunk = Buffer.alloc(Math.min(size - this.transcriptOffset, MAX_READ_BYTES));
    const fd = fs.openSync(this.transcript, "r");
    let read: number;
    try {
      read = fs.readSync(fd, chunk, 0, chunk.length, this.transcriptOffset);
    } finally {
      fs.closeSync(fd);
    }
    this.transcriptOffset += read;
    this.transcriptRest += chunk.subarray(0, read).toString("utf8");
    let newline = this.transcriptRest.indexOf("\n");
    while (newline !== -1) {
      const line = this.transcriptRest.slice(0, newline).trim();
      this.transcriptRest = this.transcriptRest.slice(newline + 1);
      if (line) this.transcriptLine(line);
      newline = this.transcriptRest.indexOf("\n");
    }
  }

  /** A transcript that is not there yet is normal; anything else is said once. */
  private readFailure(err: unknown): void {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || this.readFailed) return;
    this.readFailed = true;
    this.hooks.onNote?.(`openclaw transcript ${this.transcript} could not be read (${code ?? String(err)}); the live count stopped there and the final envelope is the total`);
  }

  /**
   * The session store maps keys to transcript files and is written when the
   * run starts. The only entry that will do is the one carrying the session
   * id the envelope named, or else the id argv passed (the key ends in
   * `:explicit:<id>`, or the entry's sessionId is the id). With neither
   * there is nothing to match on and the tailer stays out; time is not a
   * criterion, because a chat turn can start in the same second as ours.
   */
  private locate(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastStoreLookup < STORE_LOOKUP_GAP_MS) return;
    this.lastStoreLookup = now;
    const explicit = this.opts.selector.sessionId;
    if (!this.envelopeSessionId && explicit === undefined) return;
    const candidates: StoreEntry[] = [];
    for (const store of this.storeFiles()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(store);
      } catch {
        continue;
      }
      if (stat.mtimeMs < this.opts.startedAt - START_SLACK_MS) continue;
      candidates.push(...readStore(store).filter((entry) => this.matches(entry)));
    }
    // The same explicit id can exist under two agents; the one being written now is the one to read.
    candidates.sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
    const best = candidates[0];
    if (best?.sessionFile) this.adopt(best, best.sessionFile);
  }

  private storeFiles(): string[] {
    const agentsDir = path.join(this.opts.stateDir, "agents");
    let agents: string[];
    try {
      agents = fs.readdirSync(agentsDir);
    } catch {
      return [];
    }
    return agents.map((agent) => path.join(agentsDir, agent, "sessions", "sessions.json"));
  }

  private matches(entry: StoreEntry): boolean {
    if (!entry.sessionFile) return false;
    // The envelope names the real session id; after that, nothing else will do.
    if (this.envelopeSessionId) return entry.sessionId === this.envelopeSessionId;
    const { sessionId, agentId } = this.opts.selector;
    if (sessionId === undefined) return false;
    // The same explicit id under another agent is another session.
    if (agentId && !entry.key.startsWith(`agent:${agentId}:`)) return false;
    return entry.key.endsWith(`:explicit:${sessionId}`) || entry.sessionId === sessionId;
  }

  /**
   * Start tailing this entry. A session that existed before the run (the
   * store says so, or the file's first line does; the store's startedAt is
   * refreshed on reuse, so both are checked) is read from where it stands
   * now, so its history is not billed to this run.
   */
  private adopt(entry: StoreEntry, file: string): void {
    this.tailed = entry;
    this.transcript = file;
    if (entry.sessionId && !this.totals.sessionId) this.totals.sessionId = entry.sessionId;
    const cutoff = this.opts.startedAt - START_SLACK_MS;
    const storeSaysOlder = entry.startedAt !== undefined && entry.startedAt < cutoff;
    const fileSaysOlder = (firstLineTimestamp(file) ?? Number.POSITIVE_INFINITY) < cutoff;
    if (!storeSaysOlder && !fileSaysOlder) return;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Not there yet; nothing to skip.
    }
    this.transcriptOffset = size;
    this.hooks.onNote?.(`openclaw session ${entry.sessionId ?? entry.key} existed before this run; only what it appended after ${new Date(this.opts.startedAt).toISOString()} is counted`);
  }

  /**
   * The envelope named a session other than the one being tailed. Nothing
   * read so far was this run's: drop it all, then find the right transcript.
   */
  private discardTailer(named: string): void {
    const t = this.totals;
    this.hooks.onNote?.(`the envelope names session ${named} but the transcript tailed was session ${this.tailed?.sessionId}; its ${fmtCount(t.totalTokens)} tokens, tool calls and commands were discarded`);
    t.inputTokens = 0;
    t.outputTokens = 0;
    t.cacheReadTokens = 0;
    t.cacheWriteTokens = 0;
    t.totalTokens = 0;
    t.estimatedUsd = 0;
    t.actualUsd = undefined;
    t.priceSource = "none";
    t.models = {};
    t.messages = 0;
    t.toolCalls = {};
    t.filesWritten = [];
    t.commands = [];
    this.perMessage.clear();
    this.transcript = null;
    this.tailed = null;
    this.transcriptOffset = 0;
    this.transcriptRest = "";
    this.lastStoreLookup = 0;
  }

  private transcriptLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type !== "message") return;
    // A message from before the run is a reused session's history, not this run's spend.
    const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
    if (Number.isFinite(at) && at < this.opts.startedAt - START_SLACK_MS) return;
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") return;
    this.hooks.onEvent?.(line);
    const model = typeof message.model === "string" ? message.model : (this.totals.model ?? "unknown");
    if (!this.totals.model) this.totals.model = model;
    // Once the envelope has given the whole turn, a message read late is already in it: record what it did, not what it cost.
    if (!this.resultSeen) {
      const id = typeof event.id === "string" ? event.id : `anon-${this.perMessage.size}`;
      const next = usageOf(model, message.usage);
      const prev = this.perMessage.get(id);
      this.perMessage.set(id, next);
      if (!prev) this.totals.messages += 1;
      this.applyDelta(prev, next);
    }
    this.content(message.content);
  }

  private applyDelta(prev: MessageUsage | undefined, next: MessageUsage): void {
    const t = this.totals;
    t.inputTokens += next.input - (prev?.input ?? 0);
    t.outputTokens += next.output - (prev?.output ?? 0);
    t.cacheReadTokens += next.cacheRead - (prev?.cacheRead ?? 0);
    t.cacheWriteTokens += next.cacheWrite - (prev?.cacheWrite ?? 0);
    t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    t.models[next.model] = (t.models[next.model] ?? 0) + (next.input + next.output - (prev ? prev.input + prev.output : 0));
    this.price(prev, next);
  }

  /**
   * A cost OpenClaw computed itself is the bill (priceSource "reported").
   * A zero with tokens behind it means its catalog had no price, not that
   * the tokens were free, so it does not count as a report. Everything else
   * is estimated: list prices for a Claude id, the ceiling for anything else.
   */
  private price(prev: MessageUsage | undefined, next: MessageUsage): void {
    const t = this.totals;
    if (!priceFor(next.model) && !this.warnedModels.has(next.model)) {
      this.warnedModels.add(next.model);
      this.hooks.onUnpricedModel?.(next.model);
    }
    const nextCost = costOf(next, CEILING_PRICE) ?? 0;
    const prevCost = prev ? (costOf(prev, CEILING_PRICE) ?? 0) : 0;
    t.estimatedUsd += nextCost - prevCost;
    const reported = next.costUsd - (prev?.costUsd ?? 0);
    if (reported > 0) {
      t.actualUsd = (t.actualUsd ?? 0) + reported;
      t.priceSource = "reported";
    } else if (t.priceSource === "none") {
      t.priceSource = priceFor(next.model) ? "list" : "ceiling";
    }
  }

  private content(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "toolCall") this.toolCall(block);
    }
  }

  private toolCall(block: Record<string, unknown>): void {
    const name = typeof block.name === "string" ? block.name : "unknown";
    this.totals.toolCalls[name] = (this.totals.toolCalls[name] ?? 0) + 1;
    const args = (block.arguments ?? {}) as Record<string, unknown>;
    if ((name === "write" || name === "edit") && typeof args.path === "string" && !this.totals.filesWritten.includes(args.path)) {
      this.totals.filesWritten.push(args.path);
    }
    if (name === "exec" && typeof args.command === "string" && this.totals.commands.length < MAX_COMMANDS_KEPT) {
      this.totals.commands.push(redact(args.command));
    }
    const detail = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : "";
    const oneLine = detail.replace(/\s+/g, " ").trim();
    this.hooks.onText?.(`  ⚙ ${redact(oneLine ? `${name}: ${oneLine.slice(0, 100)}` : name)}\n`);
  }

  /**
   * stdout is a pretty-printed object, so the unit is a balanced brace pair,
   * not a line. Lines outside an object (log noise) are passed through as text.
   */
  private drain(): void {
    for (;;) {
      this.buffer = this.buffer.replace(/^\s+/, "");
      if (!this.buffer) return;
      if (!this.buffer.startsWith("{")) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) return;
        this.hooks.onText?.(this.buffer.slice(0, newline) + "\n");
        this.buffer = this.buffer.slice(newline + 1);
        continue;
      }
      const close = closingBrace(this.buffer);
      if (close === -1) return;
      const candidate = this.buffer.slice(0, close + 1);
      this.buffer = this.buffer.slice(close + 1);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(candidate) as Record<string, unknown>;
      } catch {
        const newline = candidate.indexOf("\n");
        const first = newline === -1 ? candidate : candidate.slice(0, newline);
        this.hooks.onText?.(first + "\n");
        this.buffer = candidate.slice(first.length + 1) + this.buffer;
        continue;
      }
      this.hooks.onEvent?.(JSON.stringify(event));
      this.result(event);
    }
  }

  /**
   * The envelope is `{runId, status, summary, result: {payloads, meta}}`
   * through the gateway and bare `{payloads, meta}` with --local. Either
   * way the numbers live in meta.agentMeta.
   */
  private result(event: Record<string, unknown>): void {
    const t = this.totals;
    const inner = (isObject(event.result) ? event.result : event) as Record<string, unknown>;
    const meta = (isObject(inner.meta) ? inner.meta : {}) as Record<string, unknown>;
    const agentMeta = (isObject(meta.agentMeta) ? meta.agentMeta : {}) as Record<string, unknown>;
    const status = typeof event.status === "string" ? event.status : undefined;
    if (typeof agentMeta.model === "string") t.model = agentMeta.model;
    if (typeof agentMeta.sessionId === "string") this.adoptSessionId(agentMeta.sessionId);
    // The gateway says "completed"; an embedded run only has the model's stop reason.
    const stopReason = meta.stopReason === "stop" ? "completed" : meta.stopReason;
    if (typeof stopReason === "string") t.terminalReason = stopReason;
    if (typeof event.summary === "string") t.terminalReason = event.summary;
    const failed = status === "error" || isObject(meta.error) || typeof event.error === "string";
    t.isError = failed;
    if (!this.resultSeen) t.turns += 1;
    this.resultSeen = true;
    if (isObject(agentMeta.usage)) this.reconcile(usageOf(t.model ?? "unknown", agentMeta.usage));
    this.render(inner, meta, event, agentMeta);
  }

  /** The envelope's session id is authoritative; a tailer on any other session was reading someone else's turn. */
  private adoptSessionId(sessionId: string): void {
    this.envelopeSessionId = sessionId;
    this.totals.sessionId = sessionId;
    if (this.tailed?.sessionId && this.tailed.sessionId !== sessionId) this.discardTailer(sessionId);
  }

  /**
   * The envelope's usage is the whole turn and a floor under the count. If
   * the tailer saw less (or nothing, because the transcript was not found),
   * the envelope replaces the count, as one message when there were none;
   * if the tailer saw it all, nothing changes. Per-message state is kept so
   * a message read after this point is still recognised as already counted.
   */
  private reconcile(final: MessageUsage): void {
    const seen = this.totals.inputTokens + this.totals.outputTokens + this.totals.cacheReadTokens + this.totals.cacheWriteTokens;
    const finalTotal = final.input + final.output + final.cacheRead + final.cacheWrite;
    if (finalTotal <= seen) return;
    const t = this.totals;
    const combined: MessageUsage = {
      model: final.model,
      input: t.inputTokens,
      output: t.outputTokens,
      cacheRead: t.cacheReadTokens,
      cacheWrite: t.cacheWriteTokens,
      costUsd: t.actualUsd ?? 0,
    };
    if (t.messages === 0) t.messages = 1;
    // Replace the counted whole with the reported whole; the delta keeps the estimate consistent.
    t.models = {};
    t.models[final.model] = final.input + final.output;
    t.inputTokens = final.input;
    t.outputTokens = final.output;
    t.cacheReadTokens = final.cacheRead;
    t.cacheWriteTokens = final.cacheWrite;
    t.totalTokens = finalTotal;
    this.price(combined, final);
  }

  private render(inner: Record<string, unknown>, meta: Record<string, unknown>, event: Record<string, unknown>, agentMeta: Record<string, unknown>): void {
    if (!this.hooks.onText) return;
    const payloads = Array.isArray(inner.payloads) ? (inner.payloads as Array<Record<string, unknown>>) : [];
    for (const payload of payloads) {
      if (typeof payload.text === "string" && payload.text.trim()) this.hooks.onText(payload.text.trimEnd() + "\n");
      if (typeof payload.mediaUrl === "string") this.hooks.onText(`MEDIA: ${payload.mediaUrl}\n`);
    }
    if (typeof event.error === "string") this.hooks.onText(`openclaw error: ${redact(event.error)}\n`);
    const t = this.totals;
    const duration = typeof meta.durationMs === "number" ? ` in ${fmtDuration(meta.durationMs)}` : "";
    const provider = typeof agentMeta.provider === "string" ? ` via ${agentMeta.provider}` : "";
    const model = t.model ? ` on ${t.model}${provider}` : "";
    this.hooks.onText(`openclaw: ${t.terminalReason ?? "done"}${duration} · ${fmtCount(t.totalTokens)} tokens${model}\n`);
  }
}

/** Both the transcript and the envelope use {input, output, cacheRead, cacheWrite}; only the transcript has cost. */
function usageOf(model: string, raw: unknown): MessageUsage {
  const usage = (isObject(raw) ? raw : {}) as Record<string, unknown>;
  const cost = usage.cost;
  const costUsd = typeof cost === "number" ? cost : isObject(cost) ? num((cost as Record<string, unknown>).total) : num(usage.costUsd);
  return {
    model,
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    costUsd: Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0,
  };
}

/** When the transcript began, from the `timestamp` of its first line; undefined when it cannot be read or has none. */
function firstLineTimestamp(file: string): number | undefined {
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const chunk = Buffer.alloc(HEADER_BYTES);
      const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
      head = chunk.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const newline = head.indexOf("\n");
  if (newline === -1) return undefined;
  try {
    const first = JSON.parse(head.slice(0, newline)) as Record<string, unknown>;
    const at = typeof first.timestamp === "string" ? Date.parse(first.timestamp) : Number.NaN;
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

function readStore(file: string): StoreEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const entries: StoreEntry[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isObject(value)) continue;
    const entry = value as Record<string, unknown>;
    entries.push({
      key,
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
      sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : undefined,
      startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
    });
  }
  return entries;
}

/** Index of the brace that closes the object starting at text[0], or -1 if it is not complete yet. */
export function closingBrace(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const openclawAdapter: Adapter = {
  name: "openclaw",
  matches: isOpenClawCommand,
  instrument: instrumentOpenClawArgv,
  createMeter: (hooks, context) => {
    const argv = context?.argv ?? [];
    const cwd = context?.cwd ?? process.cwd();
    return new OpenClawMeter(hooks, { stateDir: openClawStateDir(argv, process.env, cwd), selector: sessionSelector(argv), startedAt: Date.now() });
  },
};
