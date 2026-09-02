#!/usr/bin/env node
/**
 * nightshift - supervisor for unattended AI agent runs.
 *
 *   nightshift run [limits] -- <agent command>
 *   nightshift stop [run|latest|--all]
 *   nightshift runs
 *   nightshift report [run]
 *   nightshift ledger claim|show|reset
 *   nightshift hook [install|uninstall|add|list]
 *   nightshift schedule --at HH:MM [--label name] -- nightshift run ...
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { installIntoClaudeSettings, readHookConfig, runHook, uninstallFromClaudeSettings, writeHookConfig } from "./hook.js";
import { claim, listScopes, readLedger, resetScope, summarize } from "./ledger.js";
import { CHANNELS, type Channel } from "./notify.js";
import { EXIT_CODES, UsageError, runSupervised, type RunOptions } from "./run.js";
import { isProcessAlive, listRuns, readMeta, resolveRunId, runDir } from "./store.js";
import { groupMembers } from "./supervisor.js";
import { fmtDuration, parseBytes, parseCount, parseDuration, parseMoney, parseRate } from "./units.js";

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `nightshift ${VERSION} - supervisor for unattended AI agent runs

USAGE
  nightshift run [limits] [delivery] -- <command...>
  nightshift stop [run | latest | --all] [--force]
  nightshift runs
  nightshift report [run | latest] [--json]
  nightshift ledger claim --scope <s> --key <k> [--limit 40/day]
  nightshift ledger show [scope] | reset <scope>
  nightshift hook install | uninstall | add | list
  nightshift schedule --at HH:MM [--label name] [--install] -- nightshift run ...

LIMITS (each one is a kill, not a warning)
  --max-runtime <dur>       wall clock, e.g. 2h, 90m
  --idle-timeout <dur>      no output for this long means it is stuck, e.g. 15m
  --budget <usd>            dollars, e.g. 5usd or $5 (metered commands only)
  --max-tokens <n>          tokens, e.g. 2M, 500k (metered commands only)
  --max-disk-growth <size>  e.g. 2gb; add --watch <dir> to measure a directory exactly
  --max-output <size>       cap on what the agent may print, e.g. 50mb
  --kill-file <path>        stop when this file appears (per-run and global stop files always work)

POSTCONDITIONS (checked after exit; fail the run, do not kill it)
  --require <path>          must exist and be non-empty, repeatable

DELIVERY
  --report <channels>       comma list of telegram, discord, webhook, stdout (default stdout)
                            env: NIGHTSHIFT_TELEGRAM_TOKEN + NIGHTSHIFT_TELEGRAM_CHAT,
                                 NIGHTSHIFT_DISCORD_WEBHOOK, NIGHTSHIFT_WEBHOOK
  --name <label>            label for the run id and the report title
  --quiet                   do not echo the agent's output

BEHAVIOUR
  --grace <dur>             SIGTERM to SIGKILL escalation (default 10s)
  --tick <dur>              guard poll interval (default 1s)
  --stdin inherit           give the agent your terminal's stdin (default: closed)
  --adapter claude|none     force the usage adapter (default: auto by command name)
  --allow-unmetered         keep going when --budget/--max-tokens cannot be measured
  --cwd <dir>               run there instead of here

EXIT CODES  0 completed · 1 failed · 2 killed by a limit · 3 postcondition failed · 64 usage

EXAMPLES
  nightshift run --budget 5usd --max-runtime 2h --idle-timeout 15m --report telegram \\
    -- claude -p "fix the failing tests and commit"
  nightshift run --max-disk-growth 1gb --watch ./out --require ./out/result.json -- ./sync.sh
  nightshift ledger claim --scope telegram --key order-8812 --limit 40/day && send_message
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "run":
      return cmdRun(rest);
    case "stop":
      return cmdStop(rest);
    case "runs":
      return cmdRuns();
    case "report":
      return cmdReport(rest);
    case "ledger":
      return cmdLedger(rest);
    case "hook":
      return cmdHook(rest);
    case "schedule":
      return cmdSchedule(rest);
    default:
      process.stderr.write(`nightshift: unknown command "${command}"\n\n${HELP}`);
      return 64;
  }
}

function splitAtDashes(args: string[]): { own: string[]; command: string[] } {
  const at = args.indexOf("--");
  return at === -1 ? { own: args, command: [] } : { own: args.slice(0, at), command: args.slice(at + 1) };
}

async function cmdRun(args: string[]): Promise<number> {
  const { own, command } = splitAtDashes(args);
  if (!command.length) {
    process.stderr.write("nightshift run: put the agent command after `--`\n");
    return 64;
  }
  const { values } = parseArgs({
    args: own,
    allowPositionals: false,
    options: {
      "max-runtime": { type: "string" },
      "idle-timeout": { type: "string" },
      budget: { type: "string" },
      "max-tokens": { type: "string" },
      "max-disk-growth": { type: "string" },
      watch: { type: "string", multiple: true },
      "max-output": { type: "string" },
      "kill-file": { type: "string" },
      require: { type: "string", multiple: true },
      report: { type: "string" },
      name: { type: "string" },
      quiet: { type: "boolean" },
      grace: { type: "string" },
      tick: { type: "string" },
      stdin: { type: "string" },
      adapter: { type: "string" },
      "allow-unmetered": { type: "boolean" },
      cwd: { type: "string" },
    },
  });

  const channels = parseChannels(values.report ?? "stdout");
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const opts: RunOptions = {
    command,
    cwd,
    name: values.name,
    maxRuntimeMs: values["max-runtime"] ? parseDuration(values["max-runtime"]) : undefined,
    idleMs: values["idle-timeout"] ? parseDuration(values["idle-timeout"]) : undefined,
    budgetUsd: values.budget ? parseMoney(values.budget) : undefined,
    maxTokens: values["max-tokens"] ? parseCount(values["max-tokens"]) : undefined,
    maxDiskGrowthBytes: values["max-disk-growth"] ? parseBytes(values["max-disk-growth"]) : undefined,
    watchDirs: (values.watch ?? []).map((d) => path.resolve(cwd, d)),
    maxOutputBytes: values["max-output"] ? parseBytes(values["max-output"]) : undefined,
    killFile: values["kill-file"] ? path.resolve(cwd, values["kill-file"]) : undefined,
    requirePaths: values.require ?? [],
    graceMs: values.grace ? parseDuration(values.grace) : 10_000,
    tickMs: values.tick ? parseDuration(values.tick) : 1_000,
    stdin: values.stdin === "inherit" ? "inherit" : "ignore",
    adapter: values.adapter === "claude" ? "claude" : values.adapter === "none" ? "none" : "auto",
    allowUnmetered: Boolean(values["allow-unmetered"]),
    channels,
    quiet: Boolean(values.quiet),
  };
  if (opts.watchDirs.length && !opts.maxDiskGrowthBytes) {
    process.stderr.write("nightshift run: --watch only matters with --max-disk-growth; watching anyway for the report\n");
  }
  const report = await runSupervised(opts);
  return EXIT_CODES[report.outcome];
}

function parseChannels(list: string): Channel[] {
  const channels = list
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  for (const c of channels) {
    if (!CHANNELS.includes(c as Channel)) throw new UsageError(`unknown report channel "${c}" (use ${CHANNELS.join(", ")})`);
  }
  return channels as Channel[];
}

async function cmdStop(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: "boolean" }, force: { type: "boolean" } },
  });
  const targets = values.all
    ? listRuns().filter((r) => r.status === "running")
    : [readMeta(resolveRunId(positionals[0]) ?? "")].filter((m): m is NonNullable<typeof m> => m !== null);
  if (!targets.length) {
    process.stderr.write(values.all ? "nightshift stop: nothing is running\n" : `nightshift stop: no run matches "${positionals[0] ?? "latest"}"\n`);
    return 1;
  }
  for (const meta of targets) {
    const supervisorAlive = isProcessAlive(meta.supervisorPid);
    const members = await groupMembers(meta.pgid);
    if (meta.status !== "running" && !members.length) {
      process.stdout.write(`${meta.id}: already ${meta.status}\n`);
      continue;
    }
    if (supervisorAlive && meta.killFile && !values.force) {
      fs.writeFileSync(meta.killFile, `${new Date().toISOString()} nightshift stop\n`);
      process.stdout.write(`${meta.id}: stop requested; the supervisor will escalate and write the report\n`);
      continue;
    }
    // Supervisor is gone (or --force): kill the group ourselves.
    const signal = values.force ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-meta.pgid, signal);
      process.stdout.write(`${meta.id}: sent ${signal} to process group ${meta.pgid} (${members.length} processes)\n`);
    } catch {
      process.stdout.write(`${meta.id}: process group ${meta.pgid} is already gone\n`);
    }
  }
  return 0;
}

function cmdRuns(): number {
  const runs = listRuns();
  if (!runs.length) {
    process.stdout.write("no runs yet\n");
    return 0;
  }
  const rows = runs.slice(0, 30).map((r) => {
    const report = readReport(r.id);
    const status = r.status === "running" && !isProcessAlive(r.supervisorPid) ? "orphaned" : r.status;
    const spend = report?.usage.actualUsd !== undefined ? `$${report.usage.actualUsd.toFixed(2)}` : report?.usage.estimatedUsd ? `~$${report.usage.estimatedUsd.toFixed(2)}` : "";
    const took = report ? fmtDuration(report.durationMs) : fmtDuration(Date.now() - Date.parse(r.startedAt));
    return [r.id, status.padEnd(20), took.padStart(7), spend.padStart(8), r.command.join(" ").slice(0, 60)];
  });
  for (const row of rows) process.stdout.write(row.join("  ") + "\n");
  return 0;
}

function readReport(id: string): { usage: { actualUsd?: number; estimatedUsd: number }; durationMs: number } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(id), "report.json"), "utf8"));
  } catch {
    return null;
  }
}

function cmdReport(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  const id = resolveRunId(positionals[0]);
  if (!id) {
    process.stderr.write(`nightshift report: no run matches "${positionals[0] ?? "latest"}"\n`);
    return 1;
  }
  const file = path.join(runDir(id), values.json ? "report.json" : "report.md");
  try {
    process.stdout.write(fs.readFileSync(file, "utf8"));
    return 0;
  } catch {
    process.stderr.write(`nightshift report: ${id} has no report yet (still running?)\n`);
    return 1;
  }
}

async function cmdLedger(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "claim") {
    const { values } = parseArgs({
      args: rest,
      options: {
        scope: { type: "string" },
        key: { type: "string" },
        limit: { type: "string" },
        meta: { type: "string" },
      },
    });
    if (!values.scope || !values.key) {
      process.stderr.write("nightshift ledger claim: --scope and --key are required\n");
      return 64;
    }
    const result = await claim({
      scope: values.scope,
      key: values.key,
      limit: values.limit ? parseRate(values.limit) : undefined,
      run: process.env.NIGHTSHIFT_RUN_ID,
      meta: values.meta ? (JSON.parse(values.meta) as Record<string, unknown>) : undefined,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : result.reason === "duplicate" ? 3 : 4;
  }
  if (sub === "show") {
    const scopes = rest[0] ? [rest[0]] : listScopes();
    if (!scopes.length) {
      process.stdout.write("ledger is empty\n");
      return 0;
    }
    for (const scope of scopes) {
      const s = summarize(scope);
      process.stdout.write(`${scope}: ${s.claims} claimed (${s.last24h} in last 24h), ${s.refusedDuplicate} duplicate refusals, ${s.refusedCapped} cap refusals\n`);
      if (rest[0]) for (const e of readLedger(scope).slice(-20)) process.stdout.write(`  ${e.ts} ${e.ok ? "✓" : "✗"} ${e.key}${e.refusal ? ` (${e.refusal})` : ""}${e.run ? ` run=${e.run}` : ""}\n`);
    }
    return 0;
  }
  if (sub === "reset") {
    if (!rest[0]) {
      process.stderr.write("nightshift ledger reset: name the scope\n");
      return 64;
    }
    process.stdout.write(resetScope(rest[0]) ? `${rest[0]}: reset\n` : `${rest[0]}: no such scope\n`);
    return 0;
  }
  process.stderr.write("nightshift ledger: claim | show [scope] | reset <scope>\n");
  return 64;
}

async function cmdHook(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) return runHook(process.stdin, process.stdout);
  if (sub === "install") {
    const r = installIntoClaudeSettings();
    process.stdout.write(r.changed ? `added Bash PreToolUse hook to ${r.path}\n` : `hook already present in ${r.path}\n`);
    if (!readHookConfig().rules.length) process.stdout.write(`no rules yet: nightshift hook add --match '<regex>' --scope <name> --limit 40/day\n`);
    return 0;
  }
  if (sub === "uninstall") {
    const r = uninstallFromClaudeSettings();
    process.stdout.write(r.changed ? `removed hook from ${r.path}\n` : `hook was not installed\n`);
    return 0;
  }
  if (sub === "add") {
    const { values } = parseArgs({
      args: rest,
      options: { match: { type: "string" }, scope: { type: "string" }, limit: { type: "string" }, note: { type: "string" } },
    });
    if (!values.match || !values.scope) {
      process.stderr.write("nightshift hook add: --match <regex> and --scope <name> are required\n");
      return 64;
    }
    new RegExp(values.match);
    if (values.limit) parseRate(values.limit);
    const config = readHookConfig();
    config.rules.push({ match: values.match, scope: values.scope, limit: values.limit, note: values.note });
    writeHookConfig(config);
    process.stdout.write(`rule ${config.rules.length}: /${values.match}/i → scope ${values.scope}${values.limit ? ` at ${values.limit}` : " (dedupe only)"}\n`);
    return 0;
  }
  if (sub === "list") {
    const { rules } = readHookConfig();
    if (!rules.length) process.stdout.write("no hook rules\n");
    rules.forEach((r, i) => process.stdout.write(`${i + 1}. /${r.match}/i → ${r.scope}${r.limit ? ` at ${r.limit}` : ""}${r.note ? `  # ${r.note}` : ""}\n`));
    return 0;
  }
  process.stderr.write("nightshift hook: install | uninstall | add | list (or no argument when called by Claude Code)\n");
  return 64;
}

function cmdSchedule(args: string[]): number {
  const { own, command } = splitAtDashes(args);
  const { values } = parseArgs({
    args: own,
    options: { at: { type: "string" }, label: { type: "string" }, install: { type: "boolean" } },
  });
  if (!values.at || !/^\d{1,2}:\d{2}$/.test(values.at) || !command.length) {
    process.stderr.write("nightshift schedule --at HH:MM [--label name] [--install] -- nightshift run ... -- <agent>\n");
    return 64;
  }
  const [hour, minute] = values.at.split(":").map(Number) as [number, number];
  const label = values.label ?? "nightly";
  const logDir = path.join(os.homedir(), ".nightshift", "launchd");
  if (process.platform === "darwin") {
    const plistName = `com.nightshift.${label}`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((c) => `    <string>${escapeXml(c)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(process.cwd())}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, `${label}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${escapeXml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict>
</dict>
</plist>
`;
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${plistName}.plist`);
    if (values.install) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist);
      process.stdout.write(`wrote ${plistPath}\nload it with:\n  launchctl bootstrap gui/$(id -u) ${plistPath}\nremove with:\n  launchctl bootout gui/$(id -u)/${plistName}\n`);
    } else {
      process.stdout.write(plist);
      process.stdout.write(`\n# save as ${plistPath} and run: launchctl bootstrap gui/$(id -u) ${plistPath}\n# or re-run with --install\n`);
    }
    return 0;
  }
  const line = `${minute} ${hour} * * * cd ${shellQuote(process.cwd())} && ${command.map(shellQuote).join(" ")} >> ${shellQuote(path.join(logDir, `${label}.log`))} 2>&1`;
  process.stdout.write(`${line}\n# add with: (crontab -l; echo '${line.replace(/'/g, "'\\''")}') | crontab -\n`);
  return 0;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shellQuote(s: string): string {
  return /^[a-zA-Z0-9_./=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nightshift: ${message}\n`);
    process.exit(err instanceof UsageError || /Cannot read|unknown option|required/i.test(message) ? 64 : 1);
  },
);
