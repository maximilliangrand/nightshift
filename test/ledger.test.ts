import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claim, entriesForRun, readLedger, summarize } from "../src/ledger";
import { parseRate } from "../src/units";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-ledger-"));
  process.env.NIGHTSHIFT_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.NIGHTSHIFT_HOME;
});

describe("ledger", () => {
  test("first claim ok, same key refused as duplicate", async () => {
    expect(await claim({ scope: "tg", key: "a" })).toEqual({ ok: true, count: 1 });
    const dup = await claim({ scope: "tg", key: "a" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe("duplicate");
    const s = summarize("tg");
    expect(s.claims).toBe(1);
    expect(s.refusedDuplicate).toBe(1);
  });

  test("rate limit is a sliding window", async () => {
    const limit = parseRate("3/hour");
    const t0 = Date.parse("2026-09-02T22:00:00Z");
    for (let i = 0; i < 3; i++) expect((await claim({ scope: "wa", key: `k${i}`, limit, now: t0 + i * 1000 })).ok).toBe(true);
    const capped = await claim({ scope: "wa", key: "k3", limit, now: t0 + 5000 });
    expect(capped.ok).toBe(false);
    if (!capped.ok && capped.reason === "capped") {
      expect(capped.limit).toBe(3);
      expect(capped.retryAfterMs).toBe(3_600_000 - 5000);
    }
    // An hour later the window has slid.
    expect((await claim({ scope: "wa", key: "k4", limit, now: t0 + 3_600_001 })).ok).toBe(true);
  });

  test("refusals do not count against the window", async () => {
    const limit = parseRate("1/day");
    expect((await claim({ scope: "x", key: "a", limit })).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await claim({ scope: "x", key: `b${i}`, limit })).ok).toBe(false);
    expect(readLedger("x")).toHaveLength(6);
    expect(summarize("x").claims).toBe(1);
  });

  test("entries are attributed to runs across scopes", async () => {
    await claim({ scope: "a", key: "1", run: "run-1" });
    await claim({ scope: "b", key: "2", run: "run-1" });
    await claim({ scope: "b", key: "3", run: "run-2" });
    const mine = entriesForRun("run-1");
    expect(mine).toHaveLength(2);
    expect(mine.map((e) => e.meta?.scope).sort()).toEqual(["a", "b"]);
  });

  test("concurrent claims serialize through the lock", async () => {
    const limit = parseRate("10/day");
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => claim({ scope: "race", key: `k${i}`, limit })));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
  });

  test("scope names are sanitised", async () => {
    await claim({ scope: "Telegram/Prod Bot", key: "x" });
    expect(fs.existsSync(path.join(home, "ledger", "telegram-prod-bot.jsonl"))).toBe(true);
  });
});
