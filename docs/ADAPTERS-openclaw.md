# The OpenClaw adapter

`--adapter auto` picks this adapter for any command whose basename is `openclaw` or `openclaw.mjs` and whose subcommand is `agent` (global options such as `--profile work` may come first). `--adapter openclaw` forces it onto anything that prints the same JSON.

```bash
nightshift run --budget 3usd --max-runtime 1h --report telegram \
  -- openclaw agent --agent ops -m "Summarize the logs and file issues"
```

Everything below was observed on OpenClaw 2026.4.10 on 2026-09-02, with the gateway running, by reading `openclaw agent --json` output, the installed `dist/` source and the files under `~/.openclaw`. Not assumed.

## What nightshift changes about the command

- Adds `--json` when it is absent, then renders the reply text and one summary line (`openclaw: completed in 18s · 22.9k tokens on deepseek-v4-pro:cloud via ollama`) back to the terminal and `output.log`, the way it does for Claude Code.
- If `--json` was already there, stdout is left alone and only listened to.
- **Adds `--session-id nightshift-<run id>` when the command has no `--session-id`.** OpenClaw creates that session and keys it `agent:<agent>:explicit:nightshift-<run id>` in its store, which is how the transcript is found. The report notes say so (`run isolated in its own OpenClaw session nightshift-…; pass --session-id yourself to continue an existing one`). A `--session-id` you pass, in either spelling, is left alone.
- Nothing else. OpenClaw has no budget or token flag, so a `--budget` cannot be passed through; nightshift is the only line of defence and the report notes say so.

### Session isolation, and how to opt out

Every run gets its own session by default. That is deliberate: an overnight run should not inherit a chat session's context or its bill, and its transcript must be attributable to it by id, not by which session happened to start in the same second. Consequences:

- `openclaw agent --to +1555… -m …` under nightshift no longer continues the recipient's session; it runs in `nightshift-<run id>`. Delivery still goes to `--to`.
- To continue an existing session on purpose, pass `--session-id <id>` yourself. OpenClaw creates it if it does not exist, so a fixed id such as `--session-id nightly-ops` reused every night is supported; see *Reused sessions* below for what is billed.
- With `--adapter openclaw` forced onto something that is not `openclaw agent` (a wrapper script, say), argv is not touched and no session id is added. The meter still reads a `--session-id` if one is on the command line; otherwise the transcript is not read at all and the report says `openclaw transcript never located under <state dir>; usage came from the final envelope only`.

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

The gateway appends every model message to `<state dir>/agents/<agent>/sessions/<sessionId>.jsonl` as it happens, each with a `timestamp` and

```json
"usage": { "input": 20609, "output": 117, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 20726,
           "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } }
```

and, for tool turns, `toolCall` blocks with the tool name and arguments. The file's first line is a `session` header carrying the time the session was created. The store next to it, `sessions.json`, is written when the run starts and maps the session key to `sessionFile`, `sessionId` and `startedAt`; on a reused session `startedAt` is refreshed to the new run, so only the file's header says how old a session really is.

The meter polls that file once a second (a small tailer: it remembers its byte offset and reads only what was appended, at most 8 MB per poll). This is what makes `--budget` and `--max-tokens` live: the crash case `openclaw-transcript-blower` writes 100k tokens to a transcript every 100 ms and prints nothing, and the budget fires after 1.3 s. From the transcript the meter also gets cache tokens, tool calls (`exec` commands, `write`/`edit` paths) and OpenClaw's own cost figure.

The state dir is resolved the way OpenClaw resolves it: `$OPENCLAW_STATE_DIR` when set (a leading `~` expands; a relative path is relative to the run's `--cwd`, which is the agent's cwd), else `.openclaw-dev` for `--dev`, `.openclaw-<name>` for `--profile <name>`, else `.openclaw`, under `$OPENCLAW_HOME` when set and the home directory otherwise. A relocated `session.store` in `openclaw.json` is not followed.

### How the session is found

`sessions.json` can be several megabytes on a busy machine, so it is parsed at most every two seconds, only until the transcript is found, and only if its mtime is newer than the run's start. The meter accepts exactly one kind of entry:

- before the envelope: the entry whose key ends in `:explicit:<id>` or whose `sessionId` is `<id>`, where `<id>` is the `--session-id` on the command line (the one nightshift added, or yours). With `--agent <a>` as well, only keys starting `agent:<a>:` count, because the same explicit id under another agent is another session.
- after the envelope: the entry whose `sessionId` is the one `agentMeta.sessionId` names. If that differs from the session being tailed, everything the tailer gathered (tokens, dollars, tool calls, commands, files) is discarded with a note, and the right transcript is read instead.

Time is never a criterion. On a gateway that also serves chat channels, a Telegram turn can start in the same second as the run, and on the store examined here 122 of 218 entries had no `startedAt` at all; picking the newest entry would have billed someone else's turn to the run and put their `exec` commands in its report.

### Reused sessions

When `--session-id` names a session that already exists, the run is billed for what it appended, not for the session's history:

- if the store entry's `startedAt` or the file's first-line `timestamp` predates the run (minus 2 s of clock slack), reading starts at the file's size at the moment it was found, and the report notes `openclaw session <id> existed before this run; only what it appended after <time> is counted`;
- independently, any message whose `timestamp` is earlier than the run's start minus 2 s is skipped.

The crash case `openclaw-reused-session` puts 10M tokens of two-month-old history in a transcript and checks that the run completes with its own 1001 tokens billed. A message the gateway appends between the run's start and the first poll is missed by the tailer but is in the envelope, which is the floor (next section).

### Reconciliation

The envelope's usage is the whole turn and a floor under the count, never a reset. When it lands, if it reports more tokens than the tailer saw (the transcript was found late, or not at all), the envelope replaces the tailer's count and the estimate is recomputed from it. If the tailer saw it all, nothing changes. After the envelope, a transcript message the tailer reads late (the gateway appends the final message milliseconds before printing the envelope, and the tailer polls once a second) still records its tool calls and lands in `events.jsonl`, but its usage is not added: it is already in the envelope. `test/openclaw-meter.test.ts` covers all three directions.

### What is never done

- The transcript is never chosen by start time, mtime or "newest".
- A transcript is never read from byte 0 when the session predates the run.
- Usage is never added twice: per-message state survives the envelope.
- The tailer never takes the supervisor down: an unreadable transcript (`EACCES`, `EISDIR`, a file that vanishes) is one note in the report (`openclaw transcript <file> could not be read (<code>)`) and the envelope becomes the count. The crash case `openclaw-transcript-unreadable` points the store at a directory and checks that the run completes with a report. A transcript that is not written yet is not a failure.
- Nothing is written to OpenClaw's state; the meter only reads.

## Dollars

In order of preference:

1. **Reported.** The transcript's `cost.total` per message, summed, when it is above zero. OpenClaw computes it from its own model catalog. A zero with tokens behind it means the catalog had no price (every Ollama Cloud model reports zero), not that the tokens were free, so it is not treated as a report. Shown as `priceSource: "reported"` and used by the budget guard directly.
2. **List price** when the model id is a Claude id (`priceFor()` from the Claude adapter, including `NIGHTSHIFT_PRICES` overrides).
3. **Ceiling price** for anything else, so a budget is never blind to a model nightshift does not know. `deepseek-v4-pro:cloud` is counted at $10/$50 per million, which turned a 23k-token "pong" into an estimated $0.23. That is loud on purpose. If you know the real rate, set it: `NIGHTSHIFT_PRICES='{"deepseek-v4-pro:cloud":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}'` prices a flat-rate model at zero and `--max-tokens` becomes the useful limit.

## Limits, honestly

- **A kill stops the client, not the turn.** `openclaw agent` is a thin RPC client; the model calls run inside the gateway process, which nightshift does not own. When the budget fires, nightshift kills the CLI, stops waiting, and writes the report; whether the gateway aborts the run when its client disconnects was not verified and should not be relied on. With `--local` the agent runs inside the supervised process and the kill reaches it. The report notes say this whenever a budget is set without `--local`.
- **Usage on stdout arrives after the fact.** Without the transcript (state dir unreadable, session not found), the budget can only fire on the final envelope, which lands as the process is exiting. The crash case `openclaw-budget-blower` shows that firing on that chunk still works when the process is alive to be killed; a real run that has already exited is reported over budget, not killed.
- **A forced adapter has no session id** unless `--session-id` is on the command line, so the transcript is not read and the count is the envelope's; the report says so.
- **The transcript is read on a one-second poll**, so the live count trails by up to a second plus the guard tick, and a message appended before the first poll of a reused session is only counted by the envelope.
- **`events.jsonl`** holds the transcript's assistant messages from this run and the final envelope, one object per line, not the user prompts and not a reused session's history.
- **Rate-limit windows** are not available from OpenClaw and stay empty.
- Verified on macOS (unit tests, crash suite, and real `openclaw agent` turns through the gateway on the owner's DeepSeek model, including one with the generated session id, whose store entry and envelope were matched). The Linux CI run covers the unit tests and the crash cases with fake agents; nothing on Linux has talked to a real OpenClaw.
