// Tries to send twenty messages, plus one repeat. The ledger allows five.
import { spawnSync } from "node:child_process";
const bin = (process.env.NIGHTSHIFT_BIN ?? "nightshift").split(" ");
const scope = `crashtest-${process.pid}`;
let sent = 0;
let refused = 0;
const attempt = (key: string) => {
  const r = spawnSync(bin[0] as string, [...bin.slice(1), "ledger", "claim", "--scope", scope, "--key", key, "--limit", "5/day"], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status === 0) sent += 1;
  else refused += 1;
};
for (let i = 0; i < 20; i++) attempt(`msg-${i}`);
attempt("msg-0");
console.log(`send-loop: sent ${sent}, refused ${refused}`);
