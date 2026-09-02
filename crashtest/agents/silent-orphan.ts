// The red team's favourite: detach an Apple platform binary (its environment
// is invisible to `ps -E`) into a new session, print nothing, exit at once.
import { spawn } from "node:child_process";
const child = spawn("/bin/sleep", ["4242"], { detached: true, stdio: "ignore" });
child.unref();
process.exit(0);
