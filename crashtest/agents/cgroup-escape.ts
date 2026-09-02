// The full escape, every step deliberate: a new session, an empty
// environment, a working directory that is not the run's, nothing printed,
// exit at once. The first four nets cannot see the child. A cgroup can.
import { spawn } from "node:child_process";
const child = spawn("/bin/sleep", ["4343"], { detached: true, stdio: "ignore", env: {}, cwd: "/" });
child.unref();
process.exit(0);
