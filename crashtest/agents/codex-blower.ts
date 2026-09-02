// Speaks `codex exec --json` and spends without limit: every 100 ms the
// thread total grows by 100k input tokens, and each turn.completed is emitted
// twice, as a running total that the meter must not add up twice.
console.log(JSON.stringify({ type: "thread.started", thread_id: "crash-codex" }));
console.log(JSON.stringify({ type: "turn.started" }));
let input = 0;
setInterval(() => {
  input += 100_000;
  const usage = { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  console.log(JSON.stringify({ type: "item.completed", item: { id: `item_${input}`, type: "agent_message", text: `total ${input}` } }));
  console.log(JSON.stringify({ type: "turn.completed", usage }));
  console.log(JSON.stringify({ type: "turn.completed", usage }));
}, 100);
