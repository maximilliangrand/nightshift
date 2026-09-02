/**
 * Secrets have a habit of appearing in the very commands worth ledgering:
 * a Telegram send carries the bot token in its URL. Anything that is stored,
 * rendered or shipped to a webhook goes through here first.
 */

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, "bot[redacted]"],
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g, "https://discord.com/api/webhooks/[redacted]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]"],
  [/([?&;,]\s*(?:token|key|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|auth)=)[^\s&"']+/gi, "$1[redacted]"],
  [/(\b(?:[a-z-]*(?:token|secret|key|auth|password)[a-z-]*)[=:]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of REPLACEMENTS) out = out.replace(re, replacement);
  return out;
}

/** Environment variables the supervisor needs and the agent must never see. */
export const SUPERVISOR_ONLY_ENV = [
  "NIGHTSHIFT_TELEGRAM_TOKEN",
  "NIGHTSHIFT_TELEGRAM_CHAT",
  "NIGHTSHIFT_DISCORD_WEBHOOK",
  "NIGHTSHIFT_WEBHOOK",
  "NIGHTSHIFT_PRICES",
];

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const name of SUPERVISOR_ONLY_ENV) delete env[name];
  return env;
}
