# Adapters

An adapter teaches nightshift one agent CLI: how to recognise it on the command line, how to switch on its machine-readable output without changing what it does, and how to turn that output into tokens, dollars and a record of what it touched. `--adapter auto` (the default) picks the first adapter whose `matches()` says yes; `--adapter <name>` forces one, which is how a script that merely speaks an adapter's format on stdout gets metered; `--adapter none` runs unmetered. The interface is `src/meters/adapter.ts`; the registry is `src/meters/index.ts`.

| | `claude` | `codex` |
|---|---|---|
| Matches | basename `claude`, `claude.js`, or a `cli.js` under a claude path | basename `codex` or `codex.js` |
| Metered when | `-p` / `--print` is present and `--output-format` is absent or `stream-json` | the `exec` (or `e`) subcommand is present, including `exec resume`, `exec fork` and `exec review` |
| Flag added | `--output-format stream-json --verbose` when no format was given; `--verbose` alone when stream-json was given | `--json` right after `exec` when it was absent |
| Rendered | text blocks; `  ⚙ Bash: cmd`, `  ⚙ Write: path`, and so on per tool call | `agent_message` text; `  ⚙ command: cmd`, `  ⚙ file_change: update path, add path`, `  ⚙ mcp:server/tool`, `  ⚙ web_search: query`; `  ⚠ codex:` for non-fatal error items; `  ✗ codex:` for `turn.failed` and `error` |
| Tokens | per `assistant` message id, latest value wins (one API response arrives as several events with the same id and usage) | `turn.completed.usage` is the thread's running total; the latest value replaces the previous one |
| Cache split | `cache_read_input_tokens` and `cache_creation_input_tokens` are separate from `input_tokens` | `cached_input_tokens` and `cache_write_input_tokens` are parts of `input_tokens`; the report's "in" is the uncached remainder |
| Model | `system.init.model`, then per message | never in the stream: `-m` / `--model` / `-c model=` from argv, then top-level `model` in `$CODEX_HOME/config.toml`, then `gpt-5.6-sol` (codex's built-in default at the time of writing), with a note in the report when it was not on the command line |
| Dollars | live estimate from `LIST_PRICES`, reconciled against `result.total_cost_usd` (`priceSource: reported`) | live estimate from `CODEX_PRICES` only; codex reports no dollars, so `priceSource` stays `list` or `ceiling` |
| Unknown model | counted at `CEILING_PRICE` (the most expensive row), `priceSource: ceiling`, one note | same, at `CODEX_CEILING_PRICE` (gpt-5.5-pro rates, $30 in / $180 out per million) |
| Native spend limit | `--max-budget-usd <budget>` is passed so the agent stops itself first | none: `codex exec --help` (codex-cli 0.152.1) has no budget or spend flag, so nightshift is the only line and the report says so |
| Tool calls | `tool_use` blocks by name, once per block id | `command_execution` as `command`, `file_change` as `file_change`, `mcp_tool_call` as `mcp:<server>/<tool>`, `web_search`; once per item id across `item.started` / `item.updated` / `item.completed` |
| Files written | `Write`, `Edit`, `NotebookEdit` paths | `file_change.changes[].path` with kind `add` or `update`; `delete` is not a write |
| Commands | `Bash.input.command`, redacted, first 200 | `command_execution.command`, redacted, first 200 |
| Session id | `session_id` | `thread.started.thread_id` |
| Extras | `rate_limit_event` subscription windows; `result.num_turns`, `terminal_reason`, `is_error` | `turn.failed.error.message` and `error.message` set `isError` and `terminalReason` |
| Interactive | `claude` without `-p`: unmetered, noted | `codex` without `exec` (including top-level `codex review`): unmetered, noted |
| Prices as of | see `src/meters/claude.ts` | developers.openai.com/api/docs/pricing, 2026-09-02, Standard tier, short context |

Prices for both adapters can be overridden with one `NIGHTSHIFT_PRICES` table keyed by model id, USD per million tokens: `{"gpt-5.6-sol":{"input":4,"output":20,"cacheRead":0.4,"cacheWrite":5}}`.

## Codex: built from sources and fixtures, not from a live run

The codex adapter was written without running `codex exec` against the API. Everything it knows comes from:

- `codex-rs/exec/src/exec_events.rs` in github.com/openai/codex: the `ThreadEvent` enum (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`), the `Usage` struct (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`) and the item types (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`).
- `codex-rs/exec/src/event_processor_with_jsonl_output.rs`: `turn.completed` carries `usage.total` of the thread; agent messages and reasoning arrive as `item.completed` only; other items get `item.started` first and keep their `item_N` id; warnings and deprecations are `item.completed` with an `error` item; a fatal error is an `error` event, then `turn.failed`.
- `codex-rs/codex-api/src/sse/responses.rs`: `cached_input_tokens` and `cache_write_input_tokens` come from the Responses API `input_tokens_details`, so they are parts of `input_tokens` (its test has input 100 = cached 40 + cache write 60).
- The "Sample JSON stream" in the non-interactive mode docs (developers.openai.com/codex/noninteractive), which is the first fixture in `test/codex-meter.test.ts`.
- `codex exec --help` of codex-cli 0.152.1, installed from npm, for the flags (`--json`, `-m`, `-c model=...`, `-o`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`) and the absence of any budget flag.
- `codex-rs/models-manager/models.json` for the built-in default model (first picker-visible preset by priority).

Known limits:

- A resumed thread (`codex exec resume`) reports the whole thread's totals in its first `turn.completed`, including turns from earlier processes. nightshift counts what it sees, so a resumed run is charged for its history. Pass `--max-tokens` and `--budget` with that in mind.
- The model is an inference. If `-m` is absent and the config file names no model, the estimate uses codex's default model of the day; a different remote default, a profile (`-p`), or a config outside `$CODEX_HOME` makes the estimate wrong at list prices. Pass `-m` for an exact estimate.
- Reasoning tokens are inside `output_tokens` and are priced as output; they are not shown separately.
- `todo_list` and `collab_tool_call` items are recorded in `events.jsonl` but not counted or rendered.
- Codex writes progress to stderr in human mode and only to stdout in `--json` mode; nightshift reads stdout. Anything codex prints to stderr is logged, not metered.
- This has not been checked against a live `codex exec` run. The first real run should be compared against `events.jsonl` and this document corrected where the stream differs.
