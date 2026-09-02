import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_CEILING_PRICE,
  CODEX_DEFAULT_MODEL,
  CodexStreamMeter,
  codexCostOf,
  codexPriceFor,
  instrumentCodexArgv,
  isCodexCommand,
  modelFromArgv,
  modelFromConfig,
  splitCodexUsage,
} from "../src/meters/codex";

// The "Sample JSON stream" of the Codex non-interactive docs
// (developers.openai.com/codex/noninteractive, read 2026-09-02), verbatim.
const threadStarted = { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" };
const turnStarted = { type: "turn.started" };
const commandStarted = { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } };
const agentMessage = { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Repo contains docs, sdk, and examples directories." } };
const turnCompleted = { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } };

// Shapes from codex-rs/exec/src/exec_events.rs (ThreadItemDetails, serde
// rename_all = snake_case; FileChangeItem, McpToolCallItem, WebSearchItem,
// ErrorItem, TurnFailedEvent, ThreadErrorEvent), filled with plausible values.
const commandCompleted = {
  type: "item.completed",
  item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "docs\nsdk\n", exit_code: 0, status: "completed" },
};
const fileChangeStarted = {
  type: "item.started",
  item: { id: "item_2", type: "file_change", changes: [{ path: "/repo/src/a.ts", kind: "update" }, { path: "/repo/src/b.ts", kind: "add" }], status: "in_progress" },
};
const fileChangeCompleted = {
  type: "item.completed",
  item: { id: "item_2", type: "file_change", changes: [{ path: "/repo/src/a.ts", kind: "update" }, { path: "/repo/src/b.ts", kind: "add" }, { path: "/repo/old.ts", kind: "delete" }], status: "completed" },
};
const mcpCall = {
  type: "item.completed",
  item: { id: "item_4", type: "mcp_tool_call", server: "github", tool: "list_issues", arguments: { repo: "x" }, result: null, error: null, status: "completed" },
};
const webSearch = { type: "item.completed", item: { id: "item_5", type: "web_search", query: "codex exec json", action: { type: "search" } } };
const reasoning = { type: "item.completed", item: { id: "item_6", type: "reasoning", text: "thinking about it" } };
const warning = { type: "item.completed", item: { id: "item_7", type: "error", message: "config warning: unknown key" } };
const turnFailed = { type: "turn.failed", error: { message: "stream disconnected before completion" } };
const fatal = { type: "error", message: "unexpected status 401 Unauthorized" };

const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("codexPriceFor", () => {
  test("exact rows, snapshot dates, namespaces and family fallbacks", () => {
    expect(codexPriceFor("gpt-5.6-sol")?.input).toBe(4);
    expect(codexPriceFor("gpt-5.4-2026-03-05")?.output).toBe(15);
    expect(codexPriceFor("custom/gpt-5.3-codex")?.cacheRead).toBe(0.175);
    // A longer id must not fall back to a shorter family row when its own row exists.
    expect(codexPriceFor("gpt-5.4-mini")?.input).toBe(0.75);
    expect(codexPriceFor("gpt-5.4-pro")?.output).toBe(180);
    // Codex names with no row of their own are priced with their family.
    expect(codexPriceFor("gpt-5.2-codex")?.input).toBe(1.75);
    expect(codexPriceFor("gpt-5-codex")?.output).toBe(10);
    expect(codexPriceFor("claude-opus-5")).toBeNull();
    expect(codexPriceFor("codex-auto-review")).toBeNull();
  });
  test("the ceiling is the most expensive row", () => {
    for (const price of [codexPriceFor("gpt-5.5-pro")!, codexPriceFor("gpt-5.6-cyber")!, codexPriceFor("gpt-5.6-sol")!]) {
      expect(price.input).toBeLessThanOrEqual(CODEX_CEILING_PRICE.input);
      expect(price.output).toBeLessThanOrEqual(CODEX_CEILING_PRICE.output);
    }
  });
  test("prices the documented sample at list rates", () => {
    // 24763 input of which 24448 cached, 122 output, on gpt-5.6-sol.
    const cost = codexCostOf("gpt-5.6-sol", splitCodexUsage(turnCompleted.usage));
    expect(cost).toBeCloseTo((315 * 4 + 24448 * 0.4 + 122 * 20) / 1e6, 12);
  });
});

describe("splitCodexUsage", () => {
  test("cached and cache-write tokens are parts of input_tokens", () => {
    // From the TokenUsage conversion test in codex-rs/codex-api/src/sse/responses.rs:
    // input 100 = cached 40 + cache write 60, output 10, total 110.
    const split = splitCodexUsage({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 5 });
    expect(split).toEqual({ input: 0, output: 10, cacheRead: 40, cacheWrite: 60 });
    expect(splitCodexUsage(turnCompleted.usage)).toEqual({ input: 315, output: 122, cacheRead: 24448, cacheWrite: 0 });
  });
});

describe("CodexStreamMeter", () => {
  test("reads the documented sample stream", () => {
    const texts: string[] = [];
    const meter = new CodexStreamMeter({ onText: (t) => texts.push(t) }, "gpt-5.6-sol");
    meter.feed(jsonl([threadStarted, turnStarted, commandStarted, agentMessage, turnCompleted]));
    const t = meter.totals;
    expect(t.sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(t.model).toBe("gpt-5.6-sol");
    expect(t.inputTokens).toBe(315);
    expect(t.cacheReadTokens).toBe(24448);
    expect(t.outputTokens).toBe(122);
    expect(t.totalTokens).toBe(24763 + 122);
    expect(t.turns).toBe(1);
    expect(t.messages).toBe(1);
    expect(t.estimatedUsd).toBeCloseTo((315 * 4 + 24448 * 0.4 + 122 * 20) / 1e6, 12);
    expect(t.priceSource).toBe("list");
    expect(t.actualUsd).toBeUndefined();
    expect(t.toolCalls).toEqual({ command: 1 });
    expect(t.commands).toEqual(["bash -lc ls"]);
    expect(texts).toEqual(["  ⚙ command: bash -lc ls\n", "Repo contains docs, sdk, and examples directories.\n"]);
  });

  test("turn.completed usage is a running total: repeats cost nothing, growth counts once", () => {
    const meter = new CodexStreamMeter({}, "gpt-5");
    const grow = (input: number) => ({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } });
    meter.feed(jsonl([grow(1000), grow(1000), grow(3000)]));
    expect(meter.totals.inputTokens).toBe(3000);
    expect(meter.totals.outputTokens).toBe(10);
    expect(meter.totals.turns).toBe(2);
    expect(meter.totals.estimatedUsd).toBeCloseTo((3000 * 1.25 + 10 * 10) / 1e6, 12);
  });

  test("an unknown model is priced at the ceiling and reported once", () => {
    const unpriced: string[] = [];
    const meter = new CodexStreamMeter({ onUnpricedModel: (m) => unpriced.push(m) }, "codex-auto-review");
    meter.feed(jsonl([turnCompleted, turnCompleted]));
    expect(unpriced).toEqual(["codex-auto-review"]);
    expect(meter.totals.priceSource).toBe("ceiling");
    expect(meter.totals.estimatedUsd).toBeCloseTo((315 * 30 + 24448 * 30 + 122 * 180) / 1e6, 12);
  });

  test("items are counted once per id; files, commands and tools are extracted", () => {
    const texts: string[] = [];
    const meter = new CodexStreamMeter({ onText: (t) => texts.push(t) });
    meter.feed(jsonl([commandStarted, commandCompleted, fileChangeStarted, fileChangeCompleted, mcpCall, webSearch, reasoning, warning]));
    const t = meter.totals;
    expect(t.toolCalls).toEqual({ command: 1, file_change: 1, "mcp:github/list_issues": 1, web_search: 1 });
    expect(t.filesWritten).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
    expect(t.commands).toEqual(["bash -lc ls"]);
    expect(t.messages).toBe(0);
    expect(texts).toEqual([
      "  ⚙ command: bash -lc ls\n",
      "  ⚙ file_change: update /repo/src/a.ts, add /repo/src/b.ts\n",
      "  ⚙ mcp:github/list_issues\n",
      "  ⚙ web_search: codex exec json\n",
      "  ⚠ codex: config warning: unknown key\n",
    ]);
  });

  test("commands are redacted before they are kept or shown", () => {
    const texts: string[] = [];
    const meter = new CodexStreamMeter({ onText: (t) => texts.push(t) });
    const secret = { type: "item.started", item: { id: "item_9", type: "command_execution", command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz' https://x", status: "in_progress" } };
    meter.feed(jsonl([secret]));
    expect(meter.totals.commands[0]).not.toContain("abcdefghij");
    expect(texts[0]).not.toContain("abcdefghij");
  });

  test("turn.failed and error mark the run as failed with the reason", () => {
    const texts: string[] = [];
    const meter = new CodexStreamMeter({ onText: (t) => texts.push(t) });
    meter.feed(jsonl([turnFailed]));
    expect(meter.totals.isError).toBe(true);
    expect(meter.totals.terminalReason).toBe("stream disconnected before completion");
    meter.feed(jsonl([fatal]));
    expect(meter.totals.terminalReason).toBe("unexpected status 401 Unauthorized");
    expect(texts).toEqual(["  ✗ codex: stream disconnected before completion\n", "  ✗ codex: unexpected status 401 Unauthorized\n"]);
  });

  test("handles chunk boundaries, objects without a newline, and plain text", () => {
    const meter = new CodexStreamMeter({}, "gpt-5");
    const line = JSON.stringify(turnCompleted) + "\n";
    meter.feed(line.slice(0, 30));
    meter.feed(line.slice(30));
    expect(meter.totals.turns).toBe(1);
    // A started agent message (not emitted today, but allowed by the type) must not swallow its completion.
    meter.feed(jsonl([{ type: "item.started", item: { id: "item_3", type: "agent_message", text: "" } }]));
    meter.feed(JSON.stringify(agentMessage));
    expect(meter.totals.messages).toBe(1);
    const texts: string[] = [];
    const late = new CodexStreamMeter({ onText: (t) => texts.push(t) });
    late.feed("plain progress\n{not json\ntrailing words");
    expect(texts).toEqual(["plain progress\n", "{not json\n"]);
    late.end();
    expect(texts[2]).toBe("trailing words\n");
  });
});

describe("model resolution", () => {
  test("modelFromArgv", () => {
    expect(modelFromArgv(["codex", "exec", "-m", "gpt-5.4", "x"])).toBe("gpt-5.4");
    expect(modelFromArgv(["codex", "--model=gpt-5-mini", "exec", "x"])).toBe("gpt-5-mini");
    expect(modelFromArgv(["codex", "exec", "-c", 'model="o3"', "x"])).toBe("o3");
    expect(modelFromArgv(["codex", "exec", "-c", "model='o3'", "x"])).toBe("o3");
    expect(modelFromArgv(["codex", "exec", "--config", "model=gpt-5.2", "x"])).toBe("gpt-5.2");
    expect(modelFromArgv(["codex", "exec", "-c", "sandbox_mode=read-only", "x"])).toBeNull();
  });
  test("modelFromConfig reads the top-level key only", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-codex-home-"));
    fs.writeFileSync(path.join(home, "config.toml"), '# comment\nmodel_reasoning_effort = "high"\nmodel = "gpt-5.4"\n[profiles.fast]\nmodel = "gpt-5-mini"\n');
    expect(modelFromConfig({ CODEX_HOME: home })).toBe("gpt-5.4");
    fs.writeFileSync(path.join(home, "config.toml"), '[profiles.fast]\nmodel = "gpt-5-mini"\n');
    expect(modelFromConfig({ CODEX_HOME: home })).toBeNull();
    expect(modelFromConfig({ CODEX_HOME: path.join(home, "missing") })).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("instrumentCodexArgv", () => {
  test("adds --json after exec and renders; a budget is noted, not passed down", () => {
    const r = instrumentCodexArgv(["codex", "exec", "-m", "gpt-5.4", "fix it"], { budgetUsd: 5 });
    expect(r.argv).toEqual(["codex", "exec", "--json", "-m", "gpt-5.4", "fix it"]);
    expect(r.renders).toBe(true);
    expect(r.metered).toBe(true);
    expect(r.argv.some((a) => a.includes("budget"))).toBe(false);
    expect(r.notes).toEqual(["codex has no spend limit flag of its own; the budget is enforced by nightshift alone"]);
  });
  test("global options before the subcommand do not hide it", () => {
    const r = instrumentCodexArgv(["codex", "-C", "/repo", "-s", "workspace-write", "e", "resume", "--last", "go"], {});
    expect(r.argv).toEqual(["codex", "-C", "/repo", "-s", "workspace-write", "e", "--json", "resume", "--last", "go"]);
    expect(r.metered).toBe(true);
  });
  test("respects an explicit --json without rendering", () => {
    const r = instrumentCodexArgv(["codex", "exec", "--json", "-m", "o3", "x"], {});
    expect(r.argv).toEqual(["codex", "exec", "--json", "-m", "o3", "x"]);
    expect(r.renders).toBe(false);
    expect(r.metered).toBe(true);
  });
  test("says when the model is assumed, and which", () => {
    // Point CODEX_HOME at an empty directory so the developer's own config.toml stays out of the test.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-codex-home-"));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const r = instrumentCodexArgv(["codex", "exec", "x"], {});
      expect(r.metered).toBe(true);
      expect(r.notes).toEqual([`codex does not name its model in the --json stream; spend is priced as ${CODEX_DEFAULT_MODEL} (pass -m to be exact)`]);
      fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5-mini"\n');
      expect(instrumentCodexArgv(["codex", "exec", "x"], {}).notes[0]).toContain("priced as gpt-5-mini");
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  test("interactive codex is not metered", () => {
    for (const argv of [["codex"], ["codex", "do the thing"], ["codex", "review", "x"]]) {
      const r = instrumentCodexArgv(argv, { budgetUsd: 1 });
      expect(r.metered).toBe(false);
      expect(r.argv).toEqual(argv);
      expect(r.notes[0]).toMatch(/interactive codex session/);
    }
  });
  test("forced adapter on a foreign command touches nothing and prices the default model", () => {
    const r = instrumentCodexArgv(["bun", "agent.ts"], { forced: true });
    expect(r.argv).toEqual(["bun", "agent.ts"]);
    expect(r.metered).toBe(true);
    expect(r.notes.join(" ")).toContain(CODEX_DEFAULT_MODEL);
  });
  test("isCodexCommand", () => {
    expect(isCodexCommand(["codex", "exec"])).toBe(true);
    expect(isCodexCommand(["/opt/homebrew/bin/codex"])).toBe(true);
    expect(isCodexCommand(["claude", "-p"])).toBe(false);
  });
});
