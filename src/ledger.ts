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
 *
 * A damaged line (a crash mid-append, a full disk) must not make the ledger
 * forget everything before it: well-formed lines are kept, damaged ones are
 * skipped and counted, and the count is reported with every claim.
 */
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";
import { ledgerDir, ensureDirs, isProcessAlive } from "./store.js";
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
  | { ok: true; count: number; corrupt?: number }
  | { ok: false; reason: "duplicate"; firstClaimedAt: string; count: number; corrupt?: number }
  | { ok: false; reason: "capped"; count: number; limit: number; window: Rate["window"]; retryAfterMs: number; corrupt?: number };

const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 20_000;

export function scopeFile(scope: string): string {
  const safe = scope.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[.-]+/, "");
  if (!safe) throw new Error("Ledger scope must contain at least one letter or digit");
  return path.join(ledgerDir(), `${safe}.jsonl`);
}

export interface LedgerRead {
  entries: LedgerEntry[];
  corrupt: number;
}

export function readLedgerFile(scope: string): LedgerRead {
  let raw: string;
  try {
    raw = fs.readFileSync(scopeFile(scope), "utf8");
  } catch {
    return { entries: [], corrupt: 0 };
  }
  const entries: LedgerEntry[] = [];
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (typeof parsed.key === "string" && typeof parsed.ts === "string" && typeof parsed.ok === "boolean") entries.push(parsed);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { entries, corrupt };
}

export function readLedger(scope: string): LedgerEntry[] {
  return readLedgerFile(scope).entries;
}

/**
 * Lock file with the holder's pid inside. Stale when the holder is dead or
 * the lock is older than LOCK_STALE_MS; a stale lock is renamed away before
 * removal so two waiters cannot both "win" the same unlink.
 */
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
      if (lockIsStale(lock)) {
        const tomb = `${lock}.${process.pid}.${Date.now()}.stale`;
        try {
          fs.renameSync(lock, tomb);
          fs.unlinkSync(tomb);
        } catch {
          // Another waiter took it; loop again.
        }
        continue;
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

function lockIsStale(lock: string): boolean {
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
    const holder = Number(fs.readFileSync(lock, "utf8").trim());
    return Number.isFinite(holder) && holder > 0 && !isProcessAlive(holder);
  } catch {
    return false;
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

/** "listing-8812 " and "listing-8812" are the same send. */
export function normalizeKey(key: string): string {
  return key.replace(/\s+/g, " ").trim();
}

export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  ensureDirs();
  const file = scopeFile(opts.scope);
  const now = opts.now ?? Date.now();
  const key = normalizeKey(opts.key);
  if (!key) throw new UsageError("Ledger key must not be empty");
  return withLock(file, () => {
    const { entries, corrupt } = readLedgerFile(opts.scope);
    const okEntries = entries.filter((e) => e.ok);
    const duplicate = okEntries.find((e) => normalizeKey(e.key) === key);
    const base: LedgerEntry = { key, ts: new Date(now).toISOString(), ok: true };
    if (opts.run) base.run = opts.run;
    if (opts.meta) base.meta = opts.meta;
    const withCorrupt = <R extends object>(r: R): R & { corrupt?: number } => (corrupt ? { ...r, corrupt } : r);

    if (duplicate) {
      append(file, { ...base, ok: false, refusal: "duplicate" });
      return withCorrupt({ ok: false as const, reason: "duplicate" as const, firstClaimedAt: duplicate.ts, count: okEntries.length });
    }
    if (opts.limit) {
      const windowStart = now - opts.limit.windowMs;
      const inWindow = okEntries.filter((e) => Date.parse(e.ts) > windowStart);
      if (inWindow.length >= opts.limit.limit) {
        const oldest = inWindow[0] ? Date.parse(inWindow[0].ts) : now;
        append(file, { ...base, ok: false, refusal: "capped" });
        return withCorrupt({
          ok: false as const,
          reason: "capped" as const,
          count: inWindow.length,
          limit: opts.limit.limit,
          window: opts.limit.window,
          retryAfterMs: Math.max(0, oldest + opts.limit.windowMs - now),
        });
      }
    }
    append(file, base);
    return withCorrupt({ ok: true as const, count: okEntries.length + 1 });
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
  corrupt: number;
}

export function summarize(scope: string, now = Date.now()): LedgerSummary {
  const { entries, corrupt } = readLedgerFile(scope);
  const dayAgo = now - 86_400_000;
  return {
    scope,
    claims: entries.filter((e) => e.ok).length,
    refusedDuplicate: entries.filter((e) => e.refusal === "duplicate").length,
    refusedCapped: entries.filter((e) => e.refusal === "capped").length,
    last24h: entries.filter((e) => e.ok && Date.parse(e.ts) > dayAgo).length,
    corrupt,
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
  return listScopes().flatMap((scope) =>
    readLedger(scope)
      .filter((e) => e.run === runId)
      .map((e) => ({ ...e, meta: { ...e.meta, scope } })),
  );
}

export function resetScope(scope: string): boolean {
  try {
    fs.unlinkSync(scopeFile(scope));
    return true;
  } catch {
    return false;
  }
}
