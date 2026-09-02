/**
 * The command line as a user meets it: --help must name what the code reads
 * from the environment, and the unmetered-budget refusal must name every
 * adapter a script can be forced onto, not just the first one written.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTERS } from "../src/meters/index";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(ROOT, "src", "cli.ts");

function nightshift(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 20_000 });
}

describe("--help", () => {
  const help = nightshift(["--help"]);
  test("has an ENVIRONMENT block naming the variables the code reads and the ones the agent receives", () => {
    expect(help.status).toBe(0);
    const block = help.stdout.split("ENVIRONMENT\n")[1]?.split("\n\n")[0] ?? "";
    for (const name of ["NIGHTSHIFT_HOME", "NIGHTSHIFT_PRICES", "NIGHTSHIFT_RUN_ID", "NIGHTSHIFT_RUN_DIR", "NIGHTSHIFT_TELEGRAM_TOKEN", "NIGHTSHIFT_WEBHOOK"]) {
      expect(block).toContain(name);
    }
  });
  test("lists every registered adapter", () => {
    for (const a of ADAPTERS) expect(help.stdout).toMatch(new RegExp(`^ADAPTERS .*\\b${a.name}\\b`, "m"));
  });
});

describe("run --budget on an unmetered command", () => {
  test("refuses with exit 64 and names every adapter it could be forced onto", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-cli-test-"));
    try {
      const r = nightshift(["run", "--budget", "1usd", "--", "./no-such-agent"], { NIGHTSHIFT_HOME: home });
      expect(r.status).toBe(64);
      expect(r.stderr).toContain(`--adapter ${ADAPTERS.map((a) => a.name).join("|")}`);
      expect(r.stderr).toContain("--allow-unmetered");
      expect(r.stderr).not.toContain("Claude Code under another name");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
