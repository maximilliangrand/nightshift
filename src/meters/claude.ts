/**
 * Reads Claude Code's `--output-format stream-json` events off stdout and
 * keeps a running total of tokens and dollars.
 *
 * Two facts about the stream, both observed rather than assumed:
 *
 * 1. Every content block of one API response arrives as its own `assistant`
 *    event, and each carries the *same* `message.id` and the *same* usage.
 *    Summing naively double-counts. Usage is therefore keyed by message id
 *    and the latest value wins.
 *
 * 2. Dollars are only reported at the very end (`result.total_cost_usd`).
 *    A budget that only fires after the money is spent is not a budget, so
 *    spend is estimated live from tokens using list prices, then reconciled
 *    against the reported figure when the run ends. The report shows both.
 */
import { redact } from "../redact.js";
import { basename, emptyUsage, forcedInstrumentation, type Adapter, type Instrumentation, type Meter, type MeterHooks, type UsageTotals } from "./adapter.js";

export { emptyUsage, type UsageTotals };

export interface Price {
  /** USD per million tokens */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * List prices, USD per million tokens. Cache write is priced for the 1-hour
 * TTL Claude Code uses (2x input); cache read is 0.1x input. Override with
 * NIGHTSHIFT_PRICES='{"claude-opus-5":{"input":5,"output":25,...}}'.
 */
export const LIST_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
};

/** Used for a model we have no row for, so a budget is never blind: the most expensive row. */
export const CEILING_PRICE: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 };

function priceOverrides(): Record<string, Price> {
  const raw = process.env.NIGHTSHIFT_PRICES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Price>;
  } catch {
    return {};
  }
}

/** "claude-haiku-4-5-20251001" → the "claude-haiku-4-5" row; longest prefix wins. */
export function priceFor(model: string): Price | null {
  const table = { ...LIST_PRICES, ...priceOverrides() };
  const canonical = model.replace(/-\d{8}$/, "");
  if (table[canonical]) return table[canonical] ?? null;
  const candidates = Object.keys(table)
    .filter((key) => canonical.startsWith(key))
    .sort((a, b) => b.length - a.length);
  const best = candidates[0];
  return best ? (table[best] ?? null) : null;
}

interface MessageUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function costOf(usage: MessageUsage, fallback: Price | null = null): number | null {
  const price = priceFor(usage.model) ?? fallback;
  if (!price) return null;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export type ClaudeMeterHooks = MeterHooks;

const MAX_COMMANDS_KEPT = 200;

export class ClaudeStreamMeter implements Meter {
  readonly totals = emptyUsage();
  private buffer = "";
  private perMessage = new Map<string, MessageUsage>();
  private warnedModels = new Set<string>();
  private seenToolUseIds = new Set<string>();

  constructor(private readonly hooks: ClaudeMeterHooks = {}) {}

  feed(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
      newline = this.buffer.indexOf("\n");
    }
    // A complete event that never gets its newline must still count. If the
    // buffer looks like a whole object, take it now rather than at exit.
    const rest = this.buffer.trimEnd();
    if (rest.startsWith("{") && rest.endsWith("}")) {
      try {
        JSON.parse(rest);
      } catch {
        return;
      }
      this.buffer = "";
      this.line(rest);
    }
  }

  /** Flush a trailing line with no newline (a stream that ended mid-write). */
  end(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.line(rest);
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
    const type = event.type;
    if (type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") this.totals.model = event.model;
      if (typeof event.session_id === "string") this.totals.sessionId = event.session_id;
      return;
    }
    if (type === "assistant") {
      this.assistant(event.message as Record<string, unknown> | undefined);
      return;
    }
    if (type === "rate_limit_event") {
      this.rateLimit(event.rate_limit_info as Record<string, unknown> | undefined);
      return;
    }
    if (type === "result" || typeof event.total_cost_usd === "number") {
      this.result(event);
    }
  }

  private assistant(message: Record<string, unknown> | undefined): void {
    if (!message) return;
    const id = typeof message.id === "string" ? message.id : `anon-${this.perMessage.size}`;
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    const model = typeof message.model === "string" ? message.model : (this.totals.model ?? "unknown");
    const next: MessageUsage = {
      model,
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
    const prev = this.perMessage.get(id);
    this.perMessage.set(id, next);
    if (!prev) this.totals.messages += 1;
    this.applyDelta(prev, next);
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

    if (!priceFor(next.model) && !this.warnedModels.has(next.model)) {
      this.warnedModels.add(next.model);
      this.hooks.onUnpricedModel?.(next.model);
    }
    // An unknown model is priced at the ceiling rather than at zero, so a
    // budget still fires; the report says the estimate was a ceiling.
    const nextCost = costOf(next, CEILING_PRICE) ?? 0;
    const prevCost = prev ? (costOf(prev, CEILING_PRICE) ?? 0) : 0;
    t.estimatedUsd += nextCost - prevCost;
    if (t.priceSource === "none") t.priceSource = priceFor(next.model) ? "list" : "ceiling";
  }

  private content(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        this.hooks.onText?.(block.text.endsWith("\n") ? block.text : block.text + "\n");
      } else if (block.type === "tool_use") {
        this.toolUse(block);
      }
    }
  }

  private toolUse(block: Record<string, unknown>): void {
    const id = typeof block.id === "string" ? block.id : "";
    if (id && this.seenToolUseIds.has(id)) return;
    if (id) this.seenToolUseIds.add(id);
    const name = typeof block.name === "string" ? block.name : "unknown";
    this.totals.toolCalls[name] = (this.totals.toolCalls[name] ?? 0) + 1;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const filePath = input.file_path ?? input.notebook_path;
    if ((name === "Write" || name === "Edit" || name === "NotebookEdit") && typeof filePath === "string") {
      if (!this.totals.filesWritten.includes(filePath)) this.totals.filesWritten.push(filePath);
    }
    if (name === "Bash" && typeof input.command === "string" && this.totals.commands.length < MAX_COMMANDS_KEPT) {
      this.totals.commands.push(redact(input.command));
    }
    const summary = redact(summarizeToolUse(name, input));
    this.hooks.onText?.(`  ⚙ ${summary}\n`);
  }

  private rateLimit(info: Record<string, unknown> | undefined): void {
    const windows = info?.unifiedWindows as Record<string, { utilization?: number }> | undefined;
    if (!windows) return;
    this.totals.rateLimits = {
      fiveHour: windows.five_hour?.utilization,
      sevenDay: windows.seven_day?.utilization,
    };
  }

  private result(event: Record<string, unknown>): void {
    const t = this.totals;
    if (typeof event.total_cost_usd === "number") {
      t.actualUsd = event.total_cost_usd;
      t.priceSource = "reported";
    }
    if (typeof event.num_turns === "number") t.turns = event.num_turns;
    if (typeof event.terminal_reason === "string") t.terminalReason = event.terminal_reason;
    if (typeof event.is_error === "boolean") t.isError = event.is_error;
    if (typeof event.session_id === "string") t.sessionId = event.session_id;
    if (t.turns === 0) t.turns = t.messages;
  }
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const first = (key: string, max = 100): string => {
    const value = input[key];
    if (typeof value !== "string") return "";
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
  };
  switch (name) {
    case "Bash":
      return `Bash: ${first("command")}`;
    case "Read":
    case "Write":
    case "Edit":
      return `${name}: ${first("file_path")}`;
    case "Grep":
    case "Glob":
      return `${name}: ${first("pattern")}`;
    case "WebFetch":
      return `WebFetch: ${first("url")}`;
    case "WebSearch":
      return `WebSearch: ${first("query")}`;
    default:
      return name;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Is this argv a Claude Code invocation? */
export function isClaudeCommand(argv: string[]): boolean {
  const file = argv[0] ?? "";
  const base = basename(argv);
  return base === "claude" || base === "claude.js" || (base === "cli.js" && file.includes("claude"));
}

/**
 * Make a `claude -p` invocation observable. If the caller did not ask for an
 * output format, switch on stream-json (which needs --verbose) and render it
 * back to readable text ourselves. If they asked for stream-json, leave stdout
 * alone and just listen. If they asked for text or json, respect it and run
 * unmetered, saying so. A dollar budget is also passed to Claude Code's own
 * --max-budget-usd so the agent stops itself before the supervisor has to.
 */
export function instrumentClaudeArgv(argv: string[], opts: { budgetUsd?: number; forced?: boolean }): Instrumentation {
  const notes: string[] = [];
  const args = [...argv];
  const isPrint = args.includes("-p") || args.includes("--print");
  if (opts.forced && !isClaudeCommand(args)) return forcedInstrumentation(args, "claude");
  const formatIndex = args.findIndex((a) => a === "--output-format" || a.startsWith("--output-format="));
  const format =
    formatIndex === -1
      ? null
      : args[formatIndex]?.includes("=")
        ? args[formatIndex]?.split("=")[1]
        : args[formatIndex + 1];

  let renders = false;
  let metered = false;
  if (!isPrint) {
    notes.push("interactive claude session: usage is not metered (add -p for unattended runs)");
  } else if (format === null) {
    args.push("--output-format", "stream-json");
    if (!args.includes("--verbose")) args.push("--verbose");
    renders = true;
    metered = true;
  } else if (format === "stream-json") {
    if (!args.includes("--verbose")) args.push("--verbose");
    metered = true;
  } else {
    notes.push(`--output-format ${format} leaves usage unmetered; drop it to let nightshift meter the run`);
  }

  if (opts.budgetUsd !== undefined && isPrint && !args.some((a) => a.startsWith("--max-budget-usd"))) {
    args.push("--max-budget-usd", String(opts.budgetUsd));
    notes.push(`passed --max-budget-usd ${opts.budgetUsd} to claude as a first line of defence`);
  }
  return { argv: args, renders, metered, notes };
}

export const claudeAdapter: Adapter = {
  name: "claude",
  matches: isClaudeCommand,
  instrument: instrumentClaudeArgv,
  createMeter: (hooks) => new ClaudeStreamMeter(hooks),
};
