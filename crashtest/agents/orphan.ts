// Detaches a child into its own session (escaping our process group), then
// exits cleanly. The child must not outlive the run.
import { spawn } from "node:child_process";
const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
child.unref();
console.log(`orphan: left sleep pid ${child.pid} behind, exiting 0`);
setTimeout(() => process.exit(0), 1500);
