/**
 * The crash suite. Twenty-one cases of agents that misbehave the way real ones did, each
 * run under nightshift with the limit that should catch it. A case passes
 * only if the report says what happened *and* nothing is left running.
 *
 *   bun run crashtest
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(ROOT, "src", "cli.ts");
const AGENTS = path.join(ROOT, "crashtest", "agents");
const HARNESS_TIMEOUT_MS = 45_000;

interface Report {
  outcome: string;
  exitCode: number | null;
  durationMs: number;
  kill?: { guard: string; reason: string; escalatedToSigkill: boolean };
  orphans?: { found: number[]; survivors: number[] };
  survivors: number[];
  usage: { totalTokens: number; estimatedUsd: number; messages: number };
  failedToStart?: string;
  ledger: { claims: number; refused: number };
  postconditions: Array<{ check: string; ok: boolean }>;
  disk: { watched: Record<string, number> };
}

interface Case {
  name: string;
  failure: string;
  /** null: run a command that does not exist */
  agent: string | null;
  limits: string[];
  env?: Record<string, string>;
  during?: (ctx: { home: string; cwd: string }) => Promise<void>;
  expect: (r: Report, exitCode: number | null) => string | null;
}

const killedBy = (guard: string) => (r: Report, code: number | null) =>
  r.outcome !== "killed" ? `outcome ${r.outcome}, wanted killed` :
  r.kill?.guard !== guard ? `killed by ${r.kill?.guard}, wanted ${guard}` :
  r.survivors.length ? `survivors ${r.survivors.join(",")}` :
  code !== 2 ? `exit code ${code}, wanted 2` : null;

const CASES: Case[] = [
  {
    name: "hang",
    failure: "goes silent forever",
    agent: "hang.ts",
    limits: ["--idle-timeout", "2s", "--max-runtime", "30s"],
    expect: killedBy("idle-timeout"),
  },
  {
    name: "runaway",
    failure: "never finishes",
    agent: "runaway.ts",
    limits: ["--max-runtime", "2s"],
    expect: killedBy("max-runtime"),
  },
  {
    name: "ignore-sigterm",
    failure: "traps SIGTERM",
    agent: "ignore-sigterm.ts",
    limits: ["--max-runtime", "2s", "--grace", "1s"],
    expect: (r, code) => killedBy("max-runtime")(r, code) ?? (r.kill?.escalatedToSigkill ? null : "did not escalate to SIGKILL"),
  },
  {
    name: "fast-orphan",
    failure: "detaches a child, exits in 60ms",
    agent: "fast-orphan.ts",
    limits: ["--max-runtime", "20s"],
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}, wanted completed` :
      !r.orphans?.found.length ? "orphan was not noticed" :
      r.survivors.length ? `survivors ${r.survivors.join(",")}` : null,
  },
  {
    name: "wrapper-shell",
    failure: "sh wrapper dies, worker ignores TERM",
    agent: "wrapper-shell.sh",
    limits: ["--max-runtime", "2s", "--grace", "1s"],
    expect: (r, code) => killedBy("max-runtime")(r, code) ?? (r.kill?.escalatedToSigkill ? null : "did not escalate to SIGKILL"),
  },
  {
    name: "spawn-fail",
    failure: "command does not exist",
    agent: null,
    limits: ["--max-runtime", "5s"],
    expect: (r, code) =>
      r.outcome !== "failed" ? `outcome ${r.outcome}, wanted failed` :
      r.exitCode !== 127 ? `exit code in report ${r.exitCode}, wanted 127` :
      !r.failedToStart ? "report does not say the command failed to start" :
      code !== 1 ? `nightshift exit ${code}, wanted 1` : null,
  },
  {
    name: "silent-orphan",
    failure: "detaches /bin/sleep, exits silently",
    agent: "silent-orphan.ts",
    limits: ["--max-runtime", "20s"],
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}, wanted completed` :
      !r.orphans?.found.length ? "orphan was not noticed" :
      r.survivors.length ? `survivors ${r.survivors.join(",")}` : null,
  },
  {
    name: "grace-spawner",
    failure: "spawns /bin/sleep from its SIGTERM handler",
    agent: "grace-spawner.ts",
    limits: ["--max-runtime", "2s", "--grace", "2s"],
    expect: killedBy("max-runtime"),
  },
  {
    name: "unpriced-model",
    failure: "spends on a model with no price",
    agent: "budget-blower.ts",
    env: { CRASH_MODEL: "claude-zorp-9" },
    limits: ["--adapter", "claude", "--budget", "2usd", "--max-runtime", "30s"],
    expect: killedBy("budget"),
  },
  {
    name: "noeol-stream",
    failure: "one huge event, no newline",
    agent: "noeol-stream.ts",
    limits: ["--adapter", "claude", "--max-tokens", "300k", "--max-runtime", "30s"],
    expect: killedBy("max-tokens"),
  },
  {
    name: "orphan",
    failure: "detaches a child, exits 0",
    agent: "orphan.ts",
    limits: ["--max-runtime", "20s"],
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}, wanted completed` :
      !r.orphans?.found.length ? "orphan was not noticed" :
      r.survivors.length ? `survivors ${r.survivors.join(",")}` : null,
  },
  {
    name: "fork-bomb-lite",
    failure: "30 children, then silence",
    agent: "fork-bomb-lite.ts",
    limits: ["--idle-timeout", "2s"],
    expect: killedBy("idle-timeout"),
  },
  {
    name: "disk-filler",
    failure: "fills the disk",
    agent: "disk-filler.ts",
    limits: ["--max-disk-growth", "30mb", "--watch", ".", "--max-runtime", "30s"],
    expect: killedBy("max-disk-growth"),
  },
  {
    name: "output-flood",
    failure: "floods stdout",
    agent: "output-flood.ts",
    limits: ["--max-output", "8mb", "--max-runtime", "30s"],
    expect: killedBy("max-output"),
  },
  {
    name: "budget-blower",
    failure: "spends without limit",
    agent: "budget-blower.ts",
    limits: ["--adapter", "claude", "--budget", "2usd", "--max-runtime", "30s"],
    expect: (r, code) =>
      killedBy("budget")(r, code) ??
      (r.usage.estimatedUsd > 3 ? `estimate ${r.usage.estimatedUsd} suggests duplicate events were double-counted` : null),
  },
  {
    name: "token-blower",
    failure: "burns tokens",
    agent: "budget-blower.ts",
    limits: ["--adapter", "claude", "--max-tokens", "300k", "--max-runtime", "30s"],
    expect: killedBy("max-tokens"),
  },
  {
    name: "send-loop",
    failure: "sends 21 messages",
    agent: "send-loop.ts",
    limits: ["--max-runtime", "40s"],
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}` :
      r.ledger.claims !== 5 ? `ledger allowed ${r.ledger.claims} sends, wanted 5` :
      r.ledger.refused !== 16 ? `ledger refused ${r.ledger.refused}, wanted 16` : null,
  },
  {
    name: "kill-file",
    failure: "must be stopped by hand",
    agent: "kill-file.ts",
    limits: ["--max-runtime", "30s"],
    during: async ({ home }) => {
      await sleep(2500);
      execFileSync("bun", [CLI, "stop", "latest"], { env: { ...process.env, NIGHTSHIFT_HOME: home }, stdio: "ignore" });
    },
    expect: killedBy("kill-file"),
  },
  {
    name: "postcondition",
    failure: "claims success, produced nothing",
    agent: "postcondition.ts",
    limits: ["--require", "out.json"],
    expect: (r, code) =>
      r.outcome !== "postcondition-failed" ? `outcome ${r.outcome}` : code !== 3 ? `exit code ${code}, wanted 3` : null,
  },
  {
    name: "stdin-waiter",
    failure: "waits for a keyboard",
    agent: "stdin-waiter.ts",
    limits: ["--max-runtime", "10s"],
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}` : r.durationMs > 5000 ? `took ${r.durationMs}ms; stdin was not closed` : null,
  },
  {
    name: "codex-budget-blower",
    failure: "speaks codex JSONL, spends without limit",
    agent: "codex-blower.ts",
    limits: ["--adapter", "codex", "--budget", "2usd", "--max-runtime", "30s"],
    expect: (r, code) =>
      killedBy("budget")(r, code) ??
      (r.usage.estimatedUsd > 3 ? `estimate ${r.usage.estimatedUsd} suggests running totals were added up` : null),
  },
];

async function runCase(c: Case): Promise<{ ok: boolean; detail: string; ms: number }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-crash-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-crash-cwd-"));
  const agent = c.agent ? path.join(AGENTS, c.agent) : "/nonexistent/nightshift-crashtest-missing-binary";
  const runner = c.agent === null ? [agent] : c.agent.endsWith(".sh") ? ["sh", agent] : ["bun", agent];
  const args = [CLI, "run", "--quiet", "--tick", "500ms", "--name", c.name, ...c.limits, "--", ...runner];
  const env = { ...process.env, NIGHTSHIFT_HOME: home, NIGHTSHIFT_BIN: `bun ${CLI}`, ...(c.env ?? {}) };
  const started = Date.now();

  const child = spawn("bun", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const timeout = sleep(HARNESS_TIMEOUT_MS).then(() => "timeout" as const);
  if (c.during) void c.during({ home, cwd });
  const result = await Promise.race([exit, timeout]);
  const ms = Date.now() - started;

  if (result === "timeout") {
    child.kill("SIGKILL");
    execFileSync("pkill", ["-9", "-f", agent], { stdio: "ignore" }).toString();
    return { ok: false, detail: "harness timeout: nightshift itself did not finish", ms };
  }

  const runs = fs.existsSync(path.join(home, "runs")) ? fs.readdirSync(path.join(home, "runs")) : [];
  const reportPath = runs[0] ? path.join(home, "runs", runs[0], "report.json") : null;
  if (!reportPath || !fs.existsSync(reportPath)) {
    return { ok: false, detail: `no report written (exit ${result}) ${stderr.slice(-300)}`, ms };
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Report;
  const problem = c.expect(report, result);
  if (problem) return { ok: false, detail: problem, ms };

  // The assertion that matters most: nothing from this case is still alive.
  await sleep(300);
  const leaked = leakedProcesses(agent, cwd);
  if (leaked.length) {
    execFileSync("pkill", ["-9", "-f", agent], { stdio: "ignore" });
    return { ok: false, detail: `leaked processes: ${leaked.join(" | ")}`, ms };
  }
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  return { ok: true, detail: describe(report), ms };
}

function leakedProcesses(agent: string, cwd: string): string[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => (l.includes(agent) || l.includes(cwd) || / sleep 4[234]4[23]\b/.test(l)) && !/^\s*\d+\s+\d+\s+Z/.test(l))
    .map((l) => l.trim().slice(0, 100));
}

function describe(r: Report): string {
  if (r.outcome === "killed") return `${r.kill?.guard}: ${r.kill?.reason}${r.kill?.escalatedToSigkill ? " → SIGKILL" : ""}`;
  if (r.orphans?.found.length) return `exit 0; killed ${r.orphans.found.length} orphan${r.orphans.found.length === 1 ? "" : "s"}`;
  if (r.ledger.claims || r.ledger.refused) return `ledger allowed ${r.ledger.claims}, refused ${r.ledger.refused}`;
  if (r.outcome === "postcondition-failed") return `exit 0 but ${r.postconditions.filter((p) => !p.ok).map((p) => p.check).join(", ")} missing → exit 3`;
  return `${r.outcome} in ${r.durationMs}ms`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  console.log(`nightshift crash suite · ${cases.length} failure modes\n`);
  let caught = 0;
  const rows: string[] = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.name.padEnd(16)} ${c.failure.padEnd(36)} `);
    const r = await runCase(c);
    if (r.ok) caught += 1;
    const line = `${r.ok ? "✅" : "❌"} ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`;
    console.log(line);
    rows.push(`| ${c.name} | ${c.failure} | ${r.ok ? "✅" : "❌"} ${r.detail} |`);
  }
  console.log(`\n${caught}/${cases.length} failure modes caught\n`);
  if (process.env.CRASHTEST_MARKDOWN) console.log(["| case | failure | result |", "|---|---|---|", ...rows].join("\n"));
  process.exit(caught === cases.length ? 0 : 1);
}

void main();
