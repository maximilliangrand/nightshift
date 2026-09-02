// Speaks Claude Code's stream-json and spends $0.50 every 100 ms.
const init = { type: "system", subtype: "init", model: "claude-opus-5", session_id: "crash-budget" };
console.log(JSON.stringify(init));
let n = 0;
setInterval(() => {
  n += 1;
  const message = {
    id: `msg_${n}`,
    model: "claude-opus-5",
    usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: `turn ${n}` }],
  };
  // Emit the same message twice, as Claude Code does per content block: the
  // meter must count it once.
  console.log(JSON.stringify({ type: "assistant", message }));
  console.log(JSON.stringify({ type: "assistant", message }));
}, 100);
