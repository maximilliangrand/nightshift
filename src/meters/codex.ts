/**
 * Reads the JSON Lines that `codex exec --json` prints on stdout and keeps a
 * running total of tokens and dollars.
 *
 * Built from the format's sources, not from a live run: the event and item
 * types in codex-rs/exec/src/exec_events.rs, the processor that emits them in
 * codex-rs/exec/src/event_processor_with_jsonl_output.rs, the sample stream
 * in the Codex non-interactive docs (developers.openai.com/codex/noninteractive)
 * and `codex exec --help` of codex-cli 0.152.1. Four facts from those sources
 * shape this meter:
 *
 * 1. `turn.completed.usage` is the thread's running total, not the turn's
 *    increment (usage_from_last_total() reads `usage.total`). The latest
 *    figure therefore replaces the previous one; a repeated event costs
 *    nothing twice. One `codex exec` is one turn, so it is also the run's total.
 *
 * 2. `cached_input_tokens` and `cache_write_input_tokens` are parts of
 *    `input_tokens` (Responses API input_tokens_details), unlike Claude's
 *    separate cache counters. The report's "in" is the uncached remainder.
 *
 * 3. The stream never names the model. It is taken from argv (-m, --model,
 *    -c model=...), then from $CODEX_HOME/config.toml, then assumed to be
 *    codex's built-in default, with a note in the report saying so.
 *
 * 4. Codex reports no dollars and has no spend limit flag, so the estimate
 *    from list prices is the only figure and nightshift is the only line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../redact.js";
import { basename, emptyUsage, forcedInstrumentation, type Adapter, type Instrumentation, type Meter, type MeterHooks } from "./adapter.js";
import { priceOverrides, type Price } from "./claude.js";
import { JsonlStream } from "./jsonl.js";

/**
 * List prices, USD per million tokens, Standard tier, short context, read
 * from developers.openai.com/api/docs/pricing on 2026-09-02. A model with no
 * cached-input discount on that page is charged the input rate for cached
 * tokens; a model with no cache-write column is charged the input rate for
 * writes. Snapshot ids (gpt-5.4-2026-03-05) fall back to their family row,
 * and older Codex names with no row of their own (gpt-5.2-codex, gpt-5-codex)
 * fall back to the family they were priced with. Override with
 * NIGHTSHIFT_PRICES='{"gpt-5.6-sol":{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5}}'.
 */
export const CODEX_PRICES: Record<string, Price> = {
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "gpt-5.6-cyber": { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
  "gpt-daybreak-blue-latest": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "gpt-daybreak-red-latest": { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  "gpt-5.5-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  "gpt-5.4-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  "gpt-5.2-pro": { input: 21, output: 168, cacheRead: 21, cacheWrite: 21 },
  "gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  "gpt-5-pro": { input: 15, output: 120, cacheRead: 15, cacheWrite: 15 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  o3: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "o3-pro": { input: 20, output: 80, cacheRead: 20, cacheWrite: 20 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
};

/** Used for a model we have no row for, so a budget is never blind: the most expensive row. */
export const CODEX_CEILING_PRICE: Price = { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 };

/**
 * What codex-cli 0.152.1 picks when no model is configured: the first
 * picker-visible preset by priority in codex-rs/models-manager/models.json.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

/** "gpt-5.4-2026-03-05" and "custom/gpt-5.3-codex" → their family row; longest prefix wins. */
export function codexPriceFor(model: string): Price | null {
  const table = { ...CODEX_PRICES, ...priceOverrides() };
  const canonical = (model.split("/").pop() ?? model).replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (table[canonical]) return table[canonical] ?? null;
  const candidates = Object.keys(table)
    .filter((key) => canonical.startsWith(key))
    .sort((a, b) => b.length - a.length);
  const best = candidates[0];
  return best ? (table[best] ?? null) : null;
}

/** The thread total as codex reports it, split the way the report shows it. */
interface CodexUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function codexCostOf(model: string, usage: CodexUsage, fallback: Price | null = null): number | null {
  const price = codexPriceFor(model) ?? fallback;
  if (!price) return null;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/** Reads the usage object of a turn.completed event into report terms. */
export function splitCodexUsage(raw: Record<string, unknown>): CodexUsage {
  const cacheRead = num(raw.cached_input_tokens);
  const cacheWrite = num(raw.cache_write_input_tokens);
  return {
    input: Math.max(0, num(raw.input_tokens) - cacheRead - cacheWrite),
    output: num(raw.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

const MAX_COMMANDS_KEPT = 200;
const MAX_REASON_CHARS = 200;

export class CodexStreamMeter implements Meter {
  readonly totals = emptyUsage();
  private readonly stream = new JsonlStream((line) => this.line(line));
  private lastUsage: CodexUsage | null = null;
  private seenItemIds = new Set<string>();
  private warnedModel = false;

  constructor(
    private readonly hooks: MeterHooks = {},
    model: string = CODEX_DEFAULT_MODEL,
  ) {
    this.totals.model = model;
  }

  feed(chunk: Buffer | string): void {
    this.stream.feed(chunk);
  }

  end(): void {
    this.stream.end();
  }

  private line(line: string): void {
    if (!line.startsWith("{")) {
      this.hooks.onText?.(line + "\n");
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.hooks.onText?.(line + "\n");
      return;
    }
    this.hooks.onEvent?.(line);
    this.event(event);
  }

  private event(event: Record<string, unknown>): void {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.totals.sessionId = event.thread_id;
        return;
      case "turn.completed":
        this.usage(event.usage);
        return;
      case "turn.failed":
        this.failure((event.error as Record<string, unknown> | undefined)?.message);
        return;
      case "error":
        this.failure(event.message);
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.item(event.item as Record<string, unknown> | undefined, event.type === "item.completed");
        return;
      default:
        return;
    }
  }

  private usage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const next = splitCodexUsage(raw as Record<string, unknown>);
    const prev = this.lastUsage;
    // A repeat of the same running total is the same turn, not a new one.
    if (prev && sameUsage(prev, next)) return;
    this.lastUsage = next;
    this.totals.turns += 1;
    const model = this.totals.model ?? CODEX_DEFAULT_MODEL;
    const t = this.totals;
    t.inputTokens += next.input - (prev?.input ?? 0);
    t.outputTokens += next.output - (prev?.output ?? 0);
    t.cacheReadTokens += next.cacheRead - (prev?.cacheRead ?? 0);
    t.cacheWriteTokens += next.cacheWrite - (prev?.cacheWrite ?? 0);
    t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    t.models[model] = (t.models[model] ?? 0) + (next.input + next.output - (prev ? prev.input + prev.output : 0));

    if (!codexPriceFor(model) && !this.warnedModel) {
      this.warnedModel = true;
      this.hooks.onUnpricedModel?.(model);
    }
    // An unknown model is priced at the ceiling rather than at zero, so a
    // budget still fires; the report says the estimate was a ceiling.
    const nextCost = codexCostOf(model, next, CODEX_CEILING_PRICE) ?? 0;
    const prevCost = prev ? (codexCostOf(model, prev, CODEX_CEILING_PRICE) ?? 0) : 0;
    t.estimatedUsd += nextCost - prevCost;
    if (t.priceSource === "none") t.priceSource = codexPriceFor(model) ? "list" : "ceiling";
  }

  private failure(message: unknown): void {
    const text = typeof message === "string" ? message : "turn failed";
    this.totals.isError = true;
    this.totals.terminalReason = redact(text.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS));
    this.hooks.onText?.(`  ✗ codex: ${redact(text)}\n`);
  }

  /**
   * An item arrives up to three times (started, updated, completed) under one
   * id; it is counted and rendered on first sight. Agent messages only ever
   * arrive completed, which is when their text is final.
   */
  private item(item: Record<string, unknown> | undefined, completed: boolean): void {
    if (!item) return;
    const id = typeof item.id === "string" ? item.id : `anon-${this.seenItemIds.size}`;
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "file_change") this.recordFiles(item.changes);
    if (type === "agent_message" && !completed) return;
    if (this.seenItemIds.has(id)) return;
    this.seenItemIds.add(id);
    if (type === "agent_message") {
      if (typeof item.text !== "string") return;
      this.totals.messages += 1;
      this.hooks.onText?.(item.text.endsWith("\n") ? item.text : item.text + "\n");
      return;
    }
    if (type === "error") {
      if (typeof item.message === "string") this.hooks.onText?.(`  ⚠ codex: ${redact(item.message)}\n`);
      return;
    }
    const summary = this.toolCall(type, item);
    if (summary) this.hooks.onText?.(`  ⚙ ${redact(summary)}\n`);
  }

  /** Counts a tool-shaped item under a stable key and returns its one-line summary. */
  private toolCall(type: string, item: Record<string, unknown>): string | null {
    switch (type) {
      case "command_execution": {
        this.count("command");
        const command = typeof item.command === "string" ? item.command : "";
        if (command && this.totals.commands.length < MAX_COMMANDS_KEPT) this.totals.commands.push(redact(command));
        return `command: ${oneLine(command)}`;
      }
      case "file_change": {
        this.count("file_change");
        const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
        const described = changes.map((c) => `${typeof c.kind === "string" ? c.kind : "change"} ${typeof c.path === "string" ? c.path : "?"}`);
        return `file_change: ${oneLine(described.join(", "))}`;
      }
      case "mcp_tool_call": {
        const name = `mcp:${typeof item.server === "string" ? item.server : "?"}/${typeof item.tool === "string" ? item.tool : "?"}`;
        this.count(name);
        return name;
      }
      case "web_search":
        this.count("web_search");
        return `web_search: ${oneLine(typeof item.query === "string" ? item.query : "")}`;
      default:
        return null;
    }
  }

  private count(key: string): void {
    this.totals.toolCalls[key] = (this.totals.toolCalls[key] ?? 0) + 1;
  }

  private recordFiles(changes: unknown): void {
    if (!Array.isArray(changes)) return;
    for (const change of changes as Array<Record<string, unknown>>) {
      if (typeof change.path !== "string" || change.kind === "delete") continue;
      if (!this.totals.filesWritten.includes(change.path)) this.totals.filesWritten.push(change.path);
    }
  }
}

function sameUsage(a: CodexUsage, b: CodexUsage): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

function oneLine(value: string, max = 100): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Is this argv a Codex CLI invocation? */
export function isCodexCommand(argv: string[]): boolean {
  const base = basename(argv);
  return base === "codex" || base === "codex.js";
}

/** Global options of `codex` that take a value, so their value is not mistaken for the subcommand. */
const VALUED_OPTIONS = new Set([
  "-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-i", "--image",
  "-a", "--ask-for-approval", "--enable", "--disable", "--local-provider", "--remote", "--remote-auth-token-env", "--thread-source",
]);

/** Index of the subcommand token (`exec`, `review`, ...) or -1 for an interactive prompt or none. */
function subcommandIndex(argv: string[]): number {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("-")) {
      if (VALUED_OPTIONS.has(arg)) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/** `-m x`, `--model x`, `--model=x`, `-c model="x"` or `--config model=x`, anywhere in argv. */
export function modelFromArgv(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if ((arg === "-m" || arg === "--model") && next) return next;
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
    const override = arg === "-c" || arg === "--config" ? next : arg.startsWith("--config=") ? arg.slice("--config=".length) : undefined;
    const match = override?.match(/^model\s*=\s*["']?([^"']+)["']?$/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** The top-level `model = "..."` of $CODEX_HOME/config.toml, ignoring profile tables below it. */
export function modelFromConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model\s*=\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Make a `codex exec` invocation observable. If --json is absent, add it right
 * after the subcommand (so `exec resume` and `exec review` get it too) and
 * render the stream back to readable text; if it is present, leave stdout
 * alone and listen. Interactive codex has no machine output and runs
 * unmetered, saying so. Codex has no spend limit flag, so a dollar budget is
 * not passed down: nightshift is the only line.
 */
export function instrumentCodexArgv(argv: string[], opts: { budgetUsd?: number; forced?: boolean }): Instrumentation {
  if (opts.forced && !isCodexCommand(argv)) {
    assumedModel = CODEX_DEFAULT_MODEL;
    const inst = forcedInstrumentation(argv, "codex");
    inst.notes.push(modelNote(CODEX_DEFAULT_MODEL));
    return inst;
  }
  const notes: string[] = [];
  const args = [...argv];
  const subAt = subcommandIndex(args);
  const sub = subAt === -1 ? null : args[subAt];
  const isExec = sub === "exec" || sub === "e";

  let renders = false;
  let metered = false;
  if (!isExec) {
    notes.push("interactive codex session: usage is not metered (use `codex exec` for unattended runs)");
  } else if (!args.includes("--json")) {
    args.splice(subAt + 1, 0, "--json");
    renders = true;
    metered = true;
  } else {
    metered = true;
  }

  if (metered) {
    const argvModel = modelFromArgv(args);
    const model = argvModel ?? modelFromConfig() ?? CODEX_DEFAULT_MODEL;
    assumedModel = model;
    if (!argvModel) notes.push(modelNote(model));
    if (opts.budgetUsd !== undefined) notes.push("codex has no spend limit flag of its own; the budget is enforced by nightshift alone");
  }
  return { argv: args, renders, metered, notes };
}

function modelNote(model: string): string {
  return `codex does not name its model in the --json stream; spend is priced as ${model} (pass -m to be exact)`;
}

/** Set by instrument(), read by createMeter(): the stream itself never says which model it is. */
let assumedModel: string = CODEX_DEFAULT_MODEL;

export const codexAdapter: Adapter = {
  name: "codex",
  matches: isCodexCommand,
  instrument: instrumentCodexArgv,
  createMeter: (hooks) => new CodexStreamMeter(hooks, assumedModel),
};
