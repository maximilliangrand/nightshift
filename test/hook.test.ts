import { describe, expect, test } from "bun:test";
import { commandKey, decide, type HookRule } from "../src/hook";
import type { ClaimResult } from "../src/ledger";

const rules: HookRule[] = [
  { match: "api\\.telegram\\.org/bot[^/]+/sendMessage", scope: "telegram", limit: "40/day", note: "Telegram sends:" },
  { match: "^gh pr create", scope: "github-prs" },
];

const allow = async (): Promise<ClaimResult> => ({ ok: true, count: 1 });

describe("hook decide", () => {
  test("ignores non-Bash tools and unmatched commands", async () => {
    expect(await decide({ tool_name: "Write", tool_input: { file_path: "x" } }, rules, allow)).toEqual({ decision: "pass" });
    expect(await decide({ tool_name: "Bash", tool_input: { command: "ls -la" } }, rules, allow)).toEqual({ decision: "pass" });
  });

  test("allows a matched command when the ledger says yes", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const r = await decide(
      { tool_name: "Bash", tool_input: { command: "curl https://api.telegram.org/botXYZ/sendMessage -d chat_id=1" } },
      rules,
      async (scope, key, limit) => {
        calls.push([scope, key, limit]);
        return { ok: true, count: 3 };
      },
    );
    expect(r.decision).toBe("allow");
    expect(calls[0]?.[0]).toBe("telegram");
    expect(calls[0]?.[2]).toEqual({ limit: 40, windowMs: 86_400_000, window: "day" });
  });

  test("denies a duplicate with a reason Claude can act on", async () => {
    const r = await decide(
      { tool_name: "Bash", tool_input: { command: "gh pr create --title x" } },
      rules,
      async () => ({ ok: false, reason: "duplicate", firstClaimedAt: "2026-09-02T01:00:00Z", count: 1 }),
    );
    expect(r.decision).toBe("deny");
    if (r.decision === "deny") expect(r.reason).toMatch(/already ran at 2026-09-02T01:00:00Z/);
  });

  test("denies a capped scope", async () => {
    const r = await decide(
      { tool_name: "Bash", tool_input: { command: "curl https://api.telegram.org/botXYZ/sendMessage" } },
      rules,
      async () => ({ ok: false, reason: "capped", count: 40, limit: 40, window: "day", retryAfterMs: 1000 }),
    );
    expect(r.decision).toBe("deny");
    if (r.decision === "deny") expect(r.reason).toMatch(/limit of 40\/day/);
  });

  test("a broken regex is skipped, not fatal", async () => {
    const r = await decide({ tool_name: "Bash", tool_input: { command: "x" } }, [{ match: "(", scope: "s" }], allow);
    expect(r.decision).toBe("pass");
  });

  test("command keys ignore whitespace differences", () => {
    expect(commandKey("curl  -X POST   https://x")).toBe(commandKey("curl -X POST https://x"));
    expect(commandKey("a")).not.toBe(commandKey("b"));
  });
});
