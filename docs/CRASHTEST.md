# The crash suite

`bun run crashtest` is the proof behind the README. It is not a unit test of the supervisor's parts; it is the supervisor, run for real, against agents written to misbehave the way real ones did.

## How a case works

Each case in `crashtest/run.ts` names an agent under `crashtest/agents/`, the limits nightshift is given, and an `expect` function over the resulting `report.json`. The harness:

1. creates a fresh `NIGHTSHIFT_HOME` and working directory in the system temp dir
2. runs `bun src/cli.ts run --quiet --tick 500ms <limits> -- bun <agent>` with a 45-second harness timeout, which is the guard for the guards
3. reads the single `report.json` the run wrote
4. applies `expect`
5. scans `ps` for anything still mentioning the agent path or the working directory, and fails the case if it finds any

Step 5 is the one that matters. A supervisor that reports "killed" while a `sleep 300` from the agent is still running has not done its job.

A case passes only if `expect` returns `null` and step 5 finds nothing. The suite exits 1 if any case fails, so it runs in CI on macOS and Linux.

## The agents

| Agent | What it does | Caught by |
|---|---|---|
| `hang.ts` | prints once, then nothing, forever | `--idle-timeout` |
| `runaway.ts` | prints forever | `--max-runtime` |
| `ignore-sigterm.ts` | traps SIGTERM and SIGINT, keeps printing | `--max-runtime`, escalates to SIGKILL |
| `orphan.ts` | detaches `sleep 300` into its own session, exits 0 | orphan sweep after exit |
| `fork-bomb-lite.ts` | spawns 30 sleepers, goes silent | `--idle-timeout`, whole group dies |
| `disk-filler.ts` | writes 2 MB every 50 ms | `--max-disk-growth --watch .` |
| `output-flood.ts` | prints 1 MB every 5 ms | `--max-output`, checked per chunk |
| `budget-blower.ts` | speaks stream-json, $0.50 per 100 ms, every message emitted twice | `--budget`, per-message dedupe |
| same, with `--max-tokens` | | `--max-tokens` |
| `send-loop.ts` | 20 ledger claims plus one repeat against a 5/day limit | ledger: 5 allowed, 16 refused |
| `kill-file.ts` | a well-behaved minute-long job | `nightshift stop latest` from the harness |
| `postcondition.ts` | exits 0, never writes the required file | `--require`, exit code 3 |
| `stdin-waiter.ts` | waits on stdin | stdin is closed by default, exits at once |

## Adding a case

1. Write the agent in `crashtest/agents/<name>.ts`. Keep it under twenty lines; the point should be obvious from reading it.
2. Add an entry to `CASES` in `crashtest/run.ts` with the limits that should catch it and an `expect` that checks the outcome, the guard, and `survivors.length === 0`.
3. Run just that case while iterating: `bun run crashtest <name>`.
4. Update the count in the README badge and the block quoted there.

Cases should reproduce something that actually happened, or something you are certain will. The suite is a record of how agents fail, not a list of everything that could.

## What the suite does not cover

- An agent that scrubs its own environment, detaches into a new session, and whose parent exits within one tick. All three nets miss it. See the README.
- Disk growth outside the watched directories and off the working volume.
- Network side effects that do not go through the ledger or the hook.
- Anything that needs a real model. `budget-blower.ts` fakes the stream; the metering itself is covered by `test/claude-meter.test.ts` against events captured from a real run.
