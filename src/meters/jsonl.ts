/**
 * Splits a stdout stream into JSON Lines for a meter. Chunks arrive at
 * arbitrary boundaries, so lines are assembled in a buffer; a complete object
 * that never gets its newline is still handed over as soon as it parses,
 * because an agent that stops mid-stream must still be counted.
 */
export class JsonlStream {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    const rest = this.buffer.trimEnd();
    if (rest.startsWith("{") && rest.endsWith("}")) {
      try {
        JSON.parse(rest);
      } catch {
        return;
      }
      this.buffer = "";
      this.onLine(rest);
    }
  }

  /** The stream ended: whatever is left is a line, newline or not. */
  end(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.onLine(rest);
  }
}
