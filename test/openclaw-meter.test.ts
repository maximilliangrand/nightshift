import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenClawMeter, closingBrace, instrumentOpenClawArgv, isOpenClawCommand, openClawStateDir, sessionSelector } from "../src/meters/openclaw";

// Captured from `openclaw agent --json --session-id <id> -m "Reply with the
// single word pong"` against OpenClaw 2026.4.10 on 2026-09-02, through the
// gateway. Paths and the skill/tool inventories are trimmed; the structure and
// the numbers are as printed. The whole thing arrives at once, at the end,
// pretty-printed with two-space indent.
const envelope = {
  runId: "d9d40de2-f3c6-4e1a-bd3b-3478a2f24fbc",
  status: "ok",
  summary: "completed",
  result: {
    payloads: [{ text: "pong", mediaUrl: null }],
    meta: {
      durationMs: 7552,
      agentMeta: {
        sessionId: "808dd031-cb90-47d5-9e4c-644e672e5c66",
        provider: "ollama",
        model: "deepseek-v4-pro:cloud",
        usage: { input: 22915, output: 3, total: 22918 },
        lastCallUsage: { input: 22915, output: 3, cacheRead: 0, cacheWrite: 0, total: 22918 },
        promptTokens: 22915,
      },
      aborted: false,
      systemPromptReport: {
        source: "run",
        generatedAt: 1788376077725,
        sessionId: "808dd031-cb90-47d5-9e4c-644e672e5c66",
        sessionKey: "agent:main:explicit:nightshift-probe-1788376068",
        provider: "ollama",
        model: "deepseek-v4-pro:cloud",
        workspaceDir: "/home/user/.openclaw/workspace",
        systemPrompt: { chars: 62337, projectContextChars: 39463, nonProjectContextChars: 22874 },
        injectedWorkspaceFiles: [{ name: "AGENTS.md", path: "/home/user/.openclaw/workspace/AGENTS.md", missing: false, rawChars: 15090, injectedChars: 15090, truncated: false }],
        skills: { promptChars: 10108, entries: [{ name: "weather", blockChars: 416 }] },
        tools: { listChars: 0, schemaChars: 13158, entries: [{ name: "exec", summaryChars: 539, schemaChars: 1098, propertiesCount: 12 }] },
      },
      finalAssistantVisibleText: "pong",
      replayInvalid: false,
      livenessState: "working",
      stopReason: "stop",
    },
  },
};
const pretty = JSON.stringify(envelope, null, 2) + "\n";

// One assistant line of the session transcript the same run appended under
// ~/.openclaw/agents/main/sessions/<sessionId>.jsonl. The user line before it
// carries the prompt and injected memories and is not needed here. The
// timestamp defaults to now because a message older than the run is history.
const transcriptMessage = (id: string, usage: Record<string, unknown>, content: unknown[] = [{ type: "text", text: "pong" }], at: number = Date.now()) => ({
  type: "message",
  id,
  parentId: "f6778283",
  timestamp: new Date(at).toISOString(),
  message: { role: "assistant", content, stopReason: "stop", api: "ollama", provider: "ollama", model: "deepseek-v4-pro:cloud", usage },
});
/** The first line of every real transcript: the session header, stamped when the session was created. */
const transcriptHeader = (id: string, at: number) => ({ type: "session", version: 3, id, timestamp: new Date(at).toISOString(), cwd: "/home/user/.openclaw/workspace" });
const observedUsage = { input: 22915, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 22918, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const SESSION = "808dd031-cb90-47d5-9e4c-644e672e5c66";
const EXPLICIT = "nightshift-probe-1";
const EXPLICIT_KEY = `agent:main:explicit:${EXPLICIT}`;

const CEILING_ESTIMATE = (22915 * 10 + 3 * 50) / 1e6;

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");

/**
 * A state dir with one agent's store. Every entry gets the shared transcript
 * as its sessionFile unless it names its own; `writeTranscript` makes one.
 */
function fakeStateDir(entries: Record<string, unknown>, transcriptLines: unknown[], agent = "main"): { dir: string; transcript: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-openclaw-"));
  const transcript = writeTranscript(dir, agent, SESSION, transcriptLines);
  const withFile = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { sessionFile: transcript, ...(value as object) }]));
  fs.writeFileSync(path.join(dir, "agents", agent, "sessions", "sessions.json"), JSON.stringify(withFile));
  return { dir, transcript };
}

function writeTranscript(dir: string, agent: string, sessionId: string, lines: unknown[]): string {
  const sessions = path.join(dir, "agents", agent, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, jsonl(lines));
  return transcript;
}

function noteTaker(): { notes: string[]; hooks: { onNote: (n: string) => void } } {
  const notes: string[] = [];
  return { notes, hooks: { onNote: (n) => notes.push(n) } };
}

describe("isOpenClawCommand", () => {
  test("matches the agent subcommand, with or without global options before it", () => {
    expect(isOpenClawCommand(["openclaw", "agent", "-m", "hi", "--agent", "ops"])).toBe(true);
    expect(isOpenClawCommand(["/opt/homebrew/bin/openclaw", "--profile", "work", "agent", "-m", "hi"])).toBe(true);
    expect(isOpenClawCommand(["openclaw", "--dev", "agent", "-m", "hi"])).toBe(true);
    expect(isOpenClawCommand(["openclaw", "sessions", "--json"])).toBe(false);
    expect(isOpenClawCommand(["openclaw", "message", "send", "--message", "agent"])).toBe(false);
    expect(isOpenClawCommand(["claude", "-p", "agent"])).toBe(false);
  });
  test("reads the session selectors and state dir from argv", () => {
    expect(sessionSelector(["openclaw", "agent", "--session-id", "s1", "--agent=ops"])).toEqual({ sessionId: "s1", agentId: "ops" });
    expect(sessionSelector(["openclaw", "agent", "--to", "+15555550123"])).toEqual({ sessionId: undefined, agentId: undefined });
    expect(openClawStateDir(["openclaw", "agent"], {})).toBe(path.join(os.homedir(), ".openclaw"));
    expect(openClawStateDir(["openclaw", "--profile", "work", "agent"], {})).toBe(path.join(os.homedir(), ".openclaw-work"));
    expect(openClawStateDir(["openclaw", "--dev", "agent"], {})).toBe(path.join(os.homedir(), ".openclaw-dev"));
    expect(openClawStateDir(["openclaw", "agent"], { OPENCLAW_STATE_DIR: "/tmp/oc" })).toBe("/tmp/oc");
  });
  test("resolves the state dir the way OpenClaw does: ~ expands, relative is the run's cwd, OPENCLAW_HOME is the home", () => {
    expect(openClawStateDir([], { OPENCLAW_STATE_DIR: "~/oc" }, "/run/here")).toBe(path.join(os.homedir(), "oc"));
    expect(openClawStateDir([], { OPENCLAW_STATE_DIR: "~" }, "/run/here")).toBe(os.homedir());
    expect(openClawStateDir([], { OPENCLAW_STATE_DIR: "state" }, "/run/here")).toBe("/run/here/state");
    expect(openClawStateDir([], { OPENCLAW_STATE_DIR: " /abs/oc " }, "/run/here")).toBe("/abs/oc");
    expect(openClawStateDir([], { OPENCLAW_HOME: "/srv/home" }, "/run/here")).toBe("/srv/home/.openclaw");
    expect(openClawStateDir(["openclaw", "--profile", "work", "agent"], { OPENCLAW_HOME: "~/h" }, "/run/here")).toBe(path.join(os.homedir(), "h", ".openclaw-work"));
    expect(openClawStateDir(["openclaw", "--dev", "agent"], { OPENCLAW_HOME: "homes" }, "/run/here")).toBe("/run/here/homes/.openclaw-dev");
    expect(openClawStateDir([], { OPENCLAW_HOME: "/srv/home", OPENCLAW_STATE_DIR: "/abs/oc" }, "/run/here")).toBe("/abs/oc");
  });
});

describe("instrumentOpenClawArgv", () => {
  test("adds --json and renders when it was absent", () => {
    const r = instrumentOpenClawArgv(["openclaw", "agent", "--agent", "ops", "-m", "go"], {});
    expect(r.argv).toEqual(["openclaw", "agent", "--agent", "ops", "-m", "go", "--json"]);
    expect(r.renders).toBe(true);
    expect(r.metered).toBe(true);
    expect(r.notes).toEqual([]);
  });
  test("leaves an explicit --json alone and does not render", () => {
    const r = instrumentOpenClawArgv(["openclaw", "agent", "--json", "-m", "go", "--agent", "ops"], {});
    expect(r.argv.filter((a) => a === "--json")).toHaveLength(1);
    expect(r.renders).toBe(false);
    expect(r.metered).toBe(true);
  });
  test("a budget cannot be passed through; the notes say so and where the kill reaches", () => {
    const gateway = instrumentOpenClawArgv(["openclaw", "agent", "--agent", "ops", "-m", "go"], { budgetUsd: 2 });
    expect(gateway.argv.some((a) => a.includes("budget"))).toBe(false);
    expect(gateway.notes).toHaveLength(2);
    expect(gateway.notes[0]).toMatch(/no budget flag/);
    expect(gateway.notes[1]).toMatch(/--local/);
    const local = instrumentOpenClawArgv(["openclaw", "agent", "--agent", "ops", "-m", "go", "--local"], { budgetUsd: 2 });
    expect(local.notes).toHaveLength(1);
  });
  test("forced onto a command that is not openclaw, it touches nothing", () => {
    const r = instrumentOpenClawArgv(["bun", "fake.ts"], { forced: true, runId: "r1" });
    expect(r.argv).toEqual(["bun", "fake.ts"]);
    expect(r.metered).toBe(true);
    expect(r.renders).toBe(false);
  });
  test("gives the run its own session id when the command has none, and says so", () => {
    const r = instrumentOpenClawArgv(["openclaw", "agent", "--to", "+15555550123", "-m", "go"], { runId: "20260902-214900-abc123-nightly" });
    expect(r.argv).toEqual(["openclaw", "agent", "--to", "+15555550123", "-m", "go", "--json", "--session-id", "nightshift-20260902-214900-abc123-nightly"]);
    expect(r.notes).toEqual(["run isolated in its own OpenClaw session nightshift-20260902-214900-abc123-nightly; pass --session-id yourself to continue an existing one"]);
    expect(sessionSelector(r.argv).sessionId).toBe("nightshift-20260902-214900-abc123-nightly");
  });
  test("leaves a --session-id the user chose alone, in either spelling", () => {
    const spaced = instrumentOpenClawArgv(["openclaw", "agent", "--session-id", "ops", "-m", "go"], { runId: "r1" });
    expect(spaced.argv.filter((a) => a.startsWith("--session-id"))).toEqual(["--session-id"]);
    expect(spaced.notes).toEqual([]);
    const joined = instrumentOpenClawArgv(["openclaw", "agent", "--session-id=ops", "-m", "go"], { runId: "r1" });
    expect(joined.argv.filter((a) => a.startsWith("--session-id"))).toEqual(["--session-id=ops"]);
    expect(sessionSelector(joined.argv).sessionId).toBe("ops");
  });
});

describe("closingBrace", () => {
  test("ignores braces inside strings and escaped quotes", () => {
    expect(closingBrace('{"a": "}"}')).toBe(9);
    expect(closingBrace('{"a": "\\"}"}')).toBe(11);
    expect(closingBrace('{"a": {"b": 1}')).toBe(-1);
    expect(closingBrace('{"a": {"b": 1}} tail')).toBe(14);
  });
});

describe("OpenClawMeter on stdout", () => {
  test("reads the gateway envelope: tokens, model, session, outcome, reply text", () => {
    const texts: string[] = [];
    const unpriced: string[] = [];
    const events: string[] = [];
    const meter = new OpenClawMeter({ onText: (t) => texts.push(t), onUnpricedModel: (m) => unpriced.push(m), onEvent: (e) => events.push(e) }, { pollMs: 0, stateDir: "/nonexistent" });
    meter.feed(pretty);
    meter.end();
    const t = meter.totals;
    expect(t.inputTokens).toBe(22915);
    expect(t.outputTokens).toBe(3);
    expect(t.totalTokens).toBe(22918);
    expect(t.model).toBe("deepseek-v4-pro:cloud");
    expect(t.models).toEqual({ "deepseek-v4-pro:cloud": 22918 });
    expect(t.sessionId).toBe("808dd031-cb90-47d5-9e4c-644e672e5c66");
    expect(t.terminalReason).toBe("completed");
    expect(t.isError).toBe(false);
    expect(t.turns).toBe(1);
    expect(t.messages).toBe(1);
    // No price row for a DeepSeek id on Ollama: counted at the ceiling, and said so once.
    expect(t.priceSource).toBe("ceiling");
    expect(t.estimatedUsd).toBeCloseTo(CEILING_ESTIMATE, 9);
    expect(t.actualUsd).toBeUndefined();
    expect(unpriced).toEqual(["deepseek-v4-pro:cloud"]);
    expect(texts[0]).toBe("pong\n");
    expect(texts[1]).toBe("openclaw: completed in 8s · 22.9k tokens on deepseek-v4-pro:cloud via ollama\n");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0] ?? "")).toEqual(envelope);
  });

  test("counts once no matter how the pretty-printed object is chunked", () => {
    const meter = new OpenClawMeter({}, { pollMs: 0, stateDir: "/nonexistent" });
    for (let i = 0; i < pretty.length; i += 37) meter.feed(pretty.slice(i, i + 37));
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.turns).toBe(1);
  });

  test("passes log lines around the envelope through as text", () => {
    const texts: string[] = [];
    const meter = new OpenClawMeter({ onText: (t) => texts.push(t) }, { pollMs: 0, stateDir: "/nonexistent" });
    meter.feed("[plugins] memory-lancedb: plugin registered\n" + pretty + "bye");
    meter.end();
    expect(texts[0]).toBe("[plugins] memory-lancedb: plugin registered\n");
    expect(texts[1]).toBe("pong\n");
    expect(texts[3]).toBe("bye\n");
    expect(meter.totals.totalTokens).toBe(22918);
  });

  test("a brace line that is not JSON is text once the stream ends", () => {
    const texts: string[] = [];
    const meter = new OpenClawMeter({ onText: (t) => texts.push(t) }, { pollMs: 0, stateDir: "/nonexistent" });
    meter.feed("{not json\n");
    meter.end();
    expect(texts).toEqual(["{not json\n"]);
    expect(meter.totals.turns).toBe(0);
  });

  test("reads the bare --local envelope and a Claude model at list price", () => {
    const local = { payloads: [{ text: "done" }], meta: { durationMs: 12000, stopReason: "stop", agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6", usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 200, total: 1800 } } } };
    const meter = new OpenClawMeter({}, { pollMs: 0, stateDir: "/nonexistent" });
    meter.feed(JSON.stringify(local, null, 2));
    const t = meter.totals;
    expect(t.totalTokens).toBe(1800);
    expect(t.cacheReadTokens).toBe(500);
    expect(t.priceSource).toBe("list");
    expect(t.estimatedUsd).toBeCloseTo((1000 * 3 + 100 * 15 + 500 * 0.3 + 200 * 6) / 1e6, 9);
    expect(t.terminalReason).toBe("completed");
  });

  test("an error envelope is an error, with the message rendered", () => {
    const texts: string[] = [];
    const meter = new OpenClawMeter({ onText: (t) => texts.push(t) }, { pollMs: 0, stateDir: "/nonexistent" });
    meter.feed(JSON.stringify({ runId: "r", status: "error", summary: "agent failed", error: "Bearer abcdefghijklmnop rejected" }, null, 2));
    expect(meter.totals.isError).toBe(true);
    expect(meter.totals.terminalReason).toBe("agent failed");
    expect(texts[0]).toBe("openclaw error: Bearer [redacted] rejected\n");
  });

  test("prefers a cost the envelope reports over any estimate", () => {
    const priced = structuredClone(envelope) as Record<string, any>;
    priced.result.meta.agentMeta.usage.cost = { total: 0.0123 };
    const meter = new OpenClawMeter({}, { pollMs: 0, stateDir: "/nonexistent" });
    meter.feed(JSON.stringify(priced, null, 2));
    expect(meter.totals.actualUsd).toBeCloseTo(0.0123, 9);
    expect(meter.totals.priceSource).toBe("reported");
    expect(meter.totals.estimatedUsd).toBeCloseTo(CEILING_ESTIMATE, 9);
  });
});

describe("OpenClawMeter on the session transcript", () => {
  test("finds the transcript through the store by explicit id and counts messages as they land", () => {
    const now = Date.now();
    const { dir, transcript } = fakeStateDir({ [EXPLICIT_KEY]: { sessionId: SESSION, startedAt: now, updatedAt: now } }, [transcriptHeader(SESSION, now)]);
    const texts: string[] = [];
    const meter = new OpenClawMeter({ onText: (t) => texts.push(t) }, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now - 500 });
    meter.sync();
    expect(meter.totals.totalTokens).toBe(0);
    const toolTurn = transcriptMessage("m1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, [
      { type: "toolCall", id: "c1", name: "exec", arguments: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x" } },
      { type: "toolCall", id: "c2", name: "write", arguments: { path: "/tmp/out.txt", content: "x" } },
    ]);
    fs.appendFileSync(transcript, JSON.stringify(toolTurn) + "\n");
    meter.sync();
    expect(meter.totals.messages).toBe(1);
    expect(meter.totals.totalTokens).toBe(110);
    expect(meter.totals.actualUsd).toBeCloseTo(0.001, 9);
    expect(meter.totals.priceSource).toBe("reported");
    expect(meter.totals.toolCalls).toEqual({ exec: 1, write: 1 });
    expect(meter.totals.filesWritten).toEqual(["/tmp/out.txt"]);
    expect(meter.totals.commands[0]).toBe("curl -H 'Authorization: Bearer [redacted]' https://x");
    expect(texts[0]).toBe("  ⚙ exec: curl -H 'Authorization: Bearer [redacted]' https://x\n");
    expect(meter.totals.sessionId).toBe(SESSION);
    // A partial line waits for its newline; the same id again is an update, not a second message.
    const second = JSON.stringify(transcriptMessage("m2", { input: 200, output: 20, cacheRead: 50, cacheWrite: 5, cost: { total: 0.002 } }));
    fs.appendFileSync(transcript, second.slice(0, 30));
    meter.sync();
    expect(meter.totals.messages).toBe(1);
    fs.appendFileSync(transcript, second.slice(30) + "\n" + JSON.stringify(toolTurn) + "\n");
    meter.sync();
    expect(meter.totals.messages).toBe(2);
    expect(meter.totals.totalTokens).toBe(110 + 275);
    expect(meter.totals.cacheReadTokens).toBe(50);
    expect(meter.totals.actualUsd).toBeCloseTo(0.003, 9);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a zero cost with tokens behind it is not a report; the ceiling estimate stands", () => {
    const now = Date.now();
    const { dir } = fakeStateDir({ [EXPLICIT_KEY]: { sessionId: SESSION, startedAt: now } }, [transcriptMessage("m1", observedUsage)]);
    const meter = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    meter.sync();
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.actualUsd).toBeUndefined();
    expect(meter.totals.priceSource).toBe("ceiling");
    expect(meter.totals.estimatedUsd).toBeCloseTo(CEILING_ESTIMATE, 9);
    // The envelope at the end reports the same turn: nothing is counted twice.
    meter.feed(pretty);
    meter.end();
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.messages).toBe(1);
    expect(meter.totals.estimatedUsd).toBeCloseTo(CEILING_ESTIMATE, 9);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the envelope wins when it reports more than the tailer saw", () => {
    const now = Date.now();
    const { dir } = fakeStateDir({ [EXPLICIT_KEY]: { sessionId: SESSION, startedAt: now } }, [transcriptMessage("m1", { input: 100, output: 1 })]);
    const meter = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    meter.sync();
    expect(meter.totals.totalTokens).toBe(101);
    meter.feed(pretty);
    meter.end();
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.inputTokens).toBe(22915);
    expect(meter.totals.estimatedUsd).toBeCloseTo(CEILING_ESTIMATE, 9);
    expect(meter.totals.models).toEqual({ "deepseek-v4-pro:cloud": 22918 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Finding #3: reconcile() used to clear the per-message map, so a message
  // the tailer read after the envelope was added on top of the envelope.
  test("the envelope is a floor, not a reset: a transcript message read after it adds nothing", () => {
    const now = Date.now();
    const { dir, transcript } = fakeStateDir({ [EXPLICIT_KEY]: { sessionId: SESSION, startedAt: now } }, []);
    const events: string[] = [];
    const meter = new OpenClawMeter({ onEvent: (e) => events.push(e) }, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    meter.sync();
    meter.feed(pretty);
    expect(meter.totals.totalTokens).toBe(22918);
    const late = transcriptMessage("m1", observedUsage, [{ type: "toolCall", id: "c1", name: "exec", arguments: { command: "ls" } }]);
    fs.appendFileSync(transcript, JSON.stringify(late) + "\n");
    meter.sync();
    meter.end();
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.inputTokens).toBe(22915);
    expect(meter.totals.messages).toBe(1);
    expect(meter.totals.estimatedUsd).toBeCloseTo(CEILING_ESTIMATE, 9);
    // What the message did is still recorded; only its cost is not counted again.
    expect(meter.totals.toolCalls).toEqual({ exec: 1 });
    expect(meter.totals.commands).toEqual(["ls"]);
    expect(events).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Findings #5 and #8: the newest entry by time used to be taken when argv
  // named no session, which on a gateway serving chat channels was someone
  // else's turn.
  test("never picks a session by time: with no id to match, the tailer contributes nothing and end() says so", () => {
    const now = Date.now();
    const { dir } = fakeStateDir({ "agent:main:main": { sessionId: SESSION, startedAt: now, updatedAt: now } }, [transcriptMessage("m1", observedUsage)]);
    const { notes, hooks } = noteTaker();
    const meter = new OpenClawMeter(hooks, { pollMs: 0, stateDir: dir, selector: {}, startedAt: now - 500 });
    meter.sync(true);
    expect(meter.totals.totalTokens).toBe(0);
    const byAgent = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { agentId: "main" }, startedAt: now - 500 });
    byAgent.sync(true);
    expect(byAgent.totals.totalTokens).toBe(0);
    meter.end();
    expect(notes).toEqual([`openclaw transcript never located under ${dir}; usage came from the final envelope only`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("matches the explicit key or the id, not the newest entry, and --agent narrows an explicit id to that agent", () => {
    const now = Date.now();
    const { dir } = fakeStateDir(
      {
        "agent:main:telegram:direct:1": { sessionId: "chat-turn", startedAt: now + 100, updatedAt: now + 100 },
        [EXPLICIT_KEY]: { sessionId: SESSION, startedAt: now, sessionFile: undefined },
      },
      [transcriptMessage("m1", { input: 5_000_000, output: 1 })],
    );
    const own = writeTranscript(dir, "main", SESSION + "-own", [transcriptMessage("m1", { input: 100, output: 1 })]);
    const store = path.join(dir, "agents", "main", "sessions", "sessions.json");
    const entries = JSON.parse(fs.readFileSync(store, "utf8")) as Record<string, Record<string, unknown>>;
    (entries[EXPLICIT_KEY] as Record<string, unknown>).sessionFile = own;
    fs.writeFileSync(store, JSON.stringify(entries));
    const byKey = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    byKey.sync();
    expect(byKey.totals.totalTokens).toBe(101);
    expect(byKey.totals.sessionId).toBe(SESSION);
    const byId = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { sessionId: SESSION }, startedAt: now });
    byId.sync();
    expect(byId.totals.totalTokens).toBe(101);
    // The same explicit id under another agent is another session.
    const ops = writeTranscript(dir, "ops", "ops-session", [transcriptMessage("m1", { input: 7, output: 1 })]);
    fs.writeFileSync(path.join(dir, "agents", "ops", "sessions", "sessions.json"), JSON.stringify({ [`agent:ops:explicit:${EXPLICIT}`]: { sessionId: "ops-session", sessionFile: ops, startedAt: now } }));
    const narrowed = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT, agentId: "ops" }, startedAt: now });
    narrowed.sync();
    expect(narrowed.totals.totalTokens).toBe(8);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Findings #4 and #9: a reused session's transcript used to be read from
  // byte 0, billing months of history to the run that reused it.
  test("a reused session bills only what this run appended", () => {
    const now = Date.now();
    const monthsAgo = now - 60 * 86_400_000;
    const history = [transcriptHeader(SESSION, monthsAgo), transcriptMessage("h1", { input: 5_000_000, output: 100 }, undefined, monthsAgo), transcriptMessage("h2", { input: 5_000_000, output: 100 }, undefined, monthsAgo + 1000)];
    // OpenClaw refreshes the store entry's startedAt on reuse; only the file says how old the session is.
    const { dir, transcript } = fakeStateDir({ "agent:main:explicit:nightly": { sessionId: SESSION, startedAt: now, updatedAt: now } }, history);
    const { notes, hooks } = noteTaker();
    const meter = new OpenClawMeter(hooks, { pollMs: 0, stateDir: dir, selector: { sessionId: "nightly" }, startedAt: now });
    meter.sync();
    expect(meter.totals.totalTokens).toBe(0);
    expect(meter.totals.messages).toBe(0);
    expect(notes).toEqual([`openclaw session ${SESSION} existed before this run; only what it appended after ${new Date(now).toISOString()} is counted`]);
    // A straggler with an old timestamp is history too; a fresh message is this run's.
    fs.appendFileSync(transcript, jsonl([transcriptMessage("h3", { input: 5_000_000, output: 1 }, undefined, monthsAgo + 2000), transcriptMessage("m1", { input: 100, output: 1 })]));
    meter.sync();
    expect(meter.totals.totalTokens).toBe(101);
    expect(meter.totals.messages).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a session the store dates before the run is read from where it stands, even without a header line", () => {
    const now = Date.now();
    const { dir, transcript } = fakeStateDir({ "agent:main:explicit:nightly": { sessionId: SESSION, startedAt: now - 86_400_000, updatedAt: now } }, [
      { type: "message", id: "h1", message: { role: "assistant", content: [], model: "deepseek-v4-pro:cloud", usage: { input: 5_000_000, output: 1 } } },
    ]);
    const meter = new OpenClawMeter({}, { pollMs: 0, stateDir: dir, selector: { sessionId: "nightly" }, startedAt: now });
    meter.sync();
    expect(meter.totals.totalTokens).toBe(0);
    fs.appendFileSync(transcript, jsonl([transcriptMessage("m1", { input: 100, output: 1 })]));
    meter.sync();
    expect(meter.totals.totalTokens).toBe(101);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Finding #6: openSync and readSync were outside the try, so an unreadable
  // transcript threw out of the poll timer and out of end().
  test("sync never throws: an unreadable transcript is one note, not a crash", async () => {
    const now = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-openclaw-"));
    const sessions = path.join(dir, "agents", "main", "sessions");
    const asDirectory = path.join(sessions, "not-a-file");
    fs.mkdirSync(asDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessions, "sessions.json"), JSON.stringify({ [EXPLICIT_KEY]: { sessionId: SESSION, sessionFile: asDirectory, startedAt: now } }));
    const notes: string[] = [];
    // The note hook throws too, to show the timer survives a hook that does.
    const hooks = { onNote: (n: string) => { notes.push(n); throw new Error("hook failed"); } };
    const meter = new OpenClawMeter(hooks, { pollMs: 5, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    await new Promise((r) => setTimeout(r, 40));
    expect(() => meter.sync()).not.toThrow();
    expect(() => meter.sync(true)).not.toThrow();
    expect(() => meter.end()).not.toThrow();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`^openclaw transcript ${asDirectory} could not be read \\(EISDIR\\)`));
    expect(meter.totals.totalTokens).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a transcript that is not written yet is not a failure", () => {
    const now = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-openclaw-"));
    const sessions = path.join(dir, "agents", "main", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const later = path.join(sessions, "later.jsonl");
    fs.writeFileSync(path.join(sessions, "sessions.json"), JSON.stringify({ [EXPLICIT_KEY]: { sessionId: SESSION, sessionFile: later, startedAt: now } }));
    const { notes, hooks } = noteTaker();
    const meter = new OpenClawMeter(hooks, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    meter.sync();
    expect(notes).toEqual([]);
    fs.writeFileSync(later, jsonl([transcriptMessage("m1", { input: 100, output: 1 })]));
    meter.sync();
    expect(meter.totals.totalTokens).toBe(101);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Finding #8, second half: once a transcript was cached the envelope's
  // session id was never compared with it.
  test("an envelope naming another session discards the tailer's count and reads the right transcript", () => {
    const now = Date.now();
    const wrong = [transcriptMessage("w1", { input: 100, output: 1 }, [{ type: "toolCall", id: "c1", name: "exec", arguments: { command: "rm -rf /" } }])];
    const { dir } = fakeStateDir({ [EXPLICIT_KEY]: { sessionId: "someone-elses-uuid", startedAt: now } }, wrong);
    const right = writeTranscript(dir, "main", "the-right-file", [transcriptMessage("r1", observedUsage, [{ type: "toolCall", id: "c2", name: "write", arguments: { path: "/tmp/right.txt" } }])]);
    const store = path.join(dir, "agents", "main", "sessions", "sessions.json");
    const entries = JSON.parse(fs.readFileSync(store, "utf8")) as Record<string, unknown>;
    entries["agent:main:main"] = { sessionId: SESSION, sessionFile: right, startedAt: now };
    fs.writeFileSync(store, JSON.stringify(entries));
    const { notes, hooks } = noteTaker();
    const meter = new OpenClawMeter(hooks, { pollMs: 0, stateDir: dir, selector: { sessionId: EXPLICIT }, startedAt: now });
    meter.sync();
    expect(meter.totals.totalTokens).toBe(101);
    expect(meter.totals.commands).toEqual(["rm -rf /"]);
    meter.feed(pretty);
    expect(notes).toEqual([`the envelope names session ${SESSION} but the transcript tailed was session someone-elses-uuid; its 101 tokens, tool calls and commands were discarded`]);
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.commands).toEqual([]);
    expect(meter.totals.toolCalls).toEqual({});
    expect(meter.totals.sessionId).toBe(SESSION);
    meter.end();
    expect(meter.totals.totalTokens).toBe(22918);
    expect(meter.totals.messages).toBe(1);
    expect(meter.totals.toolCalls).toEqual({ write: 1 });
    expect(meter.totals.filesWritten).toEqual(["/tmp/right.txt"]);
    expect(meter.totals.commands).toEqual([]);
    expect(notes).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a missing state dir is not an error", () => {
    const { notes, hooks } = noteTaker();
    const meter = new OpenClawMeter(hooks, { pollMs: 0, stateDir: "/nonexistent/openclaw", selector: { sessionId: EXPLICIT } });
    meter.sync(true);
    meter.end();
    expect(meter.totals.totalTokens).toBe(0);
    expect(notes).toEqual(["openclaw transcript never located under /nonexistent/openclaw; usage came from the final envelope only"]);
  });
});
