/**
 * Owns the agent process and everything it spawns.
 *
 * The agent runs in its own process group, so one signal reaches the whole
 * tree. A process that calls setsid() escapes the group; for those there are
 * two more nets. A descendant map built from `ps`, refreshed at spawn, on
 * every output chunk and on every tick, catches a child that has re-parented
 * itself. And every process we start inherits a marker in its environment
 * (NIGHTSHIFT_RUN_ID), so anything still carrying it is ours no matter what
 * it did to its group or parent.
 *
 * Each net has a known blind spot, stated in the README. Apple platform
 * binaries (/bin/sh, /bin/sleep, /usr/bin/tail ...) never show their
 * environment to `ps -E`, so on macOS the marker net sees bun, node, python,
 * git and claude but not a bare shell loop. The descendant map covers those
 * as long as it was refreshed while the parent was alive, which is why it is
 * refreshed so often.
 *
 * Every pid we remember is remembered with its start time, so a pid that
 * was recycled by an unrelated process after ours died is dropped, never
 * signalled.
 *
 * Kill is an escalation, never a single signal: SIGTERM to everything we
 * know, a grace period measured from the SIGTERM (not from when the direct
 * child happened to exit), then SIGKILL to everything still alive, then a
 * survivor check. Whatever is still alive after that is reported by pid,
 * because the worst outcome is a kill that quietly did not kill.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REFRESH_MIN_GAP_MS = 100;

export interface SupervisorOptions {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "inherit";
  graceMs: number;
  /** Env var name and value that marks every process of this run. */
  marker?: { name: string; value: string };
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The command could not be started at all (ENOENT, EACCES). */
  failedToStart?: string;
}

export interface KillResult {
  reason: string;
  escalatedToSigkill: boolean;
  survivors: number[];
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  started: string;
  command: string;
}

export class Supervisor {
  private child: ChildProcess | null = null;
  private exit: Promise<ExitInfo> | null = null;
  private startFailure: string | null = null;
  /** pid -> start time string, so a recycled pid is never mistaken for ours. */
  private descendants = new Map<number, string>();
  private killing: Promise<KillResult> | null = null;
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly opts: SupervisorOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** With detached:true the child leads its own process group: pgid === pid. */
  get pgid(): number | null {
    return this.pid;
  }

  get failedToStart(): string | null {
    return this.startFailure;
  }

  start(): number | null {
    const [file, ...args] = this.opts.command;
    if (!file) throw new Error("No command to run");
    const child = spawn(file, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      detached: true,
      stdio: [this.opts.stdin, "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", this.opts.onStdout);
    child.stderr?.on("data", this.opts.onStderr);
    this.exit = new Promise<ExitInfo>((resolve) => {
      child.once("error", (err) => {
        this.startFailure = `${file}: ${err.message}`;
        resolve({ code: 127, signal: null, failedToStart: this.startFailure });
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (child.pid) void this.refreshDescendants(true);
    return child.pid ?? null;
  }

  wait(): Promise<ExitInfo> {
    if (!this.exit) throw new Error("Supervisor has not started");
    return this.exit;
  }

  /**
   * Walk the process table from the child down and remember every pid with
   * its start time. Rate-limited, because it is called on every output chunk;
   * pass force=true to bypass the limit (spawn, kill).
   */
  async refreshDescendants(force = false): Promise<void> {
    if (!this.child?.pid) return;
    if (this.refreshing) return this.refreshing;
    const now = Date.now();
    if (!force && now - this.lastRefresh < REFRESH_MIN_GAP_MS) return;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
      this.lastRefresh = Date.now();
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const root = this.child?.pid;
    if (!root) return;
    const table = await processTable();
    if (!table) return;
    const byPid = new Map(table.map((row) => [row.pid, row]));

    // Drop anything that is gone or whose pid now belongs to a newer process.
    for (const [pid, started] of this.descendants) {
      const row = byPid.get(pid);
      if (!row || row.started !== started) this.descendants.delete(pid);
    }

    // Tree walk from the child.
    const frontier = [root];
    const seen = new Set<number>();
    while (frontier.length) {
      const parent = frontier.pop() as number;
      for (const row of table) {
        if (row.ppid === parent && !seen.has(row.pid) && row.pid !== root) {
          seen.add(row.pid);
          this.descendants.set(row.pid, row.started);
          frontier.push(row.pid);
        }
      }
    }

    // Same process group (covers a child whose parent died before we walked).
    for (const row of table) {
      if (row.pgid === root && row.pid !== root && !row.stat.startsWith("Z")) this.descendants.set(row.pid, row.started);
    }

    // Marker in the environment (covers setsid escapees that are not Apple platform binaries).
    for (const pid of await this.markedPids()) {
      const row = byPid.get(pid);
      if (row) this.descendants.set(pid, row.started);
    }
  }

  /** Every live process whose environment carries this run's marker. */
  private async markedPids(): Promise<number[]> {
    const marker = this.opts.marker;
    if (!marker) return [];
    const pids = await pidsWithEnv(`${marker.name}=${marker.value}`);
    return pids.filter((pid) => pid !== process.pid && pid !== this.child?.pid);
  }

  knownDescendants(): number[] {
    return [...this.descendants.keys()];
  }

  /** Idempotent: concurrent callers share one escalation. */
  kill(reason: string): Promise<KillResult> {
    if (!this.killing) this.killing = this.escalate(reason);
    return this.killing;
  }

  /** Skip whatever grace remains and send SIGKILL now. Used for a second Ctrl-C. */
  hurry(): void {
    this.hurried = true;
  }
  private hurried = false;

  private async escalate(reason: string): Promise<KillResult> {
    if (!this.child?.pid) return { reason, escalatedToSigkill: false, survivors: [] };
    const pgid = this.pgid as number;
    await this.refreshDescendants(true);
    signalGroup(pgid, "SIGTERM");
    for (const pid of this.descendants.keys()) signalPid(pid, "SIGTERM");

    // Grace is measured from the SIGTERM. The direct child exiting early does
    // not shorten it for the grandchildren still winding down.
    const deadline = Date.now() + this.opts.graceMs;
    let alive = await this.survivors();
    while (alive.length && Date.now() < deadline && !this.hurried) {
      await sleep(Math.min(200, Math.max(20, deadline - Date.now())));
      alive = await this.survivors();
    }

    let escalated = false;
    if (alive.length) {
      escalated = true;
      await this.killWave(pgid, alive);
      // Anything spawned during the grace window gets one more wave.
      const again = await this.survivors();
      if (again.length) await this.killWave(pgid, again);
    }
    await Promise.race([this.wait(), sleep(2000)]);
    // SIGKILL cannot be ignored, but the kernel needs a moment to reap.
    await sleep(150);
    return { reason, escalatedToSigkill: escalated, survivors: await this.survivors() };
  }

  private async killWave(pgid: number, alive: number[]): Promise<void> {
    await this.refreshDescendants(true);
    signalGroup(pgid, "SIGKILL");
    for (const pid of new Set([...this.descendants.keys(), ...alive])) signalPid(pid, "SIGKILL");
    await sleep(300);
  }

  /**
   * After the main process has exited on its own, anything it left behind is
   * an orphan and gets the same treatment. Returns pids that were alive.
   */
  async sweepOrphans(): Promise<{ found: number[]; survivors: number[] }> {
    if (!this.child?.pid) return { found: [], survivors: [] };
    await this.refreshDescendants(true);
    const found = await this.survivors();
    if (!found.length) return { found, survivors: [] };
    const pgid = this.pgid as number;
    signalGroup(pgid, "SIGTERM");
    for (const pid of found) signalPid(pid, "SIGTERM");
    const deadline = Date.now() + Math.min(this.opts.graceMs, 3000);
    let alive = await this.survivors();
    while (alive.length && Date.now() < deadline) {
      await sleep(100);
      alive = await this.survivors();
    }
    if (alive.length) {
      await this.killWave(pgid, alive);
      alive = await this.survivors();
    }
    return { found, survivors: alive };
  }

  /** Every pid in the group, on the descendant list or carrying the marker, that is still alive. */
  async survivors(): Promise<number[]> {
    if (!this.child?.pid) return [];
    const table = await processTable();
    if (!table) return [];
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const alive = new Set<number>();
    const pgid = this.pgid as number;
    for (const row of table) {
      if (row.pgid === pgid && !row.stat.startsWith("Z")) alive.add(row.pid);
    }
    for (const [pid, started] of this.descendants) {
      const row = byPid.get(pid);
      if (row && row.started === started && !row.stat.startsWith("Z")) alive.add(pid);
    }
    for (const pid of await this.markedPids()) {
      const row = byPid.get(pid);
      if (row && !row.stat.startsWith("Z")) alive.add(pid);
    }
    alive.delete(process.pid);
    return [...alive].sort((a, b) => a - b);
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already gone.
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * One `ps` call for everything: pid, parent, group, state, start time and
 * command. `lstart` is a fixed "Tue Sep  2 19:12:18 2026" on both macOS and
 * Linux, which is what makes pid reuse detectable.
 */
export async function processTable(): Promise<ProcessRow[] | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows: ProcessRow[] = [];
    const re = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*(.*)$/;
    for (const line of stdout.split("\n")) {
      const m = line.match(re);
      if (!m) continue;
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        stat: m[4] ?? "",
        started: m[5] ?? "",
        command: m[6] ?? "",
      });
    }
    return rows;
  } catch {
    return null;
  }
}

/** Live (non-zombie) pids in a process group. */
export async function groupMembers(pgid: number): Promise<number[]> {
  const table = await processTable();
  if (!table || pgid <= 1) return [];
  return table.filter((row) => row.pgid === pgid && !row.stat.startsWith("Z")).map((row) => row.pid);
}

/**
 * pids whose environment contains `needle` (e.g. "NIGHTSHIFT_RUN_ID=abc").
 * macOS: `ps -E` prints the environment of processes you own, except Apple
 * platform binaries, which never show it. Linux: /proc, which sees every
 * process of yours. Zombies have no environment left to read.
 */
export async function pidsWithEnv(needle: string): Promise<number[]> {
  if (process.platform === "linux") {
    const fs = await import("node:fs");
    const pids: number[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const env = fs.readFileSync(`/proc/${entry}/environ`, "latin1");
        if (env.split("\0").includes(needle)) pids.push(Number(entry));
      } catch {
        // Not ours, or gone.
      }
    }
    return pids;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-axE", "-o", "pid=,stat=,command="], { maxBuffer: 64 * 1024 * 1024 });
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const [, pid, stat, command] = match;
      if ((stat ?? "").startsWith("Z")) continue;
      if ((command ?? "").split(" ").includes(needle)) pids.push(Number(pid));
    }
    return pids;
  } catch {
    return [];
  }
}

/** Parse a `ps lstart` string. Returns null when it does not look like one. */
export function parseStarted(lstart: string): Date | null {
  const date = new Date(lstart.replace(/\s+/g, " "));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
