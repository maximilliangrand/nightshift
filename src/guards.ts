/**
 * A guard looks at the run and says "kill it" or nothing. Guards are polled
 * on a fixed tick; each one is a few lines of arithmetic over a shared
 * context, so a new limit is a new class here and a new flag in the CLI.
 */
import fs from "node:fs";
import type { UsageTotals } from "./meters/claude.js";
import type { DiskMeter } from "./meters/disk.js";
import { fmtBytes, fmtCount, fmtDuration, fmtMoney } from "./units.js";

export interface Verdict {
  guard: string;
  reason: string;
}

export interface GuardContext {
  now: number;
  startedAt: number;
  lastOutputAt: number;
  outputBytes: number;
  usage: UsageTotals;
}

export interface Guard {
  readonly name: string;
  describe(): string;
  check(ctx: GuardContext): Verdict | null | Promise<Verdict | null>;
}

export class WallClockGuard implements Guard {
  readonly name = "max-runtime";
  constructor(private readonly maxMs: number) {}
  describe(): string {
    return `runtime ≤ ${fmtDuration(this.maxMs)}`;
  }
  check(ctx: GuardContext): Verdict | null {
    const elapsed = ctx.now - ctx.startedAt;
    return elapsed >= this.maxMs
      ? { guard: this.name, reason: `ran for ${fmtDuration(elapsed)}, limit ${fmtDuration(this.maxMs)}` }
      : null;
  }
}

/** The hung-subprocess watchdog: no output for this long means it is stuck. */
export class IdleGuard implements Guard {
  readonly name = "idle-timeout";
  constructor(private readonly idleMs: number) {}
  describe(): string {
    return `no output for ≤ ${fmtDuration(this.idleMs)}`;
  }
  check(ctx: GuardContext): Verdict | null {
    const idle = ctx.now - ctx.lastOutputAt;
    return idle >= this.idleMs
      ? { guard: this.name, reason: `silent for ${fmtDuration(idle)}, limit ${fmtDuration(this.idleMs)}` }
      : null;
  }
}

export class KillFileGuard implements Guard {
  readonly name = "kill-file";
  /** builtin: the per-run and global stop files that every run has. */
  constructor(
    private readonly path: string,
    readonly builtin = false,
  ) {}
  describe(): string {
    return `stop when ${this.path} exists`;
  }
  check(): Verdict | null {
    return fs.existsSync(this.path) ? { guard: this.name, reason: `kill file present: ${this.path}` } : null;
  }
}

export class TokenGuard implements Guard {
  readonly name = "max-tokens";
  constructor(private readonly maxTokens: number) {}
  describe(): string {
    return `tokens ≤ ${fmtCount(this.maxTokens)}`;
  }
  check(ctx: GuardContext): Verdict | null {
    const used = ctx.usage.totalTokens;
    return used >= this.maxTokens
      ? { guard: this.name, reason: `${fmtCount(used)} tokens used, limit ${fmtCount(this.maxTokens)}` }
      : null;
  }
}

export class BudgetGuard implements Guard {
  readonly name = "budget";
  constructor(private readonly maxUsd: number) {}
  describe(): string {
    return `spend ≤ ${fmtMoney(this.maxUsd)}`;
  }
  check(ctx: GuardContext): Verdict | null {
    const spent = ctx.usage.actualUsd ?? ctx.usage.estimatedUsd;
    return spent >= this.maxUsd
      ? { guard: this.name, reason: `${fmtMoney(spent)} spent (${ctx.usage.actualUsd ? "reported" : "estimated"}), limit ${fmtMoney(this.maxUsd)}` }
      : null;
  }
}

export class OutputGuard implements Guard {
  readonly name = "max-output";
  constructor(private readonly maxBytes: number) {}
  describe(): string {
    return `output ≤ ${fmtBytes(this.maxBytes)}`;
  }
  check(ctx: GuardContext): Verdict | null {
    return ctx.outputBytes >= this.maxBytes
      ? { guard: this.name, reason: `${fmtBytes(ctx.outputBytes)} of output, limit ${fmtBytes(this.maxBytes)}` }
      : null;
  }
}

export class DiskGuard implements Guard {
  readonly name = "max-disk-growth";
  private lastCheck = 0;
  constructor(
    private readonly meter: DiskMeter,
    private readonly maxGrowthBytes: number,
    private readonly everyMs = 10_000,
  ) {}
  describe(): string {
    return `disk growth ≤ ${fmtBytes(this.maxGrowthBytes)} (${this.meter.describe()})`;
  }
  async check(ctx: GuardContext): Promise<Verdict | null> {
    if (ctx.now - this.lastCheck < this.everyMs) return null;
    this.lastCheck = ctx.now;
    const growth = await this.meter.growth();
    if (growth.bytes >= this.maxGrowthBytes) {
      return {
        guard: this.name,
        reason: `${growth.where} grew ${fmtBytes(growth.bytes)}, limit ${fmtBytes(this.maxGrowthBytes)}`,
      };
    }
    return null;
  }
}
