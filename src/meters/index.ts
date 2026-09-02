/**
 * The adapter registry. `--adapter auto` picks the first adapter whose
 * matches() says yes; a name picks that one and forces it.
 */
import { claudeAdapter } from "./claude.js";
import type { Adapter } from "./adapter.js";

export const ADAPTERS: Adapter[] = [claudeAdapter];

export const ADAPTER_NAMES = ["auto", "none", ...ADAPTERS.map((a) => a.name)] as const;
export type AdapterChoice = (typeof ADAPTER_NAMES)[number];

/** null: run unmetered. */
export function resolveAdapter(choice: string, argv: string[]): { adapter: Adapter; forced: boolean } | null {
  if (choice === "none") return null;
  if (choice === "auto") {
    const adapter = ADAPTERS.find((a) => a.matches(argv));
    return adapter ? { adapter, forced: false } : null;
  }
  const adapter = ADAPTERS.find((a) => a.name === choice);
  if (!adapter) throw new Error(`unknown adapter "${choice}"`);
  return { adapter, forced: !adapter.matches(argv) };
}

export type { Adapter, Meter, MeterHooks, Instrumentation, UsageTotals } from "./adapter.js";
export { emptyUsage } from "./adapter.js";
