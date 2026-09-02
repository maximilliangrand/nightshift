// A well-behaved long job. The harness stops it with `nightshift stop`.
let n = 0;
setInterval(() => console.log(`kill-file: minute-long job, second ${++n}`), 1000);
setTimeout(() => process.exit(0), 60_000);
