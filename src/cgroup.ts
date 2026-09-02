/**
 * The fifth net, Linux only: a cgroup.
 *
 * The other four nets identify our processes by something a process can
 * change: its group (setsid), its parent (double fork), its environment
 * (env: {}), its working directory (chdir). Cgroup membership is inherited on
 * fork and cannot be left without write access to the cgroup filesystem, so
 * `cgroup.procs` lists every descendant no matter what it did to itself.
 *
 * Two ways to get one, the first that works wins:
 *
 *   1. Our own sub-cgroup. /proc/self/cgroup names the cgroup v2 directory
 *      this process lives in; if we may mkdir under it, the agent is started
 *      through a one-line sh wrapper that moves itself into the new cgroup
 *      and then execs the agent. The wrapper's pid becomes the agent's pid
 *      and the exit code passes straight through, so nothing else changes.
 *   2. `systemd-run --user --scope`, which asks the user's systemd for a
 *      transient scope and execs the agent inside it. A probe scope run
 *      first reports where the manager puts scopes; the agent's lands next
 *      to it, so its directory is known before the agent starts.
 *
 * Neither works without cgroup v2, without a writable directory or without a
 * user manager (typical under cron, in containers and on CI runners). Then
 * this module says why and the supervisor runs with four nets, as before.
 *
 * Every path is injectable so the parsing and the strategy choice can be
 * tested against a fake filesystem on any platform.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface CgroupPaths {
  /** process.platform, or "linux" to test the logic elsewhere. */
  platform: string;
  /** Mount point of the unified hierarchy, normally /sys/fs/cgroup. */
  sysfsRoot: string;
  /** /proc/self/cgroup. */
  procSelfCgroup: string;
  /** The systemd-run binary; a fake in tests. */
  systemdRun: string;
}

export function defaultCgroupPaths(): CgroupPaths {
  return {
    platform: process.platform,
    sysfsRoot: "/sys/fs/cgroup",
    procSelfCgroup: "/proc/self/cgroup",
    systemdRun: "systemd-run",
  };
}

export interface CgroupPlan {
  strategy: "own-subtree" | "systemd-scope";
  /** The command to spawn instead of the original; same pid, same exit code. */
  command: string[];
  /** The cgroup directory the agent will start in. */
  dir: string;
}

export type CgroupSetup = { ok: true; plan: CgroupPlan } | { ok: false; reason: string };

/**
 * The cgroup v2 directory of a process, relative to the mount point, from
 * the text of its /proc/<pid>/cgroup. The unified hierarchy is the line with
 * hierarchy id 0 and no controller list: "0::/user.slice/...". A v1-only
 * machine has no such line.
 */
export function parseCgroupV2Path(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = line.match(/^0::(\/.*)$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/** Decide how to contain `command` for run `runId`; ok: false means run with four nets, and says why. */
export function planCgroup(runId: string, command: string[], paths: CgroupPaths = defaultCgroupPaths()): CgroupSetup {
  if (paths.platform !== "linux") return { ok: false, reason: "only on Linux" };
  const own = ownSubtreePlan(runId, command, paths);
  if (own.ok) return own;
  const scope = systemdScopePlan(runId, command, paths);
  if (scope.ok) return scope;
  return { ok: false, reason: `${own.reason}; ${scope.reason}` };
}

/** Strategy 1: mkdir under our own cgroup and prove a process can move into it. */
export function ownSubtreePlan(runId: string, command: string[], paths: CgroupPaths): CgroupSetup {
  let text: string;
  try {
    text = fs.readFileSync(paths.procSelfCgroup, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read ${paths.procSelfCgroup}: ${errorCode(err)}` };
  }
  const relative = parseCgroupV2Path(text);
  if (relative === null) return { ok: false, reason: "no cgroup v2 entry in /proc/self/cgroup" };
  const dir = path.join(paths.sysfsRoot, relative, `nightshift-${runId}`);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    return { ok: false, reason: `mkdir ${dir}: ${errorCode(err)}` };
  }
  const probe = probeMove(dir);
  if (probe !== null) {
    removeQuietly(dir);
    return { ok: false, reason: `cannot move a process into ${dir}: ${probe}` };
  }
  return { ok: true, plan: { strategy: "own-subtree", command: wrapInCgroup(dir, command), dir } };
}

/**
 * The wrapper: sh moves itself into the cgroup (writing its own pid to
 * cgroup.procs), then execs the agent in place. $0 is the first argument
 * after the script, "$@" the rest. Membership is inherited by everything the
 * agent spawns from then on, before it has had a chance to spawn anything.
 */
export function wrapInCgroup(dir: string, command: string[]): string[] {
  return ["sh", "-c", 'echo $$ > "$0/cgroup.procs" && exec "$@"', dir, ...command];
}

/**
 * Moving a process needs write access to cgroup.procs in the target and in
 * the common ancestor; the only honest test is to move one. A throwaway sh
 * that exits at once leaves the cgroup empty again.
 */
function probeMove(dir: string): string | null {
  try {
    execFileSync("sh", ["-c", 'echo $$ > "$0/cgroup.procs"', dir], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
    return null;
  } catch (err) {
    const failure = err as { stderr?: Buffer | string; message?: string };
    const stderr = failure.stderr?.toString().trim();
    return stderr || failure.message || "unknown error";
  }
}

/**
 * Strategy 2: a transient user scope. A probe scope runs `cat
 * /proc/self/cgroup` first: it proves the user manager answers, and its
 * output names the slice scopes are placed in, so the agent's directory is
 * known before spawn. Reading it from /proc/<pid>/cgroup afterwards would be
 * a race that an agent exiting in a few milliseconds wins.
 */
export function systemdScopePlan(runId: string, command: string[], paths: CgroupPaths): CgroupSetup {
  const unit = `nightshift-${runId}`;
  const flags = ["--user", "--scope", "--quiet", "--collect"];
  let probe: string;
  try {
    probe = execFileSync(paths.systemdRun, [...flags, `--unit=${unit}-probe`, "--", "cat", paths.procSelfCgroup], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      encoding: "utf8",
    });
  } catch (err) {
    const failure = err as { stderr?: Buffer | string; code?: string; message?: string };
    if (failure.code === "ENOENT") return { ok: false, reason: "systemd-run not found" };
    const stderr = failure.stderr?.toString().trim();
    return { ok: false, reason: `systemd-run --user --scope: ${stderr || failure.message || "failed"}` };
  }
  const landed = parseCgroupV2Path(probe);
  if (landed === null || !landed.endsWith(`/${unit}-probe.scope`)) {
    return { ok: false, reason: `systemd-run --user --scope: probe did not land in its scope (${probe.trim() || "no output"})` };
  }
  const dir = path.join(paths.sysfsRoot, path.dirname(landed), `${unit}.scope`);
  return { ok: true, plan: { strategy: "systemd-scope", command: [paths.systemdRun, ...flags, `--unit=${unit}`, "--", ...command], dir } };
}

/** A live cgroup directory: who is in it, how to kill them all, how to remove it. */
export class CgroupNet {
  constructor(readonly dir: string) {}

  /** Every pid in the cgroup right now. Exiting tasks are already gone from the list. */
  pids(): number[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, "cgroup.procs"), "utf8")
        .split("\n")
        .filter((line) => /^\d+$/.test(line))
        .map(Number)
        .filter((pid) => pid !== process.pid);
    } catch {
      return [];
    }
  }

  /** cgroup.kill (kernel 5.14+) takes the whole cgroup down atomically. */
  get hasKillFile(): boolean {
    return fs.existsSync(path.join(this.dir, "cgroup.kill"));
  }

  /** SIGKILL everything at once when the kernel offers it, one pid at a time otherwise. */
  killAll(): void {
    if (this.hasKillFile) {
      try {
        fs.writeFileSync(path.join(this.dir, "cgroup.kill"), "1");
        return;
      } catch {
        // Fall through to per-pid signals.
      }
    }
    for (const pid of this.pids()) signal(pid, "SIGKILL");
  }

  signalAll(sig: NodeJS.Signals): void {
    for (const pid of this.pids()) signal(pid, sig);
  }

  /**
   * Remove the directory. rmdir refuses while a process is inside, and a
   * just-killed process takes a moment to leave, so retry briefly. Returns
   * what went wrong, or null. A directory that is already gone (systemd
   * collects an empty scope on its own) counts as removed.
   */
  async release(timeoutMs = 2000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() <= deadline) {
      try {
        fs.rmdirSync(this.dir);
        return null;
      } catch (err) {
        last = errorCode(err);
        if (last === "ENOENT") return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return `cgroup ${this.dir} could not be removed (${last}); ${this.pids().length} process(es) still inside`;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}

function removeQuietly(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Best effort; an empty cgroup directory is harmless.
  }
}

function errorCode(err: unknown): string {
  const failure = err as { code?: string; message?: string };
  return failure.code ?? failure.message ?? String(err);
}

/**
 * Where `file` would be found by spawn: an absolute path, or the first PATH
 * entry that has it. The wrapper turns a missing command into "sh: not
 * found" with exit 127 instead of the spawn error the report expects, so the
 * caller only wraps commands that exist.
 */
export function resolveExecutable(file: string, envPath: string | undefined): string | null {
  const executable = (candidate: string) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (file.includes("/")) return executable(file) ? path.resolve(file) : null;
  for (const entry of (envPath ?? "").split(":")) {
    if (!entry) continue;
    const candidate = path.join(entry, file);
    if (executable(candidate)) return candidate;
  }
  return null;
}
