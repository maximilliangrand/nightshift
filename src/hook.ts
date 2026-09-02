/**
 * Claude Code PreToolUse hook. Claude Code pipes the pending tool call to us
 * as JSON on stdin; we answer with a permission decision on stdout.
 *
 * Rules live in ~/.nightshift/hook.json. Each rule matches a Bash command by
 * regex and names a ledger scope and a rate. A matching command must claim a
 * ledger key (the hash of the command) before it may run: a duplicate or a
 * capped scope is denied with a reason Claude can read and act on, so a loop
 * that would have sent the same message twenty times sends it once and is
 * told why the rest were refused.
 *
 * The hook fails open. If our own code throws, the call falls through to
 * Claude Code's normal permission flow rather than blocking the agent on a
 * bug in the safety net. Refusals are the ledger's job and are deterministic.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claim } from "./ledger.js";
import { nightshiftHome, ensureDirs } from "./store.js";
import { parseRate, type Rate } from "./units.js";

export interface HookRule {
  /** Regular expression tested against the Bash command (case-insensitive). */
  match: string;
  /** Ledger scope the claim goes into, e.g. "telegram". */
  scope: string;
  /** Rate like "40/day". Omit for dedupe only. */
  limit?: string;
  /** What this rule is for, echoed in denials. */
  note?: string;
}

export interface HookConfig {
  rules: HookRule[];
}

export function hookConfigPath(): string {
  return path.join(nightshiftHome(), "hook.json");
}

export function readHookConfig(): HookConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(hookConfigPath(), "utf8")) as HookConfig;
    return { rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
  } catch {
    return { rules: [] };
  }
}

export function writeHookConfig(config: HookConfig): void {
  ensureDirs();
  fs.writeFileSync(hookConfigPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

export type HookDecision =
  | { decision: "pass" }
  | { decision: "allow"; rule: HookRule; key: string }
  | { decision: "deny"; rule: HookRule; key: string; reason: string };

export function commandKey(command: string): string {
  return crypto.createHash("sha256").update(command.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 24);
}

/** Pure decision logic, given a claim function, so it is testable without disk. */
export async function decide(
  input: HookInput,
  rules: HookRule[],
  claimFn: (scope: string, key: string, limit: Rate | undefined, meta: Record<string, unknown>) => ReturnType<typeof claim>,
): Promise<HookDecision> {
  if (input.tool_name !== "Bash") return { decision: "pass" };
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !command) return { decision: "pass" };

  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.match, "i");
    } catch {
      continue;
    }
    if (!re.test(command)) continue;
    const key = commandKey(command);
    const limit = rule.limit ? parseRate(rule.limit) : undefined;
    const result = await claimFn(rule.scope, key, limit, { session: input.session_id, command: command.slice(0, 200) });
    if (result.ok) return { decision: "allow", rule, key };
    const what = rule.note ? `${rule.note} ` : "";
    const reason =
      result.reason === "duplicate"
        ? `nightshift ledger: ${what}this exact command already ran at ${result.firstClaimedAt} (scope "${rule.scope}"). Do not retry it; the side effect already happened.`
        : `nightshift ledger: ${what}scope "${rule.scope}" is at its limit of ${result.limit}/${result.window} (${result.count} used). Stop sending; do not work around this limit.`;
    return { decision: "deny", rule, key, reason };
  }
  return { decision: "pass" };
}

/** Read stdin fully, decide, print Claude Code's expected JSON. */
export async function runHook(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<number> {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return 0;
  }
  const { rules } = readHookConfig();
  const result = await decide(input, rules, (scope, key, limit, meta) =>
    claim({ scope, key, limit, meta, run: process.env.NIGHTSHIFT_RUN_ID }),
  );
  if (result.decision === "deny") {
    stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      }) + "\n",
    );
  }
  return 0;
}

/** Wire `nightshift hook` into ~/.claude/settings.json as a Bash PreToolUse hook. */
export function installIntoClaudeSettings(command = "nightshift hook"): { path: string; changed: boolean } {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    // No settings yet.
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const pre = (hooks.PreToolUse ?? []) as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>;
  const already = pre.some((entry) => entry.hooks?.some((h) => h.command === command));
  if (already) return { path: settingsPath, changed: false };
  pre.push({ matcher: "Bash", hooks: [{ type: "command", command }] });
  hooks.PreToolUse = pre;
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { path: settingsPath, changed: true };
}

export function uninstallFromClaudeSettings(command = "nightshift hook"): { path: string; changed: boolean } {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { path: settingsPath, changed: false };
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const pre = (hooks.PreToolUse ?? []) as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>;
  const kept = pre.filter((entry) => !entry.hooks?.some((h) => h.command === command));
  if (kept.length === pre.length) return { path: settingsPath, changed: false };
  hooks.PreToolUse = kept;
  settings.hooks = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { path: settingsPath, changed: true };
}
