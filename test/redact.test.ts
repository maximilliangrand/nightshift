import { describe, expect, test } from "bun:test";
import { childEnv, redact } from "../src/redact";

describe("redact", () => {
  test("telegram bot tokens in URLs", () => {
    const cmd = "curl -s https://api.telegram.org/bot123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TVAtN9KNM8U/sendMessage -d chat_id=1";
    expect(redact(cmd)).toBe("curl -s https://api.telegram.org/bot[redacted]/sendMessage -d chat_id=1");
  });
  test("discord webhooks, bearer headers, api keys, query params", () => {
    expect(redact("https://discord.com/api/webhooks/1234567890/abcDEF_ghi-JKL")).toBe("https://discord.com/api/webhooks/[redacted]");
    expect(redact('-H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz"')).toBe('-H "Authorization: Bearer [redacted]"');
    expect(redact("curl https://x.example/?q=1&token=abcdef123456&x=2")).toBe("curl https://x.example/?q=1&token=[redacted]&x=2");
    expect(redact("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("export OPENAI_API_KEY=sk-[redacted]");
    expect(redact("gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("gh auth login --with-token gh_[redacted]");
  });
  test("leaves ordinary commands alone", () => {
    for (const cmd of ["git status", "python3 hello.py", "ls -la ~/.ssh", "npm test -- --key=value"]) {
      expect(redact(cmd)).toBe(cmd.replace("--key=value", "--key=value"));
    }
    expect(redact("git status")).toBe("git status");
  });
});

describe("childEnv", () => {
  test("strips supervisor-only secrets and adds the marker", () => {
    const env = childEnv(
      { PATH: "/bin", NIGHTSHIFT_TELEGRAM_TOKEN: "t", NIGHTSHIFT_TELEGRAM_CHAT: "c", NIGHTSHIFT_DISCORD_WEBHOOK: "w", NIGHTSHIFT_WEBHOOK: "h", HOME: "/h" },
      { NIGHTSHIFT_RUN_ID: "r1" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", NIGHTSHIFT_RUN_ID: "r1" });
  });
});
