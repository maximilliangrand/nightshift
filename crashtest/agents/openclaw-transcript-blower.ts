// Behaves like the OpenClaw gateway during a turn the CLI started with
// --session-id crash: registers that session, then appends an assistant message
// with 100k input tokens every 100 ms. stdout stays silent until the turn would end.
import fs from "node:fs";
import path from "node:path";
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
if (!path.isAbsolute(stateDir)) throw new Error("OPENCLAW_STATE_DIR must be absolute; the suite writes only under its temp dirs");
const sessions = path.join(stateDir, "agents", "main", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const transcript = path.join(sessions, "crash-session.jsonl");
fs.writeFileSync(transcript, JSON.stringify({ type: "session", version: 3, id: "crash-session", timestamp: new Date().toISOString() }) + "\n");
const entry = { sessionId: "crash-session", sessionFile: transcript, startedAt: Date.now(), updatedAt: Date.now() };
fs.writeFileSync(path.join(sessions, "sessions.json"), JSON.stringify({ "agent:main:explicit:crash": entry }));
let n = 0;
setInterval(() => {
  n += 1;
  const usage = { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  const message = { role: "assistant", content: [{ type: "text", text: `turn ${n}` }], model: "deepseek-v4-pro:cloud", usage };
  fs.appendFileSync(transcript, JSON.stringify({ type: "message", id: `m${n}`, timestamp: new Date().toISOString(), message }) + "\n");
}, 100);
