// Prints a megabyte every few milliseconds. Logs are disk too.
const line = "output-flood: " + "x".repeat(1024 * 1024 - 20) + "\n";
setInterval(() => process.stdout.write(line), 5);
