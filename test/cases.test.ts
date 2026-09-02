/**
 * The scoreboard tooling: the README count, the docs table and the history
 * line are projections of CASES in crashtest/run.ts, and --check must say
 * precisely what drifted.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CASES, casesTable, type Case } from "../crashtest/run";
import { addedIn, historyLine, parseCaseNames, renderTable, syncCasesDoc, syncReadme, tableProblems, validateCases, withoutCommitIds } from "../scripts/cases";

const ROOT = path.resolve(import.meta.dir, "..");
const REPO = "https://github.com/x/y";

const sample = (over: Partial<Case>): Case => ({
  name: "hang",
  failure: "goes silent forever",
  caught: "`--idle-timeout`",
  origin: "incident",
  agent: "hang.ts",
  limits: [],
  expect: () => null,
  ...over,
});

describe("parseCaseNames", () => {
  test("reads names in file order and ignores the interface", () => {
    const src = `interface Case {\n  name: string;\n}\nconst CASES = [\n  {\n    name: "hang",\n    failure: "x",\n  },\n  {\n    name: "runaway",\n  },\n];\n`;
    expect(parseCaseNames(src)).toEqual(["hang", "runaway"]);
  });
  test("agrees with the exported CASES on the real file", async () => {
    const src = await Bun.file(path.join(ROOT, "crashtest", "run.ts")).text();
    expect(parseCaseNames(src)).toEqual(CASES.map((c) => c.name));
  });
});

describe("addedIn / historyLine", () => {
  const history = [
    { sha: "aaaaaaa", version: "0.1.0", names: ["hang", "runaway"] },
    { sha: "bbbbbbb", version: "0.1.0", names: ["hang", "runaway", "orphan"] },
    { sha: "ccccccc", version: "0.1.0", names: ["hang", "runaway", "orphan"] },
    { sha: "ddddddd", version: "0.2.0", names: ["hang", "runaway", "orphan", "flood"] },
  ];
  test("first commit wins, uncommitted cases are pending at the current version", () => {
    const added = addedIn(history, ["hang", "orphan", "flood", "fresh"], "0.2.0");
    expect(added.get("hang")).toEqual({ version: "0.1.0", sha: "aaaaaaa" });
    expect(added.get("orphan")).toEqual({ version: "0.1.0", sha: "bbbbbbb" });
    expect(added.get("flood")).toEqual({ version: "0.2.0", sha: "ddddddd" });
    expect(added.get("fresh")).toEqual({ version: "0.2.0", sha: null });
  });
  test("collapses unchanged counts within a version and appends the working tree", () => {
    expect(historyLine(history, 4, "0.2.0")).toBe("v0.1.0: 2 → 3; v0.2.0: 4");
    expect(historyLine(history, 5, "0.2.0")).toBe("v0.1.0: 2 → 3; v0.2.0: 4 → 5");
    expect(historyLine(history, 5, "0.3.0")).toBe("v0.1.0: 2 → 3; v0.2.0: 4; v0.3.0: 5");
  });
  test("a new version starts with the count it inherited", () => {
    expect(historyLine(history.slice(0, 2), 3, "0.2.0")).toBe("v0.1.0: 2 → 3; v0.2.0: 3");
  });
});

describe("tables", () => {
  test("--list shape has four columns, the scoreboard five with commit links", () => {
    const cases = [sample({}), sample({ name: "fresh", origin: "issue #12", agent: null })];
    const short = casesTable(cases).split("\n");
    expect(short[0]).toBe("| Case | What the agent does | Caught by | Origin |");
    expect(short[2]).toBe("| `hang` | goes silent forever | `--idle-timeout` | incident |");
    const added = new Map([
      ["hang", { version: "0.1.0", sha: "abc1234" }],
      ["fresh", { version: "0.1.0", sha: null }],
    ]);
    const long = renderTable(cases, added, REPO).split("\n");
    expect(long[0]).toBe("| Case | What the agent does | Caught by | Added in | Origin |");
    expect(long[2]).toContain("| v0.1.0, [abc1234](https://github.com/x/y/commit/abc1234) | incident |");
    expect(long[3]).toContain("| v0.1.0, pending | [issue #12](https://github.com/x/y/issues/12) |");
  });
  test("commit ids and pending are equivalent for --check", () => {
    const a = "| `hang` | v0.1.0, [abc1234](https://github.com/x/y/commit/abc1234) |";
    const b = "| `hang` | v0.1.0, pending |";
    expect(withoutCommitIds(a)).toBe(withoutCommitIds(b));
    expect(withoutCommitIds(a)).not.toBe(withoutCommitIds(a.replace("v0.1.0", "v0.2.0")));
  });
  test("tableProblems names the case, not the line", () => {
    const want = renderTable([sample({}), sample({ name: "runaway", failure: "never finishes" })], new Map([["hang", { version: "0.1.0", sha: "abc1234" }], ["runaway", { version: "0.1.0", sha: null }]]), REPO);
    const have = want.split("\n").filter((l) => !l.includes("`runaway`")).join("\n") + "\n| `ghost` | x | y | z | design |";
    const problems = tableProblems(have, want);
    expect(problems.some((p) => p.includes('no row for "runaway"'))).toBe(true);
    expect(problems.some((p) => p.includes('row "ghost" has no case'))).toBe(true);
    expect(tableProblems(want, want)).toEqual([]);
    const moved = want.replace("[abc1234](https://github.com/x/y/commit/abc1234)", "pending");
    expect(tableProblems(moved, want)).toEqual([]);
  });
});

describe("validateCases", () => {
  const agents = path.join(ROOT, "crashtest", "agents");
  test("the real suite is valid", () => {
    expect(validateCases(CASES, agents)).toEqual([]);
  });
  test("rejects a bad origin, a missing agent, an empty caught and a duplicate name", () => {
    const problems = validateCases(
      [sample({}), sample({ origin: "guess" as Case["origin"] }), sample({ name: "x", agent: "nope.ts" }), sample({ name: "y", caught: " " })],
      agents,
    );
    expect(problems.some((p) => p.includes("listed twice"))).toBe(true);
    expect(problems.some((p) => p.includes('origin "guess"'))).toBe(true);
    expect(problems.some((p) => p.includes("missing agent nope.ts"))).toBe(true);
    expect(problems.some((p) => p.includes('"y" does not say what catches it'))).toBe(true);
  });
});

describe("syncReadme", () => {
  const readme = [
    "[![ci](x)](y)",
    "[![crash suite](https://img.shields.io/badge/crash_suite-20%2F20_failure_modes_caught-2ea44f)](docs/CRASHTEST.md) <!-- cases:badge -->",
    "runs <!-- cases:count -->20<!-- /cases:count --> broken cases; 20/20 in the sample below stays",
  ].join("\n");
  test("edits only the marked spans", () => {
    const { text, problems } = syncReadme(readme, 21);
    expect(problems).toEqual(["README.md badge: have crash_suite-20%2F20_failure_modes_caught, want crash_suite-21%2F21_failure_modes_caught", "README.md count sentence: have 20, want 21"]);
    expect(text).toContain("crash_suite-21%2F21_failure_modes_caught-2ea44f)](docs/CRASHTEST.md) <!-- cases:badge -->");
    expect(text).toContain("runs <!-- cases:count -->21<!-- /cases:count --> broken cases; 20/20 in the sample below stays");
  });
  test("is silent when in step and loud when markers are missing", () => {
    expect(syncReadme(readme, 20)).toEqual({ text: readme, problems: [] });
    expect(syncReadme("no markers here", 20).problems.length).toBe(2);
  });
});

describe("syncCasesDoc", () => {
  test("fills both spans and reports the stale history", () => {
    const header = "| Case | What the agent does | Caught by | Added in | Origin |\n| --- | --- | --- | --- | --- |";
    const doc = `intro\n\n<!-- cases:table -->\n${header}\n<!-- /cases:table -->\n\n<!-- cases:history -->\nv0.1.0: 1\n<!-- /cases:history -->\nend\n`;
    const table = `${header}\n| \`hang\` | a | b | v0.1.0, pending | design |`;
    const { text, problems } = syncCasesDoc(doc, table, "v0.1.0: 1 → 2");
    expect(problems).toEqual(['docs/CASES.md table: no row for "hang"; want\n  | `hang` | a | b | v0.1.0, pending | design |', 'docs/CASES.md history: have "v0.1.0: 1", want "v0.1.0: 1 → 2"']);
    expect(syncCasesDoc(doc.replace(header, ""), table, "v0.1.0: 1").problems).toEqual(["docs/CASES.md table: empty"]);
    expect(text).toBe(`intro\n\n<!-- cases:table -->\n${table}\n<!-- /cases:table -->\n\n<!-- cases:history -->\nv0.1.0: 1 → 2\n<!-- /cases:history -->\nend\n`);
    expect(syncCasesDoc(text, table, "v0.1.0: 1 → 2").problems).toEqual([]);
  });
});

describe("the repository is in step", () => {
  test("bun scripts/cases.ts --check passes", () => {
    const r = spawnSync("bun", ["scripts/cases.ts", "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${CASES.length} cases`);
  });
  test("bun run crashtest --list prints the table without running anything", () => {
    const r = spawnSync("bun", ["crashtest/run.ts", "--list"], { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().endsWith(`${CASES.length} cases`)).toBe(true);
    for (const c of CASES) expect(r.stdout).toContain(`| \`${c.name}\` |`);
    expect(r.stdout).not.toContain("failure modes caught");
  });
});
