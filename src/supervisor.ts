/**
 * Owns the agent process and everything it spawns.
 *
 * The agent runs in its own process group, so one signal reaches the whole
 * tree. A process that calls setsid() escapes the group; for those there are
 * two more nets. A descendant map built from `ps`, refreshed on every tick,
 * catches a grandchild that has re-parented itself. And every process we
 * start inherits a marker in its environment (NIGHTSHIFT_RUN_ID), so anything
 * still carrying it is ours no matter what it did to its group or parent.
 * Only a process that scrubs its own environment *and* detaches *and* whose
 * parent exits within one tick can slip all three.
 *
 * Kill is an escalation, never a single signal: SIGTERM to the group, a grace
 * period, then SIGKILL to the group and to every known descendant, then a
 * survivor check. Whatever is still alive after that is reported by pid,
 * because the worst outcome is a kill that quietly did not kill.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
}

export interface KillResult {
  reason: string;
  escalatedToSigkill: boolean;
  survivors: number[];
}

export class Supervisor {
  private child: ChildProcess | null = null;
  private exit: Promise<ExitInfo> | null = null;
  private descendants = new Set<number>();
  private killing: Promise<KillResult> | null = null;

  constructor(private readonly opts: SupervisorOptions) {}

  get pid(): number {
    const pid = this.child?.pid;
    if (!pid) throw new Error("Supervisor has not started");
    return pid;
  }

  /** With detached:true the child leads its own process group: pgid === pid. */
  get pgid(): number {
    return this.pid;
  }

  start(): number {
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
        this.opts.onStderr(Buffer.from(`nightshift: failed to start ${file}: ${err.message}\n`));
        resolve({ code: 127, signal: null });
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return child.pid ?? -1;
  }

  wait(): Promise<ExitInfo> {
    if (!this.exit) throw new Error("Supervisor has not started");
    return this.exit;
  }

  /** Refresh the descendant map from `ps`. Cheap enough to run every tick. */
  async refreshDescendants(): Promise<void> {
    if (!this.child?.pid) return;
    const table = await processTable();
    if (!table) return;
    const found = new Set<number>();
    const frontier = [this.child.pid];
    while (frontier.length) {
      const parent = frontier.pop() as number;
      for (const [pid, ppid] of table) {
        if (ppid === parent && !found.has(pid)) {
          found.add(pid);
          frontier.push(pid);
        }
      }
    }
    // Union, never replace: a descendant that already re-parented to launchd
    // or init would vanish from the tree walk but must stay on the kill list.
    for (const pid of found) this.descendants.add(pid);
    for (const pid of await this.markedPids()) this.descendants.add(pid);
  }

  /** Every live process whose environment carries this run's marker. */
  private async markedPids(): Promise<number[]> {
    const marker = this.opts.marker;
    if (!marker) return [];
    const pids = await pidsWithEnv(`${marker.name}=${marker.value}`);
    return pids.filter((pid) => pid !== process.pid && pid !== this.child?.pid);
  }

  knownDescendants(): number[] {
    return [...this.descendants];
  }

  /** Idempotent: concurrent callers share one escalation. */
  kill(reason: string): Promise<KillResult> {
    if (!this.killing) this.killing = this.escalate(reason);
    return this.killing;
  }

  private async escalate(reason: string): Promise<KillResult> {
    const pgid = this.pgid;
    await this.refreshDescendants();
    signalGroup(pgid, "SIGTERM");
    for (const pid of this.descendants) signalPid(pid, "SIGTERM");

    const exited = await Promise.race([
      this.wait().then(() => true),
      sleep(this.opts.graceMs).then(() => false),
    ]);

    let escalated = false;
    if (!exited || (await this.survivors()).length) {
      escalated = true;
      signalGroup(pgid, "SIGKILL");
      for (const pid of this.descendants) signalPid(pid, "SIGKILL");
      await Promise.race([this.wait(), sleep(2000)]);
    }
    // SIGKILL cannot be ignored, but the kernel needs a moment to reap.
    await sleep(150);
    return { reason, escalatedToSigkill: escalated, survivors: await this.survivors() };
  }

  /**
   * After the main process has exited on its own, anything it left behind is
   * an orphan and gets the same treatment. Returns pids that were alive.
   */
  async sweepOrphans(): Promise<{ found: number[]; survivors: number[] }> {
    const found = await this.survivors();
    if (!found.length) return { found, survivors: [] };
    signalGroup(this.pgid, "SIGTERM");
    for (const pid of found) signalPid(pid, "SIGTERM");
    await sleep(Math.min(this.opts.graceMs, 3000));
    let survivors = await this.survivors();
    if (survivors.length) {
      signalGroup(this.pgid, "SIGKILL");
      for (const pid of survivors) signalPid(pid, "SIGKILL");
      await sleep(300);
      survivors = await this.survivors();
    }
    return { found, survivors };
  }

  /** Every pid in the group or on the descendant list that is still alive. */
  async survivors(): Promise<number[]> {
    const alive = new Set<number>();
    for (const pid of await groupMembers(this.pgid)) alive.add(pid);
    for (const pid of this.descendants) if (isAlive(pid)) alive.add(pid);
    for (const pid of await this.markedPids()) alive.add(pid);
    alive.delete(process.pid);
    return [...alive].sort((a, b) => a - b);
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already gone.
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** pids in a process group, excluding zombies (which are dead, just unreaped). */
export async function groupMembers(pgid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,stat="], { maxBuffer: 16 * 1024 * 1024 });
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const [pid, group, stat] = line.trim().split(/\s+/);
      if (Number(group) === pgid && !(stat ?? "").startsWith("Z")) pids.push(Number(pid));
    }
    return pids;
  } catch {
    return [];
  }
}

async function processTable(): Promise<Array<[number, number]> | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], { maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number) as [number, number])
      .filter(([pid, ppid]) => Number.isFinite(pid) && Number.isFinite(ppid));
  } catch {
    return null;
  }
}

/**
 * pids whose environment contains `needle` (e.g. "NIGHTSHIFT_RUN_ID=abc").
 * macOS: `ps -E` prints the environment of processes you own. Linux: /proc.
 * Zombies are skipped everywhere; a zombie has no environment left to read.
 */
export async function pidsWithEnv(needle: string): Promise<number[]> {
  if (process.platform === "linux") {
    const fs = await import("node:fs");
    const pids: number[] = [];
    for (const entry of fs.readdirSync("/proc")) {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
