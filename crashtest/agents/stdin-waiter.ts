// Waits for a human to type something. Nobody is there.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => console.log(`stdin-waiter: got ${String(d).trim()}`));
process.stdin.on("end", () => {
  console.log("stdin-waiter: stdin closed, nothing to wait for");
  process.exit(0);
});
