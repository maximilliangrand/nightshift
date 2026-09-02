/**
 * The morning report: what ran, what it cost, what it touched, how it ended.
 * One JSON for machines, one Markdown for the human with the coffee.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UsageTotals } from "./meters/claude.js";
import type { LedgerEntry } from "./ledger.js";
import { fmtBytes, fmtCount, fmtDuration, fmtMoney } from "./units.js";

const execFileAsync = promisify(execFile);

export type Outcome = "completed" | "failed" | "killed" | "postcondition-failed";

export interface GitSnapshot {
  repo: boolean;
  branch?: string;
  head?: string;
  dirtyFiles?: number;
}

export interface GitDelta {
  repo: boolean;
  branch?: string;
  newCommits: string[];
  diffStat?: string;
  untracked: number;
  dirtyFilesBefore?: number;
  dirtyFilesAfter?: number;
}

export interface RunReport {
  id: string;
  name?: string;
  command: string[];
  effectiveCommand: string[];
  cwd: string;
  host: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: Outcome;
  exitCode: number | null;
  signal: string | null;
  failedToStart?: string;
  kill?: { guard: string; reason: string; escalatedToSigkill: boolean };
  orphans?: { found: number[]; survivors: number[] };
  survivors: number[];
  postconditions: Array<{ check: string; ok: boolean; detail?: string }>;
  limits: string[];
  usage: UsageTotals;
  git: GitDelta;
  disk: { freeDeltaBytes: number; watched: Record<string, number> };
  ledger: { claims: number; refused: number; entries: LedgerEntry[] };
  outputBytes: number;
  outputTail: string[];
  notes: string[];
  paths: { dir: string; log: string; events?: string; report: string };
}

export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return { repo: false };
  }
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? undefined;
  const head = (await git(cwd, ["rev-parse", "HEAD"])) ?? undefined;
  const status = await git(cwd, ["status", "--porcelain"]);
  return { repo: true, branch, head, dirtyFiles: status ? status.split("\n").filter(Boolean).length : 0 };
}

export async function gitDelta(cwd: string, before: GitSnapshot): Promise<GitDelta> {
  if (!before.repo) return { repo: false, newCommits: [], untracked: 0 };
  const after = await gitSnapshot(cwd);
  const log = before.head && after.head && before.head !== after.head ? await git(cwd, ["log", "--oneline", `${before.head}..HEAD`]) : "";
  const diffStat = await git(cwd, ["diff", "--stat", "HEAD"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return {
    repo: true,
    branch: after.branch,
    newCommits: log ? log.split("\n").filter(Boolean) : [],
    diffStat: diffStat || undefined,
    untracked: untracked ? untracked.split("\n").filter(Boolean).length : 0,
    dirtyFilesBefore: before.dirtyFiles,
    dirtyFilesAfter: after.dirtyFiles,
  };
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

const OUTCOME_ICON: Record<Outcome, string> = {
  completed: "✅",
  failed: "❌",
  killed: "🛑",
  "postcondition-failed": "⚠️",
};

export function renderMarkdown(r: RunReport): string {
  const lines: string[] = [];
  const title = r.name ? `${r.name} (${r.id})` : r.id;
  lines.push(`# ${OUTCOME_ICON[r.outcome]} nightshift run ${title}`);
  lines.push("");
  lines.push(`**${outcomeSentence(r)}**`);
  lines.push("");
  lines.push(`- Command: \`${r.command.join(" ")}\``);
  lines.push(`- Directory: \`${r.cwd}\` on ${r.host}`);
  lines.push(`- Started ${r.startedAt}, ran ${fmtDuration(r.durationMs)}`);
  lines.push(`- Limits: ${r.limits.length ? r.limits.join("; ") : "none"}`);
  lines.push("");

  lines.push("## Spend");
  lines.push(...spendLines(r.usage));
  lines.push("");

  const toolNames = Object.keys(r.usage.toolCalls);
  if (toolNames.length) {
    lines.push("## What it did");
    const calls = toolNames
      .sort((a, b) => (r.usage.toolCalls[b] ?? 0) - (r.usage.toolCalls[a] ?? 0))
      .map((n) => `${n} ×${r.usage.toolCalls[n]}`)
      .join(", ");
    lines.push(`- Tool calls: ${calls}`);
    if (r.usage.filesWritten.length) {
      lines.push(`- Files written (${r.usage.filesWritten.length}):`);
      for (const f of r.usage.filesWritten.slice(0, 40)) lines.push(`  - \`${f}\``);
      if (r.usage.filesWritten.length > 40) lines.push(`  - … ${r.usage.filesWritten.length - 40} more`);
    }
    if (r.usage.commands.length) {
      lines.push(`- Commands run (${r.usage.commands.length}${r.usage.commands.length >= 200 ? "+" : ""}):`);
      for (const c of r.usage.commands.slice(0, 25)) lines.push(`  - \`${oneLine(c, 110)}\``);
      if (r.usage.commands.length > 25) lines.push(`  - … ${r.usage.commands.length - 25} more in events.jsonl`);
    }
    lines.push("");
  }

  lines.push("## Footprint");
  if (r.git.repo) {
    lines.push(`- Git (${r.git.branch ?? "?"}): ${r.git.newCommits.length} new commit${r.git.newCommits.length === 1 ? "" : "s"}, ${r.git.untracked} untracked file${r.git.untracked === 1 ? "" : "s"}, dirty ${r.git.dirtyFilesBefore ?? 0} → ${r.git.dirtyFilesAfter ?? 0}`);
    for (const c of r.git.newCommits.slice(0, 20)) lines.push(`  - ${c}`);
    if (r.git.diffStat) {
      lines.push("  ```");
      for (const l of r.git.diffStat.split("\n").slice(-12)) lines.push(`  ${l}`);
      lines.push("  ```");
    }
  } else {
    lines.push("- Git: not a repository");
  }
  const diskParts = [`volume ${fmtBytes(-r.disk.freeDeltaBytes)} free space change`];
  for (const [dir, grew] of Object.entries(r.disk.watched)) diskParts.push(`${dir} ${grew >= 0 ? "+" : ""}${fmtBytes(grew)}`);
  lines.push(`- Disk: ${diskParts.join(", ")}`);
  lines.push(`- Output: ${fmtBytes(r.outputBytes)} → \`${r.paths.log}\``);
  if (r.ledger.claims || r.ledger.refused) {
    lines.push(`- Ledger: ${r.ledger.claims} side effect${r.ledger.claims === 1 ? "" : "s"} claimed, ${r.ledger.refused} refused`);
    for (const e of r.ledger.entries.slice(0, 20)) {
      lines.push(`  - ${e.ok ? "✓" : "✗"} ${String(e.meta?.scope ?? "")} ${e.key}${e.refusal ? ` (${e.refusal})` : ""}`);
    }
  }
  if (r.orphans?.found.length) {
    lines.push(`- Orphans: ${r.orphans.found.length} process${r.orphans.found.length === 1 ? "" : "es"} outlived the agent and were killed (${r.orphans.found.join(", ")})`);
  }
  if (r.survivors.length) {
    lines.push(`- **Survivors: pids ${r.survivors.join(", ")} could not be killed. Check them by hand.**`);
  }
  lines.push("");

  if (r.postconditions.length) {
    lines.push("## Postconditions");
    for (const p of r.postconditions) lines.push(`- ${p.ok ? "✓" : "✗"} ${p.check}${p.detail ? ` - ${p.detail}` : ""}`);
    lines.push("");
  }

  if (r.notes.length) {
    lines.push("## Notes");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  if (r.outputTail.length) {
    lines.push("## Last output");
    lines.push("```");
    lines.push(...r.outputTail);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function spendLines(u: UsageTotals): string[] {
  const lines: string[] = [];
  if (u.priceSource === "none" && u.totalTokens === 0) {
    lines.push("- Not metered for this command");
    return lines;
  }
  const model = u.model ? ` on ${u.model}` : "";
  if (u.actualUsd !== undefined) {
    const drift = u.estimatedUsd ? ` (live estimate ${fmtMoney(u.estimatedUsd)})` : "";
    lines.push(`- **${fmtMoney(u.actualUsd)}** reported by the agent${drift}${model}`);
  } else if (u.priceSource === "list") {
    lines.push(`- **~${fmtMoney(u.estimatedUsd)}** estimated from list prices${model} (run did not reach a result event)`);
  } else if (u.priceSource === "ceiling") {
    lines.push(`- **~${fmtMoney(u.estimatedUsd)}** estimated at ceiling prices${model}: no list price for this model, so it was counted at the most expensive rate`);
  } else {
    lines.push(`- Cost unknown: no price for${model || " this model"}`);
  }
  lines.push(
    `- Tokens: ${fmtCount(u.totalTokens)} (${fmtCount(u.inputTokens)} in, ${fmtCount(u.outputTokens)} out, ${fmtCount(u.cacheReadTokens)} cache read, ${fmtCount(u.cacheWriteTokens)} cache write)`,
  );
  lines.push(`- ${u.messages} model messages, ${u.turns || u.messages} turns`);
  if (u.rateLimits?.fiveHour !== undefined || u.rateLimits?.sevenDay !== undefined) {
    const pct = (v?: number) => (v === undefined ? "?" : `${Math.round(v * 100)}%`);
    lines.push(`- Subscription windows after this run: 5h ${pct(u.rateLimits.fiveHour)}, 7d ${pct(u.rateLimits.sevenDay)} used`);
  }
  if (u.terminalReason && u.terminalReason !== "completed") lines.push(`- The agent ended with: ${u.terminalReason}`);
  return lines;
}

export function outcomeSentence(r: RunReport): string {
  switch (r.outcome) {
    case "completed":
      return `Completed in ${fmtDuration(r.durationMs)}, exit 0.`;
    case "failed": {
      const missing = r.postconditions.filter((p) => !p.ok && p.check !== "exited 0").map((p) => p.check);
      const tail = missing.length ? `; also missing: ${missing.join(", ")}` : "";
      if (r.failedToStart) return `Could not start: ${r.failedToStart}.`;
      return `Exited ${r.exitCode ?? r.signal} after ${fmtDuration(r.durationMs)}${tail}.`;
    }
    case "killed":
      return `Killed by ${r.kill?.guard}: ${r.kill?.reason}${r.kill?.escalatedToSigkill ? " (needed SIGKILL)" : ""}.`;
    case "postcondition-failed":
      return `Exited 0 but a postcondition failed: ${r.postconditions.filter((p) => !p.ok).map((p) => p.check).join(", ")}.`;
  }
}

/** Short form for a phone notification. */
export function renderShort(r: RunReport): string {
  const u = r.usage;
  const spend =
    u.actualUsd !== undefined
      ? fmtMoney(u.actualUsd)
      : u.priceSource === "list"
        ? `~${fmtMoney(u.estimatedUsd)}`
        : u.priceSource === "ceiling"
          ? `~${fmtMoney(u.estimatedUsd)} (ceiling)`
          : "unmetered";
  const lines = [
    `${OUTCOME_ICON[r.outcome]} nightshift ${r.name ?? r.id}`,
    outcomeSentence(r),
    `${spend} · ${fmtCount(u.totalTokens)} tokens · ${fmtDuration(r.durationMs)}`,
  ];
  if (u.filesWritten.length) lines.push(`${u.filesWritten.length} files written`);
  if (r.git.repo && r.git.newCommits.length) lines.push(`${r.git.newCommits.length} commits on ${r.git.branch}`);
  if (r.ledger.claims || r.ledger.refused) lines.push(`ledger: ${r.ledger.claims} claimed, ${r.ledger.refused} refused`);
  if (r.survivors.length) lines.push(`⚠️ survivors: ${r.survivors.join(", ")}`);
  const failed = r.postconditions.filter((p) => !p.ok);
  if (failed.length) lines.push(`✗ ${failed.map((p) => p.check).join(", ")}`);
  lines.push(`${r.cwd} → ${r.paths.report}`);
  return lines.join("\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
