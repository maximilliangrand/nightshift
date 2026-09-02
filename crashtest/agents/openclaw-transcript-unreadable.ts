// Behaves like a gateway whose session store points at a transcript that
// cannot be read (here, a directory). The poll timer used to throw out of the
// supervisor, which died with no report while the agent ran on.
import fs from "node:fs";
import path from "node:path";
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
if (!path.isAbsolute(stateDir)) throw new Error("OPENCLAW_STATE_DIR must be absolute; the suite writes only under its temp dirs");
const sessions = path.join(stateDir, "agents", "main", "sessions");
const transcript = path.join(sessions, "unreadable.jsonl");
fs.mkdirSync(transcript, { recursive: true });
fs.writeFileSync(path.join(sessions, "sessions.json"), JSON.stringify({ "agent:main:explicit:crash": { sessionId: "crash-session", sessionFile: transcript, startedAt: Date.now() } }));
setTimeout(() => {
  const agentMeta = { sessionId: "crash-session", provider: "ollama", model: "deepseek-v4-pro:cloud", usage: { input: 1000, output: 1, total: 1001 } };
  console.log(JSON.stringify({ runId: "crash-unreadable", status: "ok", summary: "completed", result: { payloads: [{ text: "done" }], meta: { durationMs: 2500, agentMeta, stopReason: "stop" } } }, null, 2));
}, 2500);
