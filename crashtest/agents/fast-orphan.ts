// Detaches a child into its own session and exits almost at once, before
// the first guard tick. The child must still be found and killed.
import { spawn } from "node:child_process";
const child = spawn("bun", ["-e", "setTimeout(() => {}, 300000)"], { detached: true, stdio: "ignore" });
child.unref();
console.log(`fast-orphan: left pid ${child.pid} behind, exiting now`);
setTimeout(() => process.exit(0), 60);
