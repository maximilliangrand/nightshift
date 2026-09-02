// One enormous stream-json event with no trailing newline, then silence.
// The meter must count it without waiting for a newline that never comes.
const init = { type: "system", subtype: "init", model: "claude-opus-5", session_id: "crash-noeol" };
console.log(JSON.stringify(init));
const message = {
  id: "msg_huge",
  model: "claude-opus-5",
  usage: { input_tokens: 900_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  content: [{ type: "text", text: "no newline after me" }],
};
process.stdout.write(JSON.stringify({ type: "assistant", message }));
setInterval(() => {}, 1 << 30);
