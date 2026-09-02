// Traps SIGTERM and carries on. Only SIGKILL ends this one.
process.on("SIGTERM", () => console.log("ignore-sigterm: nice try"));
process.on("SIGINT", () => console.log("ignore-sigterm: nope"));
setInterval(() => console.log("ignore-sigterm: working"), 300);
