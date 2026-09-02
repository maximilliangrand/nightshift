/**
 * An adapter knows one agent CLI: how to recognise it, how to switch on its
 * machine-readable output without changing what it does, and how to turn
 * that output into tokens, dollars and a record of what it touched.
 *
 * The supervisor does not care which one is in use. It feeds every stdout
 * chunk to the meter and reads `totals` when a guard asks.
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  actualUsd?: number;
  model?: string;
  models: Record<string, number>;
  sessionId?: string;
  messages: number;
  turns: number;
  toolCalls: Record<string, number>;
  filesWritten: string[];
  commands: string[];
  rateLimits?: { fiveHour?: number; sevenDay?: number };
  terminalReason?: string;
  isError?: boolean;
  priceSource: "none" | "list" | "ceiling" | "reported";
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    models: {},
    messages: 0,
    turns: 0,
    toolCalls: {},
    filesWritten: [],
    commands: [],
    priceSource: "none",
  };
}

export interface MeterHooks {
  /** Readable text to show and log, when nightshift renders the stream itself. */
  onText?: (text: string) => void;
  /** Every parsed event line, for events.jsonl. */
  onEvent?: (line: string) => void;
  /** A model with no price row. Fired once per model. */
  onUnpricedModel?: (model: string) => void;
  /** Something the report should say about how the numbers were gathered. */
  onNote?: (note: string) => void;
}

export interface Meter {
  readonly totals: UsageTotals;
  feed(chunk: Buffer | string): void;
  /** The stream ended; flush whatever is buffered. */
  end(): void;
}

export interface Instrumentation {
  argv: string[];
  /** nightshift switched on machine output and will render it back as text. */
  renders: boolean;
  /** the meter can read usage from stdout. */
  metered: boolean;
  notes: string[];
}

/** What the meter may know about the run beyond its stdout. */
export interface MeterContext {
  /** The argv actually spawned, after instrument(). */
  argv: string[];
  /** The directory the agent runs in; relative paths the agent sees resolve against it. */
  cwd: string;
}

export interface InstrumentOptions {
  budgetUsd?: number;
  /** The caller asserts the command speaks this adapter's format even if it does not look like it. */
  forced?: boolean;
  /** The nightshift run id, for adapters that can tag the agent's own state with it. */
  runId?: string;
}

export interface Adapter {
  /** Name used by --adapter and in reports. */
  readonly name: string;
  /** Does this argv look like this agent? Used by --adapter auto. */
  matches(argv: string[]): boolean;
  /** Make the invocation observable without changing what it does. */
  instrument(argv: string[], opts: InstrumentOptions): Instrumentation;
  createMeter(hooks: MeterHooks, context?: MeterContext): Meter;
}

/** Any command whose stdout already speaks an adapter's format: touch nothing, meter everything. */
export function forcedInstrumentation(argv: string[], name: string): Instrumentation {
  return { argv: [...argv], renders: false, metered: true, notes: [`adapter forced to ${name}: expecting its stream on stdout`] };
}

export function basename(argv: string[]): string {
  return (argv[0] ?? "").split("/").pop() ?? "";
}
