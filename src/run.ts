/**
 * One supervised run, start to report.
 *
 * Order of events:
 *   1. work out what we are running and whether we can meter it
 *   2. baseline git and disk
 *   3. spawn in its own process group, start the guard tick
 *   4. wait: either the agent exits, or a guard says stop and we escalate
 *   5. sweep orphans, check postconditions, deliver, write the report
 *
 * Every exit path writes a report: the agent finishing, a guard killing it,
 * the command not existing, the supervisor being interrupted. A run you
 * cannot read about in the morning did not happen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";
import {
  BudgetGuard,
  DiskGuard,
  IdleGuard,
  KillFileGuard,
  OutputGuard,
  TokenGuard,
  WallClockGuard,
  type Guard,
  type GuardContext,
  type Verdict,
} from "./guards.js";
import { entriesForRun } from "./ledger.js";
import { ADAPTERS, emptyUsage, resolveAdapter, type Meter, type UsageTotals } from "./meters/index.js";
import { DiskMeter } from "./meters/disk.js";
import { notify, type Channel } from "./notify.js";
import { childEnv, redact } from "./redact.js";
import { gitDelta, gitSnapshot, renderMarkdown, type Outcome, type RunReport } from "./report.js";
import { ensureDirs, newRunId, nightshiftHome, runDir, writeMeta, type RunMeta } from "./store.js";
import { Supervisor, type KillResult } from "./supervisor.js";
import { fmtDuration } from "./units.js";

export { UsageError };

export interface RunOptions {
  command: string[];
  cwd: string;
  name?: string;
  maxRuntimeMs?: number;
  idleMs?: number;
  killFile?: string;
  maxTokens?: number;
  budgetUsd?: number;
  maxDiskGrowthBytes?: number;
  watchDirs: string[];
  maxOutputBytes?: number;
  requirePaths: string[];
  graceMs: number;
  tickMs: number;
  stdin: "ignore" | "inherit";
  /** auto, none, or an adapter name from the registry. */
  adapter: string;
  allowUnmetered: boolean;
  channels: Channel[];
  quiet: boolean;
}

export const EXIT_CODES: Record<Outcome, number> = {
  completed: 0,
  failed: 1,
  killed: 2,
  "postcondition-failed": 3,
};

const TAIL_LINES = 40;

export async function runSupervised(opts: RunOptions): Promise<RunReport> {
  ensureDirs();
  const id = newRunId(opts.name);
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const notes: string[] = [];

  // 1. adapter + instrumentation
  const resolved = resolveAdapter(opts.adapter, opts.command);
  let effective = opts.command;
  let renders = false;
  let metered = false;
  if (resolved) {
    const inst = resolved.adapter.instrument(opts.command, { budgetUsd: opts.budgetUsd, forced: resolved.forced });
    effective = inst.argv;
    renders = inst.renders;
    metered = inst.metered;
    notes.push(...inst.notes);
  }
  if ((opts.budgetUsd !== undefined || opts.maxTokens !== undefined) && !metered) {
    if (!opts.allowUnmetered) {
      throw new UsageError(
        `--budget and --max-tokens need a metered command, and nightshift cannot read usage from "${opts.command[0]}". ` +
          `Use --adapter ${ADAPTERS.map((a) => a.name).join("|")} if the command speaks one of those formats under another name, ` +
          `or --allow-unmetered to run with the other limits only.`,
      );
    }
    notes.push("spend limits were requested but this command is unmetered; they did not apply");
  }

  // 2. baselines
  const logPath = path.join(dir, "output.log");
  const eventsPath = metered ? path.join(dir, "events.jsonl") : undefined;
  const log = fs.createWriteStream(logPath, { mode: 0o600 });
  const events = eventsPath ? fs.createWriteStream(eventsPath, { mode: 0o600 }) : null;
  const gitBefore = await gitSnapshot(opts.cwd);
  const disk = new DiskMeter(opts.cwd, opts.watchDirs);
  await disk.baseline();

  const tail: string[] = [];
  let outputBytes = 0;
  let lastOutputAt = Date.now();
  const echo = (text: string) => {
    if (!opts.quiet) process.stdout.write(text);
  };
  const remember = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // The tail ends up in report.json and on a webhook; the log stays local.
      tail.push(redact(line));
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };

  const noMeter: Meter = { totals: emptyUsage(), feed: () => {}, end: () => {} };
  const meter: Meter = !resolved ? noMeter : resolved.adapter.createMeter({
    onText: renders
      ? (text) => {
          log.write(text);
          echo(text);
          remember(text);
        }
      : undefined,
    onEvent: (line) => events?.write(line + "\n"),
    onUnpricedModel: (model) => notes.push(`no list price for ${model}; its tokens were counted at ceiling prices`),
  }, { argv: effective });
  const usage: UsageTotals = meter.totals;

  // Guards that are pure arithmetic over the context run on every chunk as
  // well as on the tick: a flood of output or a burst of spend should be
  // stopped within one write, not within one second.
  let fastGuards: Guard[] = [];
  let checkFast: () => void = () => {};
  let capped = false;
  let supervisor: Supervisor | null = null;

  const onChunk = () => {
    lastOutputAt = Date.now();
    // Output is the best moment to walk the process tree: a parent that
    // prints and exits is still alive while its child is being recorded.
    void supervisor?.refreshDescendants();
  };
  const onStdout = (chunk: Buffer) => {
    outputBytes += chunk.length;
    onChunk();
    if (capped) return;
    if (renders) {
      meter.feed(chunk);
    } else {
      if (metered) meter.feed(chunk);
      log.write(chunk);
      echo(chunk.toString());
      remember(chunk.toString());
    }
    checkFast();
  };
  const onStderr = (chunk: Buffer) => {
    outputBytes += chunk.length;
    onChunk();
    if (capped) return;
    log.write(chunk);
    if (!opts.quiet) process.stderr.write(chunk);
    remember(chunk.toString());
    checkFast();
  };

  // 3. spawn + guards
  supervisor = new Supervisor({
    command: effective,
    cwd: opts.cwd,
    env: childEnv(process.env, { NIGHTSHIFT_RUN_ID: id, NIGHTSHIFT_RUN_DIR: dir }),
    stdin: opts.stdin,
    graceMs: opts.graceMs,
    marker: { name: "NIGHTSHIFT_RUN_ID", value: id },
    cgroup: { runId: id },
    onStdout,
    onStderr,
  });
  const startedAt = Date.now();
  const pid = await supervisor.start();
  notes.push(supervisor.cgroupNote);
  const perRunStop = path.join(dir, "stop");
  const globalStop = path.join(nightshiftHome(), "stop");

  const guards = buildGuards(opts, disk, [perRunStop, globalStop]);
  const limits = guards.filter((g) => !(g instanceof KillFileGuard && g.builtin)).map((g) => g.describe());
  if (!limits.length) notes.push("no limits set; nightshift only observed and reported this run");
  fastGuards = guards.filter((g) => g instanceof OutputGuard || g instanceof TokenGuard || g instanceof BudgetGuard);

  const meta: RunMeta = {
    id,
    name: opts.name,
    command: opts.command,
    cwd: opts.cwd,
    pid: pid ?? 0,
    pgid: pid ?? 0,
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    supervisorPid: process.pid,
    killFile: perRunStop,
  };
  writeMeta(meta);
  if (!opts.quiet) {
    process.stderr.write(`nightshift ${id} · pid ${pid ?? "none"} · ${limits.length ? limits.join(" · ") : "no limits"} · stop with: nightshift stop ${id}\n`);
  }

  let kill: (KillResult & { guard: string }) | undefined;
  let killing: Promise<void> | null = null;
  const stop = (verdict: Verdict): Promise<void> => {
    // The child exits part-way through the escalation, which resolves
    // wait() below; the aftermath must wait for the kill result too.
    if (!killing) {
      if (!opts.quiet) process.stderr.write(`\nnightshift: stopping (${verdict.guard}: ${verdict.reason})\n`);
      killing = supervisor!.kill(verdict.reason).then((result) => {
        kill = { ...result, guard: verdict.guard };
      });
    }
    return killing;
  };
  checkFast = () => {
    if (killing) return;
    const ctx: GuardContext = { now: Date.now(), startedAt, lastOutputAt, outputBytes, usage };
    for (const guard of fastGuards) {
      const verdict = guard.check(ctx) as Verdict | null;
      if (verdict) {
        // Stop feeding the log once a cap has fired; the log is disk too.
        if (guard instanceof OutputGuard) capped = true;
        void stop(verdict);
        return;
      }
    }
  };

  // First signal: graceful stop. Second: skip the grace, SIGKILL now.
  // Third: give up on the report and leave.
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals === 1) void stop({ guard: "signal", reason: `nightshift received ${signal}` });
    else if (signals === 2) {
      process.stderr.write("nightshift: second signal, sending SIGKILL now\n");
      supervisor?.hurry();
    } else {
      process.stderr.write("nightshift: third signal, exiting without a report\n");
      writeMeta({ ...meta, status: "killed" });
      process.exit(130);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  let checking = false;
  const ticker = setInterval(async () => {
    if (checking || killing) return;
    checking = true;
    try {
      await supervisor!.refreshDescendants();
      const ctx: GuardContext = { now: Date.now(), startedAt, lastOutputAt, outputBytes, usage };
      for (const guard of guards) {
        const verdict = await guard.check(ctx);
        if (verdict) {
          await stop(verdict);
          break;
        }
      }
    } finally {
      checking = false;
    }
  }, opts.tickMs);

  // 4. wait
  const exit = await supervisor.wait();
  clearInterval(ticker);
  if (killing) await killing;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  meter.end();
  const endedAt = Date.now();

  // 5. aftermath
  let orphans: RunReport["orphans"];
  let survivors: number[] = [];
  if (kill) {
    survivors = kill.survivors;
  } else if (!exit.failedToStart) {
    const sweep = await supervisor.sweepOrphans();
    if (sweep.found.length) orphans = sweep;
    survivors = sweep.survivors;
  }
  const leftover = await supervisor.release();
  if (leftover) notes.push(leftover);

  const postconditions = checkPostconditions(opts, exit.code);
  const pathsMissing = postconditions.some((p) => !p.ok && p.check.startsWith("path"));
  const outcome: Outcome = kill ? "killed" : exit.code !== 0 ? "failed" : pathsMissing ? "postcondition-failed" : "completed";
  if (exit.failedToStart) notes.push(`the command could not be started: ${exit.failedToStart}`);

  const ledgerEntries = entriesForRun(id);
  const growth = await disk.growth();
  notes.push(...disk.notes);
  await new Promise<void>((resolve) => log.end(resolve));
  if (events) await new Promise<void>((resolve) => events.end(resolve));

  const report: RunReport = {
    id,
    name: opts.name,
    command: opts.command,
    effectiveCommand: effective,
    cwd: opts.cwd,
    host: os.hostname(),
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    outcome,
    exitCode: exit.code,
    signal: exit.signal,
    failedToStart: exit.failedToStart,
    kill: kill ? { guard: kill.guard, reason: kill.reason, escalatedToSigkill: kill.escalatedToSigkill } : undefined,
    orphans,
    survivors,
    postconditions,
    limits,
    usage,
    git: await gitDelta(opts.cwd, gitBefore),
    disk: { freeDeltaBytes: growth.freeDeltaBytes, watched: growth.watched },
    ledger: {
      claims: ledgerEntries.filter((e) => e.ok).length,
      refused: ledgerEntries.filter((e) => !e.ok).length,
      entries: ledgerEntries,
    },
    outputBytes,
    outputTail: tail,
    notes,
    paths: { dir, log: logPath, events: eventsPath, report: path.join(dir, "report.md") },
  };

  // Deliver first, so a failed delivery is in the report that gets written.
  const remote = opts.channels.filter((c) => c !== "stdout");
  for (const d of await notify(remote, report)) {
    if (!d.ok) {
      notes.push(`${d.channel} notification failed: ${d.detail}`);
      process.stderr.write(`nightshift: ${d.channel} notification failed: ${d.detail}\n`);
    }
  }
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.writeFileSync(report.paths.report, renderMarkdown(report), { mode: 0o600 });
  writeMeta({ ...meta, status: outcome });
  if (opts.channels.includes("stdout")) await notify(["stdout"], report);
  if (!opts.quiet) process.stderr.write(`nightshift: report → ${report.paths.report}\n`);
  return report;
}

function buildGuards(opts: RunOptions, disk: DiskMeter, stopFiles: string[]): Guard[] {
  const guards: Guard[] = [];
  if (opts.maxRuntimeMs) guards.push(new WallClockGuard(opts.maxRuntimeMs));
  if (opts.idleMs) guards.push(new IdleGuard(opts.idleMs));
  if (opts.maxTokens) guards.push(new TokenGuard(opts.maxTokens));
  if (opts.budgetUsd) guards.push(new BudgetGuard(opts.budgetUsd));
  if (opts.maxOutputBytes) guards.push(new OutputGuard(opts.maxOutputBytes));
  if (opts.maxDiskGrowthBytes) guards.push(new DiskGuard(disk, opts.maxDiskGrowthBytes, Math.max(opts.tickMs, 2000)));
  for (const file of stopFiles) guards.push(new KillFileGuard(file, true));
  if (opts.killFile) guards.push(new KillFileGuard(opts.killFile, false));
  return guards;
}

function checkPostconditions(opts: RunOptions, exitCode: number | null): RunReport["postconditions"] {
  const results: RunReport["postconditions"] = [];
  for (const p of opts.requirePaths) {
    const resolved = path.resolve(opts.cwd, p);
    try {
      const stat = fs.statSync(resolved);
      const ok = stat.isDirectory() ? fs.readdirSync(resolved).length > 0 : stat.size > 0;
      results.push({ check: `path ${p}`, ok, detail: ok ? undefined : "exists but is empty" });
    } catch {
      results.push({ check: `path ${p}`, ok: false, detail: "does not exist" });
    }
  }
  results.push({ check: "exited 0", ok: exitCode === 0, detail: exitCode === 0 ? undefined : `exit ${exitCode}` });
  return results;
}

export function describeRun(report: RunReport): string {
  return `${report.outcome} after ${fmtDuration(report.durationMs)}`;
}
