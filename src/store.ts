/**
 * Where nightshift keeps its state: one directory per run under
 * $NIGHTSHIFT_HOME (default ~/.nightshift), plus the side-effect ledgers.
 *
 *   ~/.nightshift/
 *     runs/<id>/meta.json      pid, pgid, command, status - written at start
 *     runs/<id>/output.log     everything the agent printed
 *     runs/<id>/events.jsonl   raw agent events when the adapter has them
 *     runs/<id>/report.json    the morning report, machine form
 *     runs/<id>/report.md      the morning report, human form
 *     ledger/<scope>.jsonl     side-effect claims
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function nightshiftHome(): string {
  return process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), ".nightshift");
}

export function runsDir(): string {
  return path.join(nightshiftHome(), "runs");
}

export function ledgerDir(): string {
  return path.join(nightshiftHome(), "ledger");
}

export function ensureDirs(): void {
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(ledgerDir(), { recursive: true, mode: 0o700 });
}

/** Sortable, readable, unique enough: 20260902-231504-a1b2c3 */
export function newRunId(name?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  const slug = name ? `-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}` : "";
  return `${stamp}-${rand}${slug}`;
}

export function runDir(id: string): string {
  return path.join(runsDir(), id);
}

export interface RunMeta {
  id: string;
  name?: string;
  command: string[];
  cwd: string;
  pid: number;
  pgid: number;
  startedAt: string;
  /** lost: the supervisor died without reporting and its processes are gone. */
  status: "running" | "completed" | "killed" | "failed" | "postcondition-failed" | "lost";
  supervisorPid: number;
  killFile?: string;
}

export function writeMeta(meta: RunMeta): void {
  const dir = runDir(meta.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, "meta.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "meta.json"));
}

export function readMeta(id: string): RunMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(id), "meta.json"), "utf8")) as RunMeta;
  } catch {
    return null;
  }
}

export function listRuns(): RunMeta[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  return ids
    .sort()
    .reverse()
    .map(readMeta)
    .filter((m): m is RunMeta => m !== null);
}

/** Resolve "latest", a full id, or a unique prefix. */
export function resolveRunId(query: string | undefined): string | null {
  const runs = listRuns();
  if (!query || query === "latest") return runs[0]?.id ?? null;
  const exact = runs.find((r) => r.id === query);
  if (exact) return exact.id;
  const matches = runs.filter((r) => r.id.startsWith(query) || r.id.endsWith(`-${query}`) || r.name === query);
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
