/**
 * One supervised run, start to report.
 *
 * Order of events:
 *   1. work out what we are running and whether we can meter it
 *   2. baseline git and disk
 *   3. spawn in its own process group, start the guard tick
 *   4. wait: either the agent exits, or a guard says stop and we escalate
 *   5. sweep orphans, check postconditions, write the report, deliver it
 *
 * Every exit path writes a report, including the ones where the agent was
 * killed. A run you cannot read about in the morning did not happen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { ClaudeStreamMeter, emptyUsage, instrumentClaudeArgv, isClaudeCommand, type UsageTotals } from "./meters/claude.js";
import { DiskMeter } from "./meters/disk.js";
import { notify, type Channel } from "./notify.js";
import { gitDelta, gitSnapshot, renderMarkdown, type Outcome, type RunReport } from "./report.js";
import { ensureDirs, newRunId, nightshiftHome, runDir, writeMeta, type RunMeta } from "./store.js";
import { Supervisor, type KillResult } from "./supervisor.js";
import { fmtDuration } from "./units.js";

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
  adapter: "auto" | "claude" | "none";
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

export class UsageError extends Error {}

const TAIL_LINES = 40;

export async function runSupervised(opts: RunOptions): Promise<RunReport> {
  ensureDirs();
  const id = newRunId(opts.name);
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const notes: string[] = [];

  // 1. adapter + instrumentation
  const useClaude = opts.adapter === "claude" || (opts.adapter === "auto" && isClaudeCommand(opts.command));
  let effective = opts.command;
  let renders = false;
  let metered = false;
  if (useClaude) {
    const inst = instrumentClaudeArgv(opts.command, { budgetUsd: opts.budgetUsd, forced: opts.adapter === "claude" });
    effective = inst.argv;
    renders = inst.renders;
    metered = inst.metered;
    notes.push(...inst.notes);
  }
  if ((opts.budgetUsd !== undefined || opts.maxTokens !== undefined) && !metered) {
    if (!opts.allowUnmetered) {
      throw new UsageError(
        `--budget and --max-tokens need a metered command, and nightshift cannot read usage from "${opts.command[0]}". ` +
          `Use --adapter claude if this is Claude Code under another name, or --allow-unmetered to run with the other limits only.`,
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
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };

  const meter = new ClaudeStreamMeter({
    onText: renders
      ? (text) => {
          log.write(text);
          echo(text);
          remember(text);
        }
      : undefined,
    onEvent: (line) => events?.write(line + "\n"),
    onUnpricedModel: (model) => notes.push(`no list price for ${model}; live budget could not count its tokens`),
  });
  const usage: UsageTotals = metered ? meter.totals : emptyUsage();

  // Guards that are pure arithmetic over the context run on every chunk as
  // well as on the tick: a flood of output or a burst of spend should be
  // stopped within one write, not within one second.
  let fastGuards: Guard[] = [];
  let checkFast: () => void = () => {};
  let capped = false;

  const onStdout = (chunk: Buffer) => {
    outputBytes += chunk.length;
    lastOutputAt = Date.now();
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
    lastOutputAt = Date.now();
    if (capped) return;
    log.write(chunk);
    if (!opts.quiet) process.stderr.write(chunk);
    remember(chunk.toString());
    checkFast();
  };

  // 3. spawn + guards
  const supervisor = new Supervisor({
    command: effective,
    cwd: opts.cwd,
    env: { ...process.env, NIGHTSHIFT_RUN_ID: id, NIGHTSHIFT_RUN_DIR: dir },
    stdin: opts.stdin,
    graceMs: opts.graceMs,
    marker: { name: "NIGHTSHIFT_RUN_ID", value: id },
    onStdout,
    onStderr,
  });
  const startedAt = Date.now();
  const pid = supervisor.start();
  const perRunStop = path.join(dir, "stop");
  const globalStop = path.join(nightshiftHome(), "stop");

  const guards = buildGuards(opts, disk, [perRunStop, globalStop]);
  const limits = guards.map((g) => g.describe());
  fastGuards = guards.filter((g) => g instanceof OutputGuard || g instanceof TokenGuard || g instanceof BudgetGuard);
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
  if (!guards.some((g) => g.name !== "kill-file")) notes.push("no limits set; nightshift only observed and reported this run");

  const meta: RunMeta = {
    id,
    name: opts.name,
    command: opts.command,
    cwd: opts.cwd,
    pid,
    pgid: pid,
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    supervisorPid: process.pid,
    killFile: perRunStop,
  };
  writeMeta(meta);
  if (!opts.quiet) {
    process.stderr.write(`nightshift ${id} · pid ${pid} · ${limits.length ? limits.join(" · ") : "no limits"}\n`);
  }

  let kill: (KillResult & { guard: string }) | undefined;
  let killing: Promise<void> | null = null;
  const stop = (verdict: Verdict): Promise<void> => {
    // The child exits part-way through the escalation, which resolves
    // wait() below; the aftermath must wait for the kill result too.
    if (!killing) {
      if (!opts.quiet) process.stderr.write(`\nnightshift: stopping (${verdict.guard}: ${verdict.reason})\n`);
      killing = supervisor.kill(verdict.reason).then((result) => {
        kill = { ...result, guard: verdict.guard };
      });
    }
    return killing;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void stop({ guard: "signal", reason: `nightshift received ${signal}` });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  let ticks = 0;
  let checking = false;
  const ticker = setInterval(async () => {
    if (checking || killing) return;
    checking = true;
    try {
      ticks += 1;
      await supervisor.refreshDescendants();
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
  } else {
    const sweep = await supervisor.sweepOrphans();
    if (sweep.found.length) orphans = sweep;
    survivors = sweep.survivors;
  }

  const postconditions = checkPostconditions(opts, exit.code);
  const outcome: Outcome = kill
    ? "killed"
    : postconditions.some((p) => !p.ok && p.check.startsWith("path"))
      ? "postcondition-failed"
      : exit.code === 0
        ? "completed"
        : "failed";

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

  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.writeFileSync(report.paths.report, renderMarkdown(report), { mode: 0o600 });
  writeMeta({ ...meta, status: outcome });

  const delivered = await notify(opts.channels, report);
  for (const d of delivered) {
    if (!d.ok) process.stderr.write(`nightshift: ${d.channel} notification failed: ${d.detail}\n`);
  }
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
  for (const file of [...stopFiles, ...(opts.killFile ? [opts.killFile] : [])]) guards.push(new KillFileGuard(file));
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
  results.push({ check: "exit 0", ok: exitCode === 0, detail: exitCode === 0 ? undefined : `exit ${exitCode}` });
  return results;
}

export function describeRun(report: RunReport): string {
  return `${report.outcome} after ${fmtDuration(report.durationMs)}`;
}
