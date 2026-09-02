/**
 * The cgroup net decides what to do from files under /sys/fs/cgroup and
 * /proc. Every path is injectable, so these tests build a fake root in a
 * temp dir and run the real decision logic on any platform.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CGROUP2_SUPER_MAGIC,
  CgroupNet,
  ownSubtreePlan,
  parseCgroupV2Path,
  planCgroup,
  resolveExecutable,
  statfsType,
  systemdScopePlan,
  wrapInCgroup,
  type CgroupPaths,
} from "../src/cgroup";

let root: string;
let paths: CgroupPaths;
const command = ["bun", "agent.ts", "--flag"];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-cgroup-"));
  paths = {
    platform: "linux",
    sysfsRoot: path.join(root, "sys", "fs", "cgroup"),
    procSelfCgroup: path.join(root, "proc", "self", "cgroup"),
    systemdRun: path.join(root, "systemd-run"),
    // The temp dir is not a cgroup mount; "unknown" leaves the decision to the cgroup.procs check.
    fsType: () => null,
  };
  fs.mkdirSync(path.dirname(paths.procSelfCgroup), { recursive: true });
});
afterEach(() => {
  kernel?.mockRestore();
  kernel = null;
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

/** The value statfs reports for tmpfs (TMPFS_MAGIC), where a cgroup v2 mount would be on a machine that has none. */
const TMPFS_MAGIC = 0x01021994;

let kernel: ReturnType<typeof spyOn<typeof fs, "mkdirSync">> | null = null;

/**
 * Model the kernel: on a cgroup2 mount, mkdir populates the new directory
 * with cgroup.procs at once. A plain mkdir on the temp dir gives an empty
 * directory, which is exactly what a non-cgroup filesystem does.
 */
function cgroupKernel(): void {
  const realMkdir = fs.mkdirSync;
  kernel = spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    const made = realMkdir(dir, options);
    if (!options) fs.writeFileSync(path.join(String(dir), "cgroup.procs"), "");
    return made;
  }) as typeof fs.mkdirSync);
}

/** Point /proc/self/cgroup at `relative` and create the matching sysfs directory. */
function liveIn(relative: string, opts: { create?: boolean } = {}): string {
  fs.writeFileSync(paths.procSelfCgroup, `0::${relative}\n`);
  const dir = path.join(paths.sysfsRoot, relative);
  if (opts.create !== false) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const APP_SLICE = "/user.slice/user-1000.slice/user@1000.service/app.slice";

/**
 * A stand-in systemd-run that records its arguments, answers the probe the
 * way a real scope would (its own cgroup line, in app.slice) and exits with
 * `status`.
 */
function fakeSystemdRun(status: number, stderr = "", answer = `0::${APP_SLICE}/$unit.scope`): string {
  const log = path.join(root, "systemd-run.log");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> "${log}"`,
    'for arg in "$@"; do case "$arg" in --unit=*) unit="${arg#--unit=}";; esac; done',
    `echo "${answer}"`,
    stderr ? `echo "${stderr}" >&2` : "",
    `exit ${status}`,
    "",
  ].join("\n");
  fs.writeFileSync(paths.systemdRun, script, { mode: 0o755 });
  return log;
}

describe("parseCgroupV2Path", () => {
  test("finds the unified hierarchy line", () => {
    expect(parseCgroupV2Path("0::/user.slice/user-1000.slice/session-2.scope\n")).toBe("/user.slice/user-1000.slice/session-2.scope");
  });
  test("ignores v1 controllers on a hybrid machine", () => {
    const text = "12:memory:/user.slice\n1:name=systemd:/user.slice/session-2.scope\n0::/init.scope\n";
    expect(parseCgroupV2Path(text)).toBe("/init.scope");
  });
  test("root cgroup is a path too", () => {
    expect(parseCgroupV2Path("0::/\n")).toBe("/");
  });
  test("a v1-only machine has no entry", () => {
    expect(parseCgroupV2Path("1:name=systemd:/user.slice\n2:cpu:/\n")).toBeNull();
    expect(parseCgroupV2Path("")).toBeNull();
  });
});

describe("own sub-cgroup", () => {
  test("is created under our cgroup and the command is wrapped", () => {
    cgroupKernel();
    const parent = liveIn("/user.slice/user-1000.slice/user@1000.service/app.slice");
    const setup = ownSubtreePlan("run-1", command, paths);
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    const dir = path.join(parent, "nightshift-run-1");
    expect(setup.plan).toEqual({ strategy: "own-subtree", dir, command: wrapInCgroup(dir, command) });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    // The probe moved a throwaway sh in by writing its pid.
    expect(fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8")).toMatch(/^\d+\n$/);
  });

  test("is refused, and the directory removed, when mkdir gave an empty directory (no cgroup2 mount)", () => {
    const parent = liveIn("/user.slice/user-1000.slice/user@1000.service/app.slice");
    const dir = path.join(parent, "nightshift-run-1");
    expect(ownSubtreePlan("run-1", command, paths)).toEqual({ ok: false, reason: `${dir} is not on a cgroup2 filesystem` });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  test("is refused when statfs says the mount is not cgroup2, even with a cgroup.procs in it", () => {
    cgroupKernel();
    const parent = liveIn("/user.slice/user-1000.slice/user@1000.service/app.slice");
    const dir = path.join(parent, "nightshift-run-1");
    const setup = ownSubtreePlan("run-1", command, { ...paths, fsType: () => TMPFS_MAGIC });
    expect(setup).toEqual({ ok: false, reason: `${dir} is not on a cgroup2 filesystem` });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  test("is accepted when statfs says cgroup2 and the kernel populated the directory", () => {
    cgroupKernel();
    liveIn("/user.slice/user-1000.slice/user@1000.service/app.slice");
    const seen: string[] = [];
    const setup = ownSubtreePlan("run-1", command, { ...paths, fsType: (dir) => (seen.push(dir), CGROUP2_SUPER_MAGIC) });
    expect(setup.ok).toBe(true);
    expect(seen).toEqual([path.join(paths.sysfsRoot, "/user.slice/user-1000.slice/user@1000.service/app.slice/nightshift-run-1")]);
  });

  test("says why when there is no v2 entry", () => {
    fs.writeFileSync(paths.procSelfCgroup, "1:name=systemd:/user.slice\n");
    expect(ownSubtreePlan("run-1", command, paths)).toEqual({ ok: false, reason: "no cgroup v2 entry in /proc/self/cgroup" });
  });

  test("says why when /proc/self/cgroup is unreadable", () => {
    const setup = ownSubtreePlan("run-1", command, paths);
    expect(setup.ok).toBe(false);
    if (!setup.ok) expect(setup.reason).toMatch(/^cannot read .*ENOENT$/);
  });

  test("says why when mkdir fails", () => {
    liveIn("/system.slice/cron.service", { create: false });
    const setup = ownSubtreePlan("run-1", command, paths);
    expect(setup.ok).toBe(false);
    if (!setup.ok) expect(setup.reason).toMatch(/^mkdir .*nightshift-run-1: ENOENT$/);
  });

  test("says why when the parent is not writable, and leaves nothing behind", () => {
    if (process.getuid?.() === 0) return;
    const parent = liveIn("/user.slice/user-1000.slice/session-3.scope");
    fs.chmodSync(parent, 0o555);
    const setup = ownSubtreePlan("run-1", command, paths);
    expect(setup.ok).toBe(false);
    if (!setup.ok) expect(setup.reason).toMatch(/^mkdir .*: EACCES$/);
    expect(fs.readdirSync(parent)).toEqual([]);
  });
});

describe("the wrapper", () => {
  test("moves itself in, execs the command, passes the exit code through", () => {
    const dir = path.join(root, "cg");
    fs.mkdirSync(dir);
    const wrapped = wrapInCgroup(dir, ["sh", "-c", 'echo "pid=$$ arg=$1"; exit 7', "sh", "one two"]);
    const result = spawnSync(wrapped[0] as string, wrapped.slice(1), { encoding: "utf8" });
    expect(result.status).toBe(7);
    const moved = fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").trim();
    // exec keeps the pid: the agent reports the same pid the wrapper wrote.
    expect(result.stdout.trim()).toBe(`pid=${moved} arg=one two`);
  });

  test("refuses to start the agent when the move fails", () => {
    const wrapped = wrapInCgroup(path.join(root, "missing"), ["sh", "-c", "echo started"]);
    const result = spawnSync(wrapped[0] as string, wrapped.slice(1), { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("systemd scope", () => {
  test("is proven with a no-op before the agent is wrapped", () => {
    const log = fakeSystemdRun(0);
    const setup = systemdScopePlan("run-2", command, paths);
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.plan.strategy).toBe("systemd-scope");
    // The probe landed in app.slice, so the agent's scope will too.
    expect(setup.plan.dir).toBe(path.join(paths.sysfsRoot, APP_SLICE, "nightshift-run-2.scope"));
    expect(setup.plan.command).toEqual([paths.systemdRun, "--user", "--scope", "--quiet", "--collect", "--unit=nightshift-run-2", "--", ...command]);
    expect(fs.readFileSync(log, "utf8")).toBe(`--user --scope --quiet --collect --unit=nightshift-run-2-probe -- cat ${paths.procSelfCgroup}\n`);
  });

  test("is refused when the probe did not land in its scope", () => {
    fakeSystemdRun(0, "", "0::/system.slice/cron.service");
    expect(systemdScopePlan("run-2", command, paths)).toEqual({
      ok: false,
      reason: "systemd-run --user --scope: probe did not land in its scope (0::/system.slice/cron.service)",
    });
  });

  test("reports systemd's own words when the user manager is missing", () => {
    fakeSystemdRun(1, "Failed to connect to bus: No medium found");
    const setup = systemdScopePlan("run-2", command, paths);
    expect(setup).toEqual({ ok: false, reason: "systemd-run --user --scope: Failed to connect to bus: No medium found" });
  });

  test("reports a missing binary", () => {
    expect(systemdScopePlan("run-2", command, paths)).toEqual({ ok: false, reason: "systemd-run not found" });
  });
});

describe("strategy selection", () => {
  test("nothing outside Linux", () => {
    expect(planCgroup("run-3", command, { ...paths, platform: "darwin" })).toEqual({ ok: false, reason: "only on Linux" });
  });

  test("own sub-cgroup first", () => {
    cgroupKernel();
    liveIn("/user.slice/user-1000.slice/user@1000.service/app.slice");
    fakeSystemdRun(0);
    const setup = planCgroup("run-3", command, paths);
    expect(setup.ok && setup.plan.strategy).toBe("own-subtree");
  });

  test("systemd scope when our cgroup directory is writable but not a cgroup2 mount", () => {
    const parent = liveIn("/user.slice/user-1000.slice/user@1000.service/app.slice");
    fakeSystemdRun(0);
    const setup = planCgroup("run-3", command, paths);
    expect(setup.ok && setup.plan.strategy).toBe("systemd-scope");
    // The refused directory is gone, so nothing is left behind on the non-cgroup mount.
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  test("systemd scope when our cgroup is not ours to write", () => {
    liveIn("/user.slice/user-1000.slice/session-3.scope", { create: false });
    fakeSystemdRun(0);
    const setup = planCgroup("run-3", command, paths);
    expect(setup.ok && setup.plan.strategy).toBe("systemd-scope");
  });

  test("both reasons when neither works", () => {
    liveIn("/system.slice/cron.service", { create: false });
    fakeSystemdRun(1, "Failed to connect to bus: No medium found");
    const setup = planCgroup("run-3", command, paths);
    expect(setup.ok).toBe(false);
    if (!setup.ok) expect(setup.reason).toBe(`mkdir ${paths.sysfsRoot}/system.slice/cron.service/nightshift-run-3: ENOENT; systemd-run --user --scope: Failed to connect to bus: No medium found`);
  });
});

describe("CgroupNet", () => {
  test("reads cgroup.procs and never lists itself", () => {
    const dir = path.join(root, "cg");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "cgroup.procs"), `${process.pid}\n4343\n4344\n\n`);
    expect(new CgroupNet(dir).pids()).toEqual([4343, 4344]);
    expect(new CgroupNet(path.join(root, "gone")).pids()).toEqual([]);
  });

  test("prefers cgroup.kill when the kernel offers it", () => {
    const dir = path.join(root, "cg");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "cgroup.kill"), "0");
    fs.writeFileSync(path.join(dir, "cgroup.procs"), "");
    const net = new CgroupNet(dir);
    expect(net.hasKillFile).toBe(true);
    net.killAll();
    expect(fs.readFileSync(path.join(dir, "cgroup.kill"), "utf8")).toBe("1");
  });

  test("release removes an empty directory and tolerates one already gone", async () => {
    const dir = path.join(root, "cg");
    fs.mkdirSync(dir);
    expect(await new CgroupNet(dir).release()).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    expect(await new CgroupNet(dir).release()).toBeNull();
  });

  test("release says what is still inside when rmdir keeps failing", async () => {
    const dir = path.join(root, "cg");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "cgroup.procs"), "4343\n");
    const note = await new CgroupNet(dir).release(120);
    expect(note).toMatch(/^cgroup .*cg could not be removed \(ENOTEMPTY\); 1 process\(es\) still inside$/);
  });
});

describe("statfsType", () => {
  test("names the filesystem of a directory and is null for a path that is not there", () => {
    const type = statfsType(root);
    expect(typeof type).toBe("number");
    expect(type).not.toBe(CGROUP2_SUPER_MAGIC);
    expect(statfsType(path.join(root, "missing"))).toBeNull();
  });
  test("reports CGROUP2_SUPER_MAGIC for a real cgroup2 mount", () => {
    if (process.platform !== "linux" || !fs.existsSync("/sys/fs/cgroup/cgroup.procs")) return;
    expect(statfsType("/sys/fs/cgroup")).toBe(CGROUP2_SUPER_MAGIC);
  });
});

describe("resolveExecutable", () => {
  const cwd = process.cwd();
  test("finds a command on PATH and rejects one that is not there", () => {
    expect(resolveExecutable("sh", process.env.PATH, cwd)).toMatch(/\/sh$/);
    expect(resolveExecutable("nightshift-definitely-missing-xyz", process.env.PATH, cwd)).toBeNull();
    expect(resolveExecutable("sh", undefined, cwd)).toBeNull();
  });
  test("a path is checked as given", () => {
    expect(resolveExecutable("/bin/sh", undefined, cwd)).toBe("/bin/sh");
    expect(resolveExecutable(root, undefined, cwd)).toBeNull();
    expect(resolveExecutable("/nonexistent/nightshift", undefined, cwd)).toBeNull();
  });
  test("a relative command is resolved against the run's cwd, as spawn does", () => {
    const runDir = path.join(root, "run");
    fs.mkdirSync(path.join(runDir, "bin"), { recursive: true });
    const agent = path.join(runDir, "agent.sh");
    fs.writeFileSync(agent, "#!/bin/sh\necho ran from $(pwd)\n", { mode: 0o755 });
    fs.writeFileSync(path.join(runDir, "bin", "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
    // The supervisor's own cwd does not have it; the run's does.
    expect(resolveExecutable("./agent.sh", undefined, cwd)).toBeNull();
    expect(resolveExecutable("./agent.sh", undefined, runDir)).toBe(agent);
    // A relative PATH entry is relative to the same directory.
    expect(resolveExecutable("tool.sh", "bin", runDir)).toBe(path.join(runDir, "bin", "tool.sh"));
    expect(resolveExecutable("tool.sh", "bin", cwd)).toBeNull();
    // What spawn itself does with that command and cwd.
    const result = spawnSync("./agent.sh", [], { cwd: runDir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`ran from ${fs.realpathSync(runDir)}`);
  });
});
