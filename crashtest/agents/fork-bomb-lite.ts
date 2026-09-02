// Thirty children, then the parent goes quiet. All of them must die together.
import { spawn } from "node:child_process";
const kids = Array.from({ length: 30 }, () => spawn("sleep", ["300"], { stdio: "ignore" }));
console.log(`fork-bomb-lite: spawned ${kids.length} children, going silent`);
setInterval(() => {}, 1 << 30);
