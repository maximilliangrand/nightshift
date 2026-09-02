import { describe, expect, test } from "bun:test";
import { ClaudeStreamMeter, costOf, instrumentClaudeArgv, isClaudeCommand, priceFor } from "../src/meters/claude";

// Observed from a real `claude -p ... --output-format stream-json --verbose`
// run on 2026-09-02. The same message id arrives twice (thinking + text).
const usage = { input_tokens: 10, cache_creation_input_tokens: 8075, cache_read_input_tokens: 17799, output_tokens: 4 };
const message = (content: unknown[]) => ({
  type: "assistant",
  message: { id: "msg_011Ceey1VEh4Gw9RWMdbDzxS", model: "claude-haiku-4-5-20251001", usage, content },
});
const init = { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001", session_id: "454fc3cd" };
const rateLimit = { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.15 } } } };
const result = { type: "result", total_cost_usd: 0.0181649, num_turns: 1, session_id: "454fc3cd", terminal_reason: "completed", is_error: false };

describe("priceFor", () => {
  test("strips date suffix and matches family", () => {
    expect(priceFor("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(priceFor("claude-opus-5")?.output).toBe(25);
    expect(priceFor("claude-sonnet-5")?.cacheRead).toBe(0.2);
    expect(priceFor("gpt-9")).toBeNull();
  });
  test("reproduces the observed bill to the cent", () => {
    // Claude Code reported $0.0181649 for this run with 45 output tokens
    // (37 of them thinking). List prices with a 1h cache write reproduce it.
    const cost = costOf({ model: "claude-haiku-4-5-20251001", input: 10, cacheWrite: 8075, cacheRead: 17799, output: 45 });
    expect(cost).toBeCloseTo(0.0181649, 6);
  });
});

describe("ClaudeStreamMeter", () => {
  test("counts a message once even when its blocks arrive separately", () => {
    const texts: string[] = [];
    const meter = new ClaudeStreamMeter({ onText: (t) => texts.push(t) });
    const lines = [init, message([{ type: "thinking", thinking: "..." }]), message([{ type: "text", text: "pong" }]), rateLimit, result];
    meter.feed(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = meter.totals;
    expect(t.messages).toBe(1);
    expect(t.inputTokens).toBe(10);
    expect(t.cacheWriteTokens).toBe(8075);
    expect(t.cacheReadTokens).toBe(17799);
    expect(t.outputTokens).toBe(4);
    expect(t.totalTokens).toBe(10 + 8075 + 17799 + 4);
    expect(t.estimatedUsd).toBeCloseTo((10 * 1 + 8075 * 2 + 17799 * 0.1 + 4 * 5) / 1e6, 9);
    expect(t.actualUsd).toBe(0.0181649);
    expect(t.priceSource).toBe("reported");
    expect(t.model).toBe("claude-haiku-4-5-20251001");
    expect(t.sessionId).toBe("454fc3cd");
    expect(t.rateLimits).toEqual({ fiveHour: 0.2, sevenDay: 0.15 });
    expect(t.terminalReason).toBe("completed");
    expect(texts.join("")).toBe("pong\n");
  });

  test("handles chunk boundaries inside a line", () => {
    const meter = new ClaudeStreamMeter();
    const line = JSON.stringify(message([{ type: "text", text: "hi" }])) + "\n";
    meter.feed(line.slice(0, 40));
    meter.feed(line.slice(40));
    expect(meter.totals.messages).toBe(1);
  });

  test("records tool calls, files and commands", () => {
    const meter = new ClaudeStreamMeter();
    const tools = {
      type: "assistant",
      message: {
        id: "msg_2",
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } },
          { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/tmp/a.ts" } },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } },
        ],
      },
    };
    meter.feed(JSON.stringify(tools) + "\n");
    expect(meter.totals.toolCalls).toEqual({ Bash: 1, Write: 1 });
    expect(meter.totals.filesWritten).toEqual(["/tmp/a.ts"]);
    expect(meter.totals.commands).toEqual(["git status"]);
  });

  test("passes non-JSON lines through as text", () => {
    const texts: string[] = [];
    const meter = new ClaudeStreamMeter({ onText: (t) => texts.push(t) });
    meter.feed("plain output\n{not json\n");
    expect(texts).toEqual(["plain output\n", "{not json\n"]);
  });

  test("flushes a trailing partial line on end()", () => {
    const meter = new ClaudeStreamMeter();
    meter.feed(JSON.stringify(message([])));
    expect(meter.totals.messages).toBe(0);
    meter.end();
    expect(meter.totals.messages).toBe(1);
  });
});

describe("instrumentClaudeArgv", () => {
  test("adds stream-json and a budget to a print run", () => {
    const r = instrumentClaudeArgv(["claude", "-p", "fix it"], { budgetUsd: 5 });
    expect(r.argv).toEqual(["claude", "-p", "fix it", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "5"]);
    expect(r.renders).toBe(true);
    expect(r.metered).toBe(true);
  });
  test("respects an explicit stream-json without rendering", () => {
    const r = instrumentClaudeArgv(["claude", "-p", "x", "--output-format", "stream-json"], {});
    expect(r.argv).toContain("--verbose");
    expect(r.renders).toBe(false);
    expect(r.metered).toBe(true);
  });
  test("leaves text output alone and says so", () => {
    const r = instrumentClaudeArgv(["claude", "-p", "x", "--output-format=text"], {});
    expect(r.metered).toBe(false);
    expect(r.notes[0]).toMatch(/unmetered/);
  });
  test("interactive sessions are not metered", () => {
    const r = instrumentClaudeArgv(["claude"], { budgetUsd: 1 });
    expect(r.metered).toBe(false);
    expect(r.argv).toEqual(["claude"]);
  });
  test("forced adapter on a foreign command touches nothing", () => {
    const r = instrumentClaudeArgv(["bun", "agent.ts"], { forced: true });
    expect(r.argv).toEqual(["bun", "agent.ts"]);
    expect(r.metered).toBe(true);
  });
  test("isClaudeCommand", () => {
    expect(isClaudeCommand(["claude", "-p"])).toBe(true);
    expect(isClaudeCommand(["/opt/homebrew/bin/claude"])).toBe(true);
    expect(isClaudeCommand(["codex"])).toBe(false);
  });
});
