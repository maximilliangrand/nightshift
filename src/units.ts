/**
 * Human units in, numbers out. Every limit on the command line goes through
 * here, so "2h", "5usd", "500mb", "2M" and "40/day" all mean what a tired
 * person at 23:00 expects them to mean.
 */

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
};

/** "90s", "2h", "1h30m", "45" (seconds when bare). Returns milliseconds. */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|sec|min|hr|[smhd])/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(re)) {
    const unit = DURATION_UNITS[match[2] ?? ""];
    if (unit === undefined) break;
    total += Number(match[1]) * unit;
    consumed += match[0].length;
  }
  if (consumed !== text.replace(/\s+/g, "").length || total <= 0) {
    throw new Error(`Cannot read duration "${input}" (try 90s, 15m, 2h, 1h30m)`);
  }
  return Math.round(total);
}

/** "5usd", "$5", "5", "0.50". Returns US dollars. */
export function parseMoney(input: string): number {
  const text = input.trim().toLowerCase().replace(/^\$/, "").replace(/usd$/, "").trim();
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Cannot read amount "${input}" (try 5usd, $5, 0.50)`);
  }
  return value;
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/** "500mb", "2gb", "1024" (bytes when bare). Returns bytes. */
export function parseBytes(input: string): number {
  const match = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) throw new Error(`Cannot read size "${input}" (try 500mb, 2gb)`);
  const unit = BYTE_UNITS[match[2] ?? "b"] ?? 1;
  const value = Number(match[1]) * unit;
  if (value <= 0) throw new Error(`Size "${input}" must be positive`);
  return Math.round(value);
}

/** "2M", "500k", "1500000". Returns a count. */
export function parseCount(input: string): number {
  const match = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) throw new Error(`Cannot read count "${input}" (try 500k, 2M)`);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const value = Number(match[1]) * scale;
  if (value <= 0) throw new Error(`Count "${input}" must be positive`);
  return Math.round(value);
}

export interface Rate {
  limit: number;
  windowMs: number;
  window: "minute" | "hour" | "day";
}

const RATE_WINDOWS: Record<string, Rate["window"]> = {
  m: "minute",
  min: "minute",
  minute: "minute",
  h: "hour",
  hr: "hour",
  hour: "hour",
  d: "day",
  day: "day",
};

/** "40/day", "10/hour", "3/min". A sliding window, not a calendar one. */
export function parseRate(input: string): Rate {
  const match = input.trim().toLowerCase().match(/^(\d+)\s*(?:\/|per)\s*(m|min|minute|h|hr|hour|d|day)$/);
  if (!match) throw new Error(`Cannot read rate "${input}" (try 40/day, 10/hour)`);
  const window = RATE_WINDOWS[match[2] ?? ""];
  if (!window) throw new Error(`Cannot read rate window in "${input}"`);
  const windowMs = window === "minute" ? 60_000 : window === "hour" ? 3_600_000 : 86_400_000;
  return { limit: Number(match[1]), windowMs, window };
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minRest = minutes % 60;
  return minRest ? `${hours}h${minRest}m` : `${hours}h`;
}

export function fmtBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (value < 1024 || unit === "TB") return `${sign}${value < 10 && unit !== "B" ? value.toFixed(1) : Math.round(value)}${unit}`;
    value /= 1024;
  }
  return `${sign}${Math.round(value)}TB`;
}

export function fmtMoney(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
