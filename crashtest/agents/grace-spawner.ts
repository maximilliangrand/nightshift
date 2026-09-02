// Spawns a detached platform binary from inside its SIGTERM handler, during
// the grace period, then dies. The late child must still be killed.
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {
  const child = spawn("/bin/sleep", ["4343"], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => process.exit(0), 200);
});
setInterval(() => console.log("grace-spawner: working"), 300);
