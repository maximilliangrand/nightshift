// Prints once, then goes silent forever. The classic hung subprocess.
console.log("hang: starting work");
setInterval(() => {}, 1 << 30);
