// Behaves like the gateway when --session-id nightly names a session with two
// months of history: the transcript already holds 10M tokens, the store entry is
// refreshed to now, and this run's own small turn lands after the file was found.
import fs from "node:fs";
import path from "node:path";
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
if (!path.isAbsolute(stateDir)) throw new Error("OPENCLAW_STATE_DIR must be absolute; the suite writes only under its temp dirs");
const sessions = path.join(stateDir, "agents", "main", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const transcript = path.join(sessions, "reused.jsonl");
const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
const message = (id: string, input: number, timestamp: string) => JSON.stringify({ type: "message", id, timestamp, message: { role: "assistant", content: [], model: "deepseek-v4-pro:cloud", usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + "\n";
fs.writeFileSync(transcript, JSON.stringify({ type: "session", version: 3, id: "reused", timestamp: old }) + "\n" + message("h1", 5_000_000, old) + message("h2", 5_000_000, old));
fs.writeFileSync(path.join(sessions, "sessions.json"), JSON.stringify({ "agent:main:explicit:nightly": { sessionId: "reused", sessionFile: transcript, startedAt: Date.now(), updatedAt: Date.now() } }));
setTimeout(() => {
  fs.appendFileSync(transcript, message("m1", 1000, new Date().toISOString()));
  const agentMeta = { sessionId: "reused", provider: "ollama", model: "deepseek-v4-pro:cloud", usage: { input: 1000, output: 1, total: 1001 } };
  console.log(JSON.stringify({ runId: "crash-reused", status: "ok", summary: "completed", result: { payloads: [{ text: "done" }], meta: { durationMs: 3000, agentMeta, stopReason: "stop" } } }, null, 2));
}, 3000);
