/**
 * Regressions for what the red team found. Each test is one attack that
 * worked once and must not work again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, type HookRule } from "../src/hook";
import { claim, normalizeKey, summarize } from "../src/ledger";
import { ClaudeStreamMeter } from "../src/meters/claude";
import { redact } from "../src/redact";
import { parseStarted } from "../src/supervisor";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-redteam-"));
  process.env.NIGHTSHIFT_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.NIGHTSHIFT_HOME;
});

describe("budget is never blind", () => {
  test("an unpriced model is counted at the ceiling price", () => {
    const meter = new ClaudeStreamMeter();
    const event = {
      type: "assistant",
      message: { id: "m1", model: "claude-zorp-9", usage: { input_tokens: 1_000_000, output_tokens: 0 }, content: [] },
    };
    meter.feed(JSON.stringify(event) + "\n");
    expect(meter.totals.estimatedUsd).toBe(10);
    expect(meter.totals.priceSource).toBe("ceiling");
  });

  test("a complete event without a trailing newline is counted at once", () => {
    const meter = new ClaudeStreamMeter();
    const event = { type: "assistant", message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 900_000, output_tokens: 0 }, content: [] } };
    meter.feed(JSON.stringify(event));
    expect(meter.totals.totalTokens).toBe(900_000);
  });

  test("a partial event is not counted until it completes", () => {
    const meter = new ClaudeStreamMeter();
    const line = JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 0 }, content: [] } });
    meter.feed(line.slice(0, -3));
    expect(meter.totals.totalTokens).toBe(0);
    meter.feed(line.slice(-3));
    expect(meter.totals.totalTokens).toBe(5);
  });
});

describe("ledger keys", () => {
  test("whitespace variants of a key are the same send", async () => {
    expect((await claim({ scope: "s", key: "listing-1" })).ok).toBe(true);
    for (const variant of ["listing-1 ", " listing-1", "listing-1\t", "listing-1\n"]) {
      const r = await claim({ scope: "s", key: variant });
      expect(r.ok).toBe(false);
    }
    expect(summarize("s").claims).toBe(1);
  });
  test("normalizeKey", () => {
    expect(normalizeKey("  a   b \n")).toBe("a b");
  });
  test("an empty key is refused", async () => {
    await expect(claim({ scope: "s", key: "   " })).rejects.toThrow(/empty/);
  });
});

describe("hook fails closed on a matched rule", () => {
  const rules: HookRule[] = [{ match: "api\\.telegram\\.org", scope: "tg", limit: "5/day" }];
  test("ledger error denies the send instead of letting it through", async () => {
    const r = await decide({ tool_name: "Bash", tool_input: { command: "curl https://api.telegram.org/botX/sendMessage" } }, rules, async () => {
      throw new Error("EACCES: permission denied");
    });
    expect(r.decision).toBe("deny");
    if (r.decision === "deny") expect(r.reason).toMatch(/cannot record.*EACCES/);
  });
  test("unmatched commands still pass when the ledger is broken", async () => {
    const r = await decide({ tool_name: "Bash", tool_input: { command: "ls" } }, rules, async () => {
      throw new Error("EACCES");
    });
    expect(r.decision).toBe("pass");
  });
});

describe("redaction shapes the red team got past", () => {
  test("UPPER_SNAKE secrets, stripe, slack, pem, jwt", () => {
    expect(redact("export DATABASE_PASSWORD=hunter2hunter2")).toBe("export DATABASE_PASSWORD=[redacted]");
    expect(redact("curl -d api_key=abcdefgh12345678 https://x")).toBe("curl -d api_key=[redacted] https://x");
    expect(redact("SECRET_TOKEN=abcdefghijklmnop ./run")).toBe("SECRET_TOKEN=[redacted] ./run");
    expect(redact("stripe: sk_live_abcdefghijklmnop1234")).toBe("stripe: sk_[redacted]");
    expect(redact("https://hooks.slack.com/services/T0001/B0002/abcdefghijkl")).toBe("https://hooks.slack.com/services/[redacted]");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("[redacted private key]");
    expect(redact("Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("Authorization: [redacted jwt]");
  });
});

describe("parseStarted", () => {
  test("reads ps lstart in local time", () => {
    const d = parseStarted("Tue Sep  2 19:12:18 2026");
    expect(d).not.toBeNull();
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(8);
    expect(d?.getDate()).toBe(2);
    expect(d?.getHours()).toBe(19);
    expect(parseStarted("garbage")).toBeNull();
  });
});
