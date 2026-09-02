# The OpenClaw adapter

`--adapter auto` picks this adapter for any command whose basename is `openclaw` and whose subcommand is `agent` (global options such as `--profile work` may come first). `--adapter openclaw` forces it onto anything that prints the same JSON.

```bash
nightshift run --budget 3usd --max-runtime 1h --report telegram \
  -- openclaw agent --agent ops --session-id nightly-$(date +%F) -m "Summarize the logs and file issues"
```

Everything below was observed on OpenClaw 2026.4.10 on 2026-09-02, with the gateway running, by reading `openclaw agent --json` output, the installed `dist/` source and the files under `~/.openclaw`. Not assumed.

## What nightshift changes about the command

- Adds `--json` when it is absent, then renders the reply text and one summary line (`openclaw: completed in 18s · 22.9k tokens on deepseek-v4-pro:cloud via ollama`) back to the terminal and `output.log`, the way it does for Claude Code.
- If `--json` was already there, stdout is left alone and only listened to.
- Nothing else. OpenClaw has no budget or token flag, so a `--budget` cannot be passed through; nightshift is the only line of defence and the report notes say so.

## What is metered, and from where

OpenClaw exposes usage in two places, and the adapter reads both.

### 1. The final JSON envelope on stdout

`openclaw agent --json` prints one pretty-printed object, once, when the turn is over:

```json
{
  "runId": "d9d40de2-...",
  "status": "ok",
  "summary": "completed",
  "result": {
    "payloads": [{ "text": "pong", "mediaUrl": null }],
    "meta": {
      "durationMs": 7552,
      "agentMeta": {
        "sessionId": "808dd031-...",
        "provider": "ollama",
        "model": "deepseek-v4-pro:cloud",
        "usage": { "input": 22915, "output": 3, "total": 22918 },
        "lastCallUsage": { "input": 22915, "output": 3, "cacheRead": 0, "cacheWrite": 0, "total": 22918 },
        "promptTokens": 22915
      },
      "stopReason": "stop"
    }
  }
}
```

With `--local` the outer envelope is missing and the object is just `{payloads, meta}`; both shapes are read. On failure the gateway returns `status: "error"` with an `error` string, which becomes `isError` in the report and one rendered line.

From it the meter takes: `usage.input`/`output` (and `cacheRead`/`cacheWrite` when present; the aggregate does not carry them today), the model and provider, the session id, the outcome, the reply payloads, and any `usage.cost` if a future version reports one. It has no dollars, no per-call breakdown, and it arrives after the money is spent.

Log lines that share stdout (plugin registrations, config warnings) are passed through as text. The object is recognised by balanced braces, not by line, because it is pretty-printed.

### 2. The session transcript, while the turn runs

The gateway appends every model message to `<state dir>/agents/<agent>/sessions/<sessionId>.jsonl` as it happens, each with

```json
"usage": { "input": 20609, "output": 117, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 20726,
           "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } }
```

and, for tool turns, `toolCall` blocks with the tool name and arguments. The store next to it, `sessions.json`, is written when the run starts and maps the session key to `sessionFile`, `sessionId` and `startedAt`.

The meter polls that file once a second (a small tailer: it remembers its byte offset and reads only what was appended). This is what makes `--budget` and `--max-tokens` live: the crash case `openclaw-transcript-blower` writes 100k tokens to a transcript every 100 ms and prints nothing, and the budget fires after 1.4 s. From the transcript the meter also gets cache tokens, tool calls (`exec` commands, `write`/`edit` paths) and OpenClaw's own cost figure.

The state dir is `$OPENCLAW_STATE_DIR`, else `~/.openclaw-dev` for `--dev`, `~/.openclaw-<name>` for `--profile <name>`, else `~/.openclaw`. A relocated `session.store` in `openclaw.json` is not followed.

### How the session is found

`sessions.json` can be several megabytes on a busy machine, so it is parsed at most every two seconds, only until the transcript is found, and only if its mtime is newer than the run's start. Among entries with a `sessionFile` that started after nightshift did, the meter picks:

- with `--session-id <id>`: the entry whose key ends in `:explicit:<id>` or whose `sessionId` is `<id>`;
- with `--agent <id>`: the newest entry whose key starts with `agent:<id>:`;
- with only `--to`: the newest entry started since spawn.

The last case is a guess. On a gateway that also serves chat channels, a Telegram turn that starts in the same second can be picked instead. Pass `--session-id` (any string; OpenClaw creates the session if it does not exist) for exact attribution. Once the envelope arrives it names the real session id, and the final read at `end()` uses that.

### Reconciliation

The envelope's usage is the whole turn. When the run ends, if the envelope reports more tokens than the tailer saw (the transcript was found late, or not at all), the envelope replaces the tailer's count and the estimate is recomputed from it. If the tailer saw it all, nothing changes and nothing is counted twice. `test/openclaw-meter.test.ts` covers both directions.

## Dollars

In order of preference:

1. **Reported.** The transcript's `cost.total` per message, summed, when it is above zero. OpenClaw computes it from its own model catalog. A zero with tokens behind it means the catalog had no price (every Ollama Cloud model reports zero), not that the tokens were free, so it is not treated as a report. Shown as `priceSource: "reported"` and used by the budget guard directly.
2. **List price** when the model id is a Claude id (`priceFor()` from the Claude adapter, including `NIGHTSHIFT_PRICES` overrides).
3. **Ceiling price** for anything else, so a budget is never blind to a model nightshift does not know. `deepseek-v4-pro:cloud` is counted at $10/$50 per million, which turned a 23k-token "pong" into an estimated $0.23. That is loud on purpose. If you know the real rate, set it: `NIGHTSHIFT_PRICES='{"deepseek-v4-pro:cloud":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}'` prices a flat-rate model at zero and `--max-tokens` becomes the useful limit.

## Limits, honestly

- **A kill stops the client, not the turn.** `openclaw agent` is a thin RPC client; the model calls run inside the gateway process, which nightshift does not own. When the budget fires, nightshift kills the CLI, stops waiting, and writes the report; whether the gateway aborts the run when its client disconnects was not verified and should not be relied on. With `--local` the agent runs inside the supervised process and the kill reaches it. The report notes say this whenever a budget is set without `--local`.
- **Usage on stdout arrives after the fact.** Without the transcript (state dir unreadable, session not found), the budget can only fire on the final envelope, which lands as the process is exiting. The crash case `openclaw-budget-blower` shows that firing on that chunk still works when the process is alive to be killed; a real run that has already exited is reported over budget, not killed.
- **Attribution by time is a guess** when neither `--session-id` nor `--agent` is given; see above.
- **The transcript is read on a one-second poll**, so the live count trails by up to a second plus the guard tick.
- **`events.jsonl`** holds the transcript's assistant messages and the final envelope, one object per line, not the user prompts.
- **Rate-limit windows** are not available from OpenClaw and stay empty.
- Verified on macOS (unit tests, crash suite, and one real `openclaw agent` turn through the gateway on the owner's DeepSeek model). The Linux CI run covers the unit tests and the crash cases with fake agents; nothing on Linux has talked to a real OpenClaw.
