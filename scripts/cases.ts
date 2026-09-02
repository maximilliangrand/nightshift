/**
 * Keeps the scoreboard honest. CASES in crashtest/run.ts is the source; this
 * script projects it into the README badge and count sentence and into the
 * table and history line of docs/CASES.md, and refuses when they disagree.
 *
 *   bun scripts/cases.ts --check    exit 1 and say what to change
 *   bun scripts/cases.ts --write    update the files in place
 *
 * "Added in" comes from git: the first commit of crashtest/run.ts that names
 * the case, and the package.json version at that commit. A case that is not
 * committed yet is "pending". --check compares versions, not commit ids, so
 * a squash or a rebase on the way to main does not turn the scoreboard red;
 * the next --write refreshes the ids.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CASES, casesTable, type Case } from "../crashtest/run.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const RUN_TS = "crashtest/run.ts";
const MAX_AGENT_LINES = 20;
const ORIGIN = /^(incident|design|review|red team|issue #\d+)$/;

export interface Snapshot {
  sha: string;
  version: string;
  names: string[];
}

export interface Added {
  version: string;
  /** null: not in any commit yet */
  sha: string | null;
}

/** The case names in one version of crashtest/run.ts, in file order. */
export function parseCaseNames(source: string): string[] {
  return [...source.matchAll(/^\s+name: "([^"]+)",$/gm)].map((m) => m[1] as string);
}

/** Every commit that touched crashtest/run.ts, oldest first, with what it contained. */
export function gitSnapshots(root: string): Snapshot[] {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const shas = git(["log", "--reverse", "--format=%h", "--", RUN_TS]).trim().split("\n").filter(Boolean);
  return shas.map((sha) => {
    const pkg = JSON.parse(git(["show", `${sha}:package.json`])) as { version: string };
    return { sha, version: pkg.version, names: parseCaseNames(git(["show", `${sha}:${RUN_TS}`])) };
  });
}

export function addedIn(history: Snapshot[], current: string[], currentVersion: string): Map<string, Added> {
  const added = new Map<string, Added>();
  for (const snap of history) {
    for (const name of snap.names) if (!added.has(name)) added.set(name, { version: snap.version, sha: snap.sha });
  }
  for (const name of current) if (!added.has(name)) added.set(name, { version: currentVersion, sha: null });
  return added;
}

/**
 * "v0.1.0: 13 → 16 → 20; v0.2.0: 20 → 22". A version starts with the count it
 * inherited; within a version only changes are listed. The working tree is
 * the last entry, so an uncommitted case already shows.
 */
export function historyLine(history: Snapshot[], currentCount: number, currentVersion: string): string {
  const steps = [...history.map((s) => ({ version: s.version, count: s.names.length })), { version: currentVersion, count: currentCount }];
  const byVersion: Array<{ version: string; counts: number[] }> = [];
  for (const step of steps) {
    const last = byVersion[byVersion.length - 1];
    if (last && last.version === step.version) {
      if (last.counts[last.counts.length - 1] !== step.count) last.counts.push(step.count);
    } else {
      byVersion.push({ version: step.version, counts: [step.count] });
    }
  }
  return byVersion.map((v) => `v${v.version}: ${v.counts.join(" → ")}`).join("; ");
}

export function renderTable(cases: Case[], added: Map<string, Added>, repoUrl: string): string {
  const cells = new Map<string, string>();
  for (const [name, a] of added) {
    cells.set(name, a.sha ? `v${a.version}, [${a.sha}](${repoUrl}/commit/${a.sha})` : `v${a.version}, pending`);
  }
  const origin = (o: string) => {
    const issue = /^issue #(\d+)$/.exec(o);
    return issue ? `[${o}](${repoUrl}/issues/${issue[1]})` : o;
  };
  return casesTable(cases, { added: cells, origin });
}

/** What is wrong with the cases themselves, before any file is compared. */
export function validateCases(cases: Case[], agentsDir: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) problems.push(`${RUN_TS}: case "${c.name}" is listed twice`);
    seen.add(c.name);
    if (!c.caught.trim()) problems.push(`${RUN_TS}: case "${c.name}" does not say what catches it (caught)`);
    if (!ORIGIN.test(c.origin)) problems.push(`${RUN_TS}: case "${c.name}" has origin "${c.origin}"; use incident, design, review, red team or issue #N`);
    if (c.agent === null) continue;
    const agent = path.join(agentsDir, c.agent);
    if (!fs.existsSync(agent)) {
      problems.push(`${RUN_TS}: case "${c.name}" names a missing agent ${c.agent}`);
      continue;
    }
    const lines = fs.readFileSync(agent, "utf8").split("\n").filter((l) => l.trim()).length;
    if (lines > MAX_AGENT_LINES) problems.push(`crashtest/agents/${c.agent}: ${lines} lines, keep an agent at or under ${MAX_AGENT_LINES}`);
  }
  return problems;
}

/** Rewrite one marked span; the caller decides what goes inside. */
function replaceSpan(text: string, marker: string, inner: string): { text: string; found: boolean } {
  const re = new RegExp(`(<!-- ${marker} -->)[\\s\\S]*?(<!-- /${marker} -->)`);
  if (!re.test(text)) return { text, found: false };
  return { text: text.replace(re, `$1${inner}$2`), found: true };
}

function spanContent(text: string, marker: string): string | null {
  const m = new RegExp(`<!-- ${marker} -->([\\s\\S]*?)<!-- /${marker} -->`).exec(text);
  return m ? (m[1] as string).trim() : null;
}

const BADGE = /crash_suite-\d+%2F\d+_failure_modes_caught/;

/** The README carries the count twice: in the badge URL and in the sentence about the suite. */
export function syncReadme(text: string, count: number): { text: string; problems: string[] } {
  const problems: string[] = [];
  const lines = text.split("\n");
  const badge = lines.findIndex((l) => l.includes("<!-- cases:badge -->"));
  const wantBadge = `crash_suite-${count}%2F${count}_failure_modes_caught`;
  if (badge === -1 || !BADGE.test(lines[badge] ?? "")) {
    problems.push("README.md: no badge line marked <!-- cases:badge --> with a crash_suite-N%2FN_failure_modes_caught URL");
  } else if (!(lines[badge] as string).includes(wantBadge)) {
    const have = BADGE.exec(lines[badge] as string)?.[0];
    problems.push(`README.md badge: have ${have}, want ${wantBadge}`);
    lines[badge] = (lines[badge] as string).replace(BADGE, wantBadge);
  }
  const joined = lines.join("\n");
  const have = spanContent(joined, "cases:count");
  if (have === null) problems.push("README.md: no <!-- cases:count -->N<!-- /cases:count --> span");
  else if (have !== String(count)) problems.push(`README.md count sentence: have ${have}, want ${count}`);
  return { text: replaceSpan(joined, "cases:count", String(count)).text, problems };
}

/** Commit ids move under squash and rebase; the version is what --check holds people to. */
export function withoutCommitIds(text: string): string {
  return text.replace(/\[[0-9a-f]{7,40}\]\([^)]*\/commit\/[0-9a-f]+\)/g, "commit").replace(/\bpending\b/g, "commit");
}

/** Rows keyed by the case name in the first cell; the header and rule are not rows. */
function tableRows(table: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of table.split("\n")) {
    const m = /^\| `([^`]+)` \|/.exec(line);
    if (m) rows.set(m[1] as string, line);
  }
  return rows;
}

/** Which rows of the scoreboard differ, by case, so the message names the case rather than a line number. */
export function tableProblems(have: string, want: string): string[] {
  if (!have.trim()) return ["docs/CASES.md table: empty"];
  const problems: string[] = [];
  const haveRows = tableRows(have);
  const wantRows = tableRows(want);
  const haveHeader = have.split("\n").slice(0, 2).join("\n");
  const wantHeader = want.split("\n").slice(0, 2).join("\n");
  if (haveHeader !== wantHeader) problems.push("docs/CASES.md table: header differs");
  for (const [name, row] of wantRows) {
    const current = haveRows.get(name);
    if (current === undefined) problems.push(`docs/CASES.md table: no row for "${name}"; want\n  ${row}`);
    else if (withoutCommitIds(current) !== withoutCommitIds(row)) problems.push(`docs/CASES.md table: row "${name}" differs; want\n  ${row}`);
  }
  for (const name of haveRows.keys()) if (!wantRows.has(name)) problems.push(`docs/CASES.md table: row "${name}" has no case in ${RUN_TS}; remove it`);
  if (haveRows.size === wantRows.size && [...haveRows.keys()].join() !== [...wantRows.keys()].join() && !problems.length) {
    problems.push("docs/CASES.md table: rows are in a different order from CASES");
  }
  return problems;
}

export function syncCasesDoc(text: string, table: string, history: string): { text: string; problems: string[] } {
  const problems: string[] = [];
  const haveTable = spanContent(text, "cases:table");
  if (haveTable === null) problems.push("docs/CASES.md: no <!-- cases:table --> span");
  else problems.push(...tableProblems(haveTable, table));
  const haveHistory = spanContent(text, "cases:history");
  if (haveHistory === null) problems.push("docs/CASES.md: no <!-- cases:history --> span");
  else if (haveHistory !== history) problems.push(`docs/CASES.md history: have "${haveHistory}", want "${history}"`);
  const tabled = replaceSpan(text, "cases:table", `\n${table}\n`).text;
  return { text: replaceSpan(tabled, "cases:history", `\n${history}\n`).text, problems };
}

interface Sync {
  /** What is wrong with the cases themselves; --write refuses while any of these stand. */
  invalid: string[];
  /** What is out of date in the files; --write fixes these. */
  stale: string[];
  files: Array<{ file: string; text: string }>;
}

function sync(): Sync {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string; repository: { url: string } };
  const repoUrl = pkg.repository.url.replace(/\.git$/, "");
  const invalid = validateCases(CASES, path.join(ROOT, "crashtest", "agents"));
  const names = CASES.map((c) => c.name);
  const parsed = parseCaseNames(fs.readFileSync(path.join(ROOT, RUN_TS), "utf8"));
  if (parsed.join(",") !== names.join(",")) invalid.push(`${RUN_TS}: the source parser sees ${parsed.length} cases, the module exports ${names.length}`);

  const history = gitSnapshots(ROOT);
  const table = renderTable(CASES, addedIn(history, names, pkg.version), repoUrl);
  const line = historyLine(history, CASES.length, pkg.version);

  const readme = syncReadme(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), CASES.length);
  const doc = syncCasesDoc(fs.readFileSync(path.join(ROOT, "docs", "CASES.md"), "utf8"), table, line);
  return {
    invalid,
    stale: [...readme.problems, ...doc.problems],
    files: [
      { file: "README.md", text: readme.text },
      { file: "docs/CASES.md", text: doc.text },
    ],
  };
}

function check(): number {
  const { invalid, stale } = sync();
  if (!invalid.length && !stale.length) {
    console.log(`${CASES.length} cases; README.md and docs/CASES.md are in step`);
    return 0;
  }
  console.error([...invalid, ...stale].join("\n"));
  if (stale.length) console.error("\nfix with: bun scripts/cases.ts --write");
  return 1;
}

function write(): number {
  const { invalid, files } = sync();
  if (invalid.length) {
    console.error(invalid.join("\n"));
    return 1;
  }
  for (const { file, text } of files) {
    const target = path.join(ROOT, file);
    if (fs.readFileSync(target, "utf8") === text) continue;
    fs.writeFileSync(target, text);
    console.log(`updated ${file}`);
  }
  console.log(`${CASES.length} cases`);
  return 0;
}

function main(): void {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--check") process.exit(check());
  if (mode === "--write") process.exit(write());
  console.error("usage: bun scripts/cases.ts --check | --write");
  process.exit(64);
}

if (import.meta.main) main();
