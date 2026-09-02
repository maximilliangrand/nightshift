import { describe, expect, test } from "bun:test";
import { fmtBytes, fmtDuration, fmtMoney, parseBytes, parseCount, parseDuration, parseMoney, parseRate } from "../src/units";

describe("parseDuration", () => {
  test("units", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45")).toBe(45_000);
  });
  test("rejects junk", () => {
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("0s")).toThrow();
    expect(() => parseDuration("2 hours")).toThrow();
  });
});

describe("parseMoney", () => {
  test("forms", () => {
    expect(parseMoney("5usd")).toBe(5);
    expect(parseMoney("$5")).toBe(5);
    expect(parseMoney("0.50")).toBe(0.5);
    expect(parseMoney("12.5USD")).toBe(12.5);
  });
  test("rejects", () => {
    expect(() => parseMoney("-1")).toThrow();
    expect(() => parseMoney("five")).toThrow();
  });
});

describe("parseBytes / parseCount / parseRate", () => {
  test("bytes", () => {
    expect(parseBytes("500mb")).toBe(500 * 1024 ** 2);
    expect(parseBytes("2GB")).toBe(2 * 1024 ** 3);
    expect(parseBytes("1024")).toBe(1024);
  });
  test("counts", () => {
    expect(parseCount("2M")).toBe(2_000_000);
    expect(parseCount("500k")).toBe(500_000);
    expect(parseCount("42")).toBe(42);
  });
  test("rates", () => {
    expect(parseRate("40/day")).toEqual({ limit: 40, windowMs: 86_400_000, window: "day" });
    expect(parseRate("10 per hour")).toEqual({ limit: 10, windowMs: 3_600_000, window: "hour" });
    expect(parseRate("3/min")).toEqual({ limit: 3, windowMs: 60_000, window: "minute" });
    expect(() => parseRate("40/week")).toThrow();
  });
});

describe("formatters", () => {
  test("duration", () => {
    expect(fmtDuration(500)).toBe("500ms");
    expect(fmtDuration(65_000)).toBe("1m5s");
    expect(fmtDuration(3_600_000)).toBe("1h");
    expect(fmtDuration(5_400_000)).toBe("1h30m");
  });
  test("bytes", () => {
    expect(fmtBytes(512)).toBe("512B");
    expect(fmtBytes(1536)).toBe("1.5KB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0GB");
    expect(fmtBytes(-2048)).toBe("-2.0KB");
  });
  test("money", () => {
    expect(fmtMoney(5)).toBe("$5.00");
    expect(fmtMoney(0.0181649)).toBe("$0.0182");
    expect(fmtMoney(0.5)).toBe("$0.5");
  });
});
