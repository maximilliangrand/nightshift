/**
 * The crash suite. Agents that misbehave the way real ones did, each run
 * under nightshift with the limit that should catch it. A case passes only
 * if the report says what happened *and* nothing is left running.
 *
 * A case may declare itself not applicable on the machine it runs on (the
 * cgroup net exists only on Linux, and not on every Linux). It is then
 * reported as n/a with the reason, its leftovers are cleaned up rather than
 * counted, and it does not fail the suite.
 *
 *   bun run crashtest            run every case
 *   bun run crashtest <name>     run one
 *   bun run crashtest --list     print the cases table without running
 *
 * CASES is the single source for the scoreboard in docs/CASES.md and the
 * count in the README; `bun scripts/cases.ts --check` keeps them in step.
 * Every case says what catches it and where it came from, because a suite
 * that cannot explain itself is a list of tests, not a record of failures.
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
  notes: string[];
}

/** Where a case came from. New cases from the issue tracker use `issue #N`. */
export type Origin = "incident" | "design" | "review" | "red team" | `issue #${number}`;

export interface Case {
  name: string;
  /** What the agent does, in a few words; the second column of the scoreboard. */
  failure: string;
  /** What stops it: the flag, the net, or the mechanism. */
  caught: string;
  origin: Origin;
  /** null: run a command that does not exist */
  agent: string | null;
  limits: string[];
  env?: Record<string, string>;
  during?: (ctx: { home: string; cwd: string }) => Promise<void>;
  /** Why this machine cannot exercise the case, read from the report; null means judge it. */
  notApplicable?: (r: Report) => string | null;
  expect: (r: Report, exitCode: number | null) => string | null;
  /** The line to print for a pass, when the generic one would not say enough. */
  detail?: (r: Report) => string;
}

const killedBy = (guard: string) => (r: Report, code: number | null) =>
  r.outcome !== "killed" ? `outcome ${r.outcome}, wanted killed` :
  r.kill?.guard !== guard ? `killed by ${r.kill?.guard}, wanted ${guard}` :
  r.survivors.length ? `survivors ${r.survivors.join(",")}` :
  code !== 2 ? `exit code ${code}, wanted 2` : null;

export const CASES: Case[] = [
  {
    name: "hang",
    failure: "goes silent forever",
    caught: "`--idle-timeout`",
    origin: "incident",
    agent: "hang.ts",
    limits: ["--idle-timeout", "2s", "--max-runtime", "30s"],
    expect: killedBy("idle-timeout"),
  },
  {
    name: "runaway",
    failure: "never finishes",
    caught: "`--max-runtime`",
    origin: "design",
    agent: "runaway.ts",
    limits: ["--max-runtime", "2s"],
    expect: killedBy("max-runtime"),
  },
  {
    name: "ignore-sigterm",
    failure: "traps SIGTERM",
    caught: "`--max-runtime`, escalates to SIGKILL",
    origin: "design",
    agent: "ignore-sigterm.ts",
    limits: ["--max-runtime", "2s", "--grace", "1s"],
    expect: (r, code) => killedBy("max-runtime")(r, code) ?? (r.kill?.escalatedToSigkill ? null : "did not escalate to SIGKILL"),
  },
  {
    name: "fast-orphan",
    failure: "detaches a child, exits in 60ms",
    caught: "descendant walk on the output chunk, then the orphan sweep",
    origin: "review",
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
    caught: "grace measured from the SIGTERM, then SIGKILL for the worker",
    origin: "review",
    agent: "wrapper-shell.sh",
    limits: ["--max-runtime", "2s", "--grace", "1s"],
    expect: (r, code) => killedBy("max-runtime")(r, code) ?? (r.kill?.escalatedToSigkill ? null : "did not escalate to SIGKILL"),
  },
  {
    name: "spawn-fail",
    failure: "command does not exist",
    caught: "outcome `failed`, exit 127 in the report, report still written",
    origin: "review",
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
    caught: "the stray check: new since spawn, re-parented to init, cwd is the run's",
    origin: "red team",
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
    caught: "second SIGKILL wave, then the stray check",
    origin: "red team",
    agent: "grace-spawner.ts",
    limits: ["--max-runtime", "2s", "--grace", "2s"],
    expect: killedBy("max-runtime"),
  },
  {
    name: "unpriced-model",
    failure: "spends on a model with no price",
    caught: "`--budget`, counted at the ceiling price",
    origin: "red team",
    agent: "budget-blower.ts",
    env: { CRASH_MODEL: "claude-zorp-9" },
    limits: ["--adapter", "claude", "--budget", "2usd", "--max-runtime", "30s"],
    expect: killedBy("budget"),
  },
  {
    name: "noeol-stream",
    failure: "one huge event, no newline",
    caught: "`--max-tokens`, a complete object is parsed without waiting for a newline",
    origin: "red team",
    agent: "noeol-stream.ts",
    limits: ["--adapter", "claude", "--max-tokens", "300k", "--max-runtime", "30s"],
    expect: killedBy("max-tokens"),
  },
  {
    name: "orphan",
    failure: "detaches a child, exits 0",
    caught: "orphan sweep after exit",
    origin: "design",
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
    caught: "`--idle-timeout`, the whole group dies",
    origin: "design",
    agent: "fork-bomb-lite.ts",
    limits: ["--idle-timeout", "2s"],
    expect: killedBy("idle-timeout"),
  },
  {
    name: "disk-filler",
    failure: "fills the disk",
    caught: "`--max-disk-growth --watch .`",
    origin: "incident",
    agent: "disk-filler.ts",
    limits: ["--max-disk-growth", "30mb", "--watch", ".", "--max-runtime", "30s"],
    expect: killedBy("max-disk-growth"),
  },
  {
    name: "output-flood",
    failure: "floods stdout",
    caught: "`--max-output`, checked per chunk",
    origin: "incident",
    agent: "output-flood.ts",
    limits: ["--max-output", "8mb", "--max-runtime", "30s"],
    expect: killedBy("max-output"),
  },
  {
    name: "budget-blower",
    failure: "spends without limit",
    caught: "`--budget`, per-message dedupe",
    origin: "design",
    agent: "budget-blower.ts",
    limits: ["--adapter", "claude", "--budget", "2usd", "--max-runtime", "30s"],
    expect: (r, code) =>
      killedBy("budget")(r, code) ??
      (r.usage.estimatedUsd > 3 ? `estimate ${r.usage.estimatedUsd} suggests duplicate events were double-counted` : null),
  },
  {
    name: "token-blower",
    failure: "burns tokens",
    caught: "`--max-tokens`",
    origin: "design",
    agent: "budget-blower.ts",
    limits: ["--adapter", "claude", "--max-tokens", "300k", "--max-runtime", "30s"],
    expect: killedBy("max-tokens"),
  },
  {
    name: "send-loop",
    failure: "sends 21 messages",
    caught: "ledger: 5 allowed, 16 refused",
    origin: "incident",
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
    caught: "`nightshift stop latest` from the harness",
    origin: "design",
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
    caught: "`--require`, exit code 3",
    origin: "incident",
    agent: "postcondition.ts",
    limits: ["--require", "out.json"],
    expect: (r, code) =>
      r.outcome !== "postcondition-failed" ? `outcome ${r.outcome}` : code !== 3 ? `exit code ${code}, wanted 3` : null,
  },
  {
    name: "stdin-waiter",
    failure: "waits for a keyboard",
    caught: "stdin is closed by default, exits at once",
    origin: "design",
    agent: "stdin-waiter.ts",
    limits: ["--max-runtime", "10s"],
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}` : r.durationMs > 5000 ? `took ${r.durationMs}ms; stdin was not closed` : null,
  },
  {
    name: "cgroup-escape",
    failure: "setsid, env {}, cwd /, silent exit",
    caught: "the cgroup net (Linux only)",
    origin: "red team",
    agent: "cgroup-escape.ts",
    limits: ["--max-runtime", "20s"],
    notApplicable: (r) =>
      process.platform !== "linux" ? "not linux, no cgroup net; the escape works here, which is the documented gap" :
      cgroupNote(r).startsWith("cgroup net: unavailable") ? `${cgroupNote(r)}; the escape works here` : null,
    expect: (r) =>
      r.outcome !== "completed" ? `outcome ${r.outcome}, wanted completed` :
      !cgroupNote(r).startsWith("cgroup net: active") ? `report note "${cgroupNote(r)}" is neither active nor unavailable` :
      !r.orphans?.found.length ? "escapee was not noticed" :
      r.survivors.length ? `survivors ${r.survivors.join(",")}` : null,
    detail: (r) => `${cgroupNote(r)}; caught ${r.orphans?.found.length} escapee`,
  },
];

function cgroupNote(r: Report): string {
  return r.notes.find((n) => n.startsWith("cgroup net:")) ?? "";
}

async function runCase(c: Case): Promise<{ ok: boolean; na?: boolean; detail: string; ms: number }> {
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
  const na = c.notApplicable?.(report) ?? null;
  if (na !== null) {
    // Whatever the case left behind is expected here; clean it up, do not count it.
    await sleep(300);
    for (const leak of leakedProcesses(agent, cwd)) signalQuietly(leak);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    return { ok: true, na: true, detail: `n/a: ${na}`, ms };
  }
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
  return { ok: true, detail: c.detail ? c.detail(report) : describe(report), ms };
}

function leakedProcesses(agent: string, cwd: string): string[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => (l.includes(agent) || l.includes(cwd) || /\bsleep 4[234]4[23]\b/.test(l)) && !/^\s*\d+\s+\d+\s+Z/.test(l))
    .map((l) => l.trim().slice(0, 100));
}

/** SIGKILL the pid at the head of a leakedProcesses() row. */
function signalQuietly(row: string): void {
  const pid = Number(row.split(/\s+/)[0]);
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
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

/**
 * The scoreboard table. With `added`, a column saying which commit brought
 * each case in; without it, the four columns `--list` prints. `origin` lets
 * the caller turn "issue #12" into a link.
 */
export function casesTable(cases: Case[], opts: { added?: Map<string, string>; origin?: (origin: Origin) => string } = {}): string {
  const { added, origin = (o) => o } = opts;
  const head = ["Case", "What the agent does", "Caught by", ...(added ? ["Added in"] : []), "Origin"];
  const rows = cases.map((c) => [
    `\`${c.name}\``,
    c.failure,
    c.caught,
    ...(added ? [added.get(c.name) ?? "unknown"] : []),
    origin(c.origin),
  ]);
  return [head, head.map(() => "---"), ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only === "--list") {
    console.log(`${casesTable(CASES)}\n\n${CASES.length} cases`);
    return;
  }
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  console.log(`nightshift crash suite · ${cases.length} failure modes\n`);
  let caught = 0;
  let skipped = 0;
  const rows: string[] = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.name.padEnd(16)} ${c.failure.padEnd(36)} `);
    const r = await runCase(c);
    if (r.na) skipped += 1;
    else if (r.ok) caught += 1;
    const mark = r.na ? "➖" : r.ok ? "✅" : "❌";
    console.log(`${mark} ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
    rows.push(`| ${c.name} | ${c.failure} | ${mark} ${r.detail} |`);
  }
  const judged = cases.length - skipped;
  console.log(`\n${caught}/${judged} failure modes caught${skipped ? `, ${skipped} n/a on this machine` : ""}\n`);
  if (process.env.CRASHTEST_MARKDOWN) console.log(["| case | failure | result |", "|---|---|---|", ...rows].join("\n"));
  process.exit(caught === judged ? 0 : 1);
}

if (import.meta.main) void main();
