/**
 * The side-effect ledger. An agent that sends a message, places an order or
 * posts a comment claims a key here first. A claim is refused when the key was
 * already claimed in this scope (the same message must not go out twice) or
 * when the scope has hit its rate limit (a loop must not send 1,100 messages
 * overnight). Both refusals are recorded, so the report can say how many
 * times the ledger said no.
 *
 * Storage is one append-only JSONL file per scope, guarded by a lock file so
 * several agents on one machine share the same count. Nothing here needs a
 * database; a night of sends is a few kilobytes.
 */
import fs from "node:fs";
import path from "node:path";
import { ledgerDir, ensureDirs } from "./store.js";
import type { Rate } from "./units.js";
import { sleep } from "./supervisor.js";

export interface LedgerEntry {
  ts: string;
  key: string;
  ok: boolean;
  refusal?: "duplicate" | "capped";
  run?: string;
  meta?: Record<string, unknown>;
}

export type ClaimResult =
  | { ok: true; count: number }
  | { ok: false; reason: "duplicate"; firstClaimedAt: string; count: number }
  | { ok: false; reason: "capped"; count: number; limit: number; window: Rate["window"]; retryAfterMs: number };

const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

function scopeFile(scope: string): string {
  const safe = scope.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  if (!safe) throw new Error("Ledger scope must contain at least one letter or digit");
  return path.join(ledgerDir(), `${safe}.jsonl`);
}

export function readLedger(scope: string): LedgerEntry[] {
  try {
    return fs
      .readFileSync(scopeFile(scope), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  } catch {
    return [];
  }
}

async function withLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {
        // Lock vanished between stat and unlink; loop again.
      }
      if (Date.now() > deadline) throw new Error(`Ledger lock ${lock} held for over ${LOCK_TIMEOUT_MS / 1000}s`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}

export interface ClaimOptions {
  scope: string;
  key: string;
  limit?: Rate;
  run?: string;
  meta?: Record<string, unknown>;
  now?: number;
}

export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  ensureDirs();
  const file = scopeFile(opts.scope);
  const now = opts.now ?? Date.now();
  return withLock(file, () => {
    const entries = readLedger(opts.scope);
    const okEntries = entries.filter((e) => e.ok);
    const duplicate = okEntries.find((e) => e.key === opts.key);
    const base = { key: opts.key, run: opts.run, meta: opts.meta, ts: new Date(now).toISOString() };

    if (duplicate) {
      append(file, { ...base, ok: false, refusal: "duplicate" });
      return { ok: false, reason: "duplicate", firstClaimedAt: duplicate.ts, count: okEntries.length };
    }
    if (opts.limit) {
      const windowStart = now - opts.limit.windowMs;
      const inWindow = okEntries.filter((e) => Date.parse(e.ts) > windowStart);
      if (inWindow.length >= opts.limit.limit) {
        const oldest = inWindow[0] ? Date.parse(inWindow[0].ts) : now;
        append(file, { ...base, ok: false, refusal: "capped" });
        return {
          ok: false,
          reason: "capped",
          count: inWindow.length,
          limit: opts.limit.limit,
          window: opts.limit.window,
          retryAfterMs: Math.max(0, oldest + opts.limit.windowMs - now),
        };
      }
    }
    append(file, { ...base, ok: true });
    return { ok: true, count: okEntries.length + 1 };
  });
}

function append(file: string, entry: LedgerEntry): void {
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export interface LedgerSummary {
  scope: string;
  claims: number;
  refusedDuplicate: number;
  refusedCapped: number;
  last24h: number;
}

export function summarize(scope: string, now = Date.now()): LedgerSummary {
  const entries = readLedger(scope);
  const dayAgo = now - 86_400_000;
  return {
    scope,
    claims: entries.filter((e) => e.ok).length,
    refusedDuplicate: entries.filter((e) => e.refusal === "duplicate").length,
    refusedCapped: entries.filter((e) => e.refusal === "capped").length,
    last24h: entries.filter((e) => e.ok && Date.parse(e.ts) > dayAgo).length,
  };
}

export function listScopes(): string[] {
  try {
    return fs
      .readdirSync(ledgerDir())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}

/** Entries written by one run, across every scope. */
export function entriesForRun(runId: string): LedgerEntry[] {
  return listScopes().flatMap((scope) => readLedger(scope).filter((e) => e.run === runId).map((e) => ({ ...e, meta: { ...e.meta, scope } })));
}

export function resetScope(scope: string): boolean {
  try {
    fs.unlinkSync(scopeFile(scope));
    return true;
  } catch {
    return false;
  }
}
