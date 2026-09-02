// Writes 2 MB every 50 ms into the working directory until stopped.
import fs from "node:fs";
fs.mkdirSync("fill", { recursive: true });
const chunk = Buffer.alloc(2 * 1024 * 1024, 0x41);
let i = 0;
setInterval(() => {
  fs.writeFileSync(`fill/${i++}.bin`, chunk);
  if (i % 10 === 0) console.log(`disk-filler: ${i * 2} MB written`);
}, 50);
