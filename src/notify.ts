/**
 * Delivery of the report. Telegram and Discord need nothing but an env var,
 * because the report is the thing you read on your phone before you get up.
 *
 *   NIGHTSHIFT_TELEGRAM_TOKEN + NIGHTSHIFT_TELEGRAM_CHAT
 *   NIGHTSHIFT_DISCORD_WEBHOOK
 *   NIGHTSHIFT_WEBHOOK            any URL; receives the report JSON by POST
 *
 * Every channel is best-effort and fails loud into the run's notes rather
 * than throwing: a notification that could not be sent must not turn a
 * completed run into a failed one. Delivery runs before the report files are
 * written so a failure lands in the notes, and every request has a timeout so
 * a hung endpoint cannot hold the exit.
 */
import type { RunReport } from "./report.js";
import { renderShort } from "./report.js";

const FETCH_TIMEOUT_MS = 15_000;

export type Channel = "telegram" | "discord" | "webhook" | "stdout";

export const CHANNELS: Channel[] = ["telegram", "discord", "webhook", "stdout"];

export interface NotifyResult {
  channel: Channel;
  ok: boolean;
  detail?: string;
}

export async function notify(channels: Channel[], report: RunReport): Promise<NotifyResult[]> {
  const results: NotifyResult[] = [];
  for (const channel of channels) results.push(await send(channel, report));
  return results;
}

async function send(channel: Channel, report: RunReport): Promise<NotifyResult> {
  try {
    switch (channel) {
      case "stdout":
        process.stdout.write("\n" + renderShort(report) + "\n");
        return { channel, ok: true };
      case "telegram":
        return await telegram(report);
      case "discord":
        return await discord(report);
      case "webhook":
        return await webhook(report);
    }
  } catch (err) {
    return { channel, ok: false, detail: (err as Error).message };
  }
}

async function telegram(report: RunReport): Promise<NotifyResult> {
  const token = process.env.NIGHTSHIFT_TELEGRAM_TOKEN;
  const chat = process.env.NIGHTSHIFT_TELEGRAM_CHAT;
  if (!token || !chat) return { channel: "telegram", ok: false, detail: "NIGHTSHIFT_TELEGRAM_TOKEN / NIGHTSHIFT_TELEGRAM_CHAT not set" };
  const text = renderShort(report).slice(0, 4000);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  return { channel: "telegram", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
}

async function discord(report: RunReport): Promise<NotifyResult> {
  const url = process.env.NIGHTSHIFT_DISCORD_WEBHOOK;
  if (!url) return { channel: "discord", ok: false, detail: "NIGHTSHIFT_DISCORD_WEBHOOK not set" };
  const content = "```\n" + renderShort(report).slice(0, 1900) + "\n```";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ content, username: "nightshift" }),
  });
  return { channel: "discord", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
}

async function webhook(report: RunReport): Promise<NotifyResult> {
  const url = process.env.NIGHTSHIFT_WEBHOOK;
  if (!url) return { channel: "webhook", ok: false, detail: "NIGHTSHIFT_WEBHOOK not set" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "nightshift" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify(report),
  });
  return { channel: "webhook", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
}
