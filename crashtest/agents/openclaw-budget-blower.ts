// Prints the JSON envelope `openclaw agent --json` prints at the end of a turn
// (shape captured from OpenClaw 2026.4.10), with usage inflated to $50 at the
// ceiling price, then lingers the way the real CLI does while it tears down
// its gateway connection. The budget must fire on that chunk.
const envelope = {
  runId: "crash-openclaw",
  status: "ok",
  summary: "completed",
  result: {
    payloads: [{ text: "done", mediaUrl: null }],
    meta: {
      durationMs: 7552,
      agentMeta: { sessionId: "crash-session", provider: "ollama", model: "deepseek-v4-pro:cloud", usage: { input: 5_000_000, output: 3, total: 5_000_003 } },
      stopReason: "stop",
    },
  },
};
console.log(JSON.stringify(envelope, null, 2));
setTimeout(() => {}, 20_000);
