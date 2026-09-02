// Behaves like the OpenClaw gateway during a turn: registers the session in
// the store, then appends an assistant message with 100k input tokens to the
// transcript every 100 ms. stdout stays silent until the turn would end, so
// only the transcript tailer can see the spend while it happens.
import fs from "node:fs";
import path from "node:path";
const sessions = path.resolve(process.env.OPENCLAW_STATE_DIR ?? "openclaw-state", "agents", "main", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const transcript = path.join(sessions, "crash-session.jsonl");
fs.writeFileSync(transcript, JSON.stringify({ type: "session", version: 3, id: "crash-session" }) + "\n");
const entry = { sessionId: "crash-session", sessionFile: transcript, startedAt: Date.now(), updatedAt: Date.now() };
fs.writeFileSync(path.join(sessions, "sessions.json"), JSON.stringify({ "agent:main:explicit:crash": entry }));
let n = 0;
setInterval(() => {
  n += 1;
  const usage = { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  const message = { role: "assistant", content: [{ type: "text", text: `turn ${n}` }], model: "deepseek-v4-pro:cloud", usage };
  fs.appendFileSync(transcript, JSON.stringify({ type: "message", id: `m${n}`, message }) + "\n");
}, 100);
