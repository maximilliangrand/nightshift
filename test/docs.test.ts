/**
 * The documentation has drifted from the code before: an adapter added to the
 * registry that the adapter page never mentioned, a net added to the README
 * that a doc still counted as four. These hold the prose to the code.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ADAPTERS } from "../src/meters/index";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("adapters", () => {
  test("docs/ADAPTERS.md names every registered adapter and links the OpenClaw page", () => {
    const doc = read("docs/ADAPTERS.md");
    for (const a of ADAPTERS) expect(doc).toContain(`\`${a.name}\``);
    expect(doc).toContain("](ADAPTERS-openclaw.md)");
    expect(doc).not.toContain("both adapters");
  });
  test("docs/CRASHTEST.md lists a meter test for every adapter, and each exists", () => {
    const doc = read("docs/CRASHTEST.md");
    for (const a of ADAPTERS) {
      const file = `test/${a.name}-meter.test.ts`;
      expect(doc).toContain(`\`${file}\``);
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    }
  });
  test("README says events.jsonl is written for every metered command", () => {
    expect(read("README.md")).toContain("for metered commands (Claude Code, Codex, OpenClaw), the raw `events.jsonl`");
  });
});

describe("nets and the crash suite", () => {
  test("docs/CGROUP.md counts the README's nets the way the README does", () => {
    const doc = read("docs/CGROUP.md");
    expect(doc).toContain("The first four nets in the README");
    expect(doc).not.toContain("describes four nets");
    expect(read("README.md")).toContain("casts five nets");
  });
  test("README marks the suite sample as abridged and explains the n/a line against the badge", () => {
    const readme = read("README.md");
    const intro = readme.indexOf("(paths abridged)");
    const sample = readme.indexOf("nightshift crash suite ·");
    expect(intro).toBeGreaterThan(-1);
    expect(intro).toBeLessThan(sample);
    expect(readme).toContain("The badge counts cases");
    expect(readme).toContain("23/23 with 1 n/a while Linux prints 24/24");
  });
});

describe("environment", () => {
  test("README design notes name NIGHTSHIFT_HOME and NIGHTSHIFT_RUN_DIR", () => {
    const notes = read("README.md").split("## Design notes")[1]?.split("\n## ")[0] ?? "";
    expect(notes).toContain("`NIGHTSHIFT_HOME`");
    expect(notes).toContain("`NIGHTSHIFT_RUN_DIR`");
  });
});

describe(".github", () => {
  test("the issue form's version placeholder is the current version", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(read(".github/ISSUE_TEMPLATE/failure-mode.yml")).toContain(`placeholder: ${pkg.version} under node`);
  });
  test("ci runs on pushes to main only, on pull requests and by hand", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("on:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n");
  });
});
