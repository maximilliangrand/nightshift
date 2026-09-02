# The crash suite

`bun run crashtest` is the proof behind the README. It is not a unit test of the supervisor's parts; it is the supervisor, run for real, against agents written to misbehave the way real ones did.

## How a case works

Each case in `crashtest/run.ts` names an agent under `crashtest/agents/`, the limits nightshift is given, and an `expect` function over the resulting `report.json`. The harness:

1. creates a fresh `NIGHTSHIFT_HOME` and working directory in the system temp dir
2. runs `bun src/cli.ts run --quiet --tick 500ms --name <case> <limits> -- bun <agent>` (or `sh <agent>` for shell scripts) with a 45-second harness timeout, which is the guard for the guards; `NIGHTSHIFT_BIN` is exported so an agent can call the CLI under test, which `send-loop.ts` does
3. reads the single `report.json` the run wrote
4. applies `expect`
5. scans `ps` for anything still mentioning the agent path or the working directory, and fails the case if it finds any

Step 5 is the one that matters. A supervisor that reports "killed" while a `sleep 300` from the agent is still running has not done its job.

A case passes only if `expect` returns `null` and step 5 finds nothing. The suite exits 1 if any case fails, so it runs in CI on macOS and Linux.

A case may declare `notApplicable`, a function over the report that says why this machine cannot exercise it. Such a case is printed as `n/a` with the reason, whatever it left behind is cleaned up instead of counted, and it neither passes nor fails. `cgroup-escape` is n/a on macOS and on any Linux where the report note says `cgroup net: unavailable`.

## The cases

| Case | What the agent does | Caught by |
|---|---|---|
| `hang` | prints once, then nothing, forever | `--idle-timeout` |
| `runaway` | prints forever | `--max-runtime` |
| `ignore-sigterm` | traps SIGTERM and SIGINT, keeps printing | `--max-runtime`, escalates to SIGKILL |
| `fast-orphan` | detaches a child into its own session and exits within 60 ms | descendant walk on the output chunk, then the orphan sweep |
| `wrapper-shell` | a `sh` wrapper that dies on SIGTERM around a worker that ignores it | grace measured from the SIGTERM, then SIGKILL for the worker |
| `spawn-fail` | the command does not exist | outcome `failed`, exit 127 in the report, report still written |
| `silent-orphan` | detaches `/bin/sleep` (an Apple platform binary, environment invisible to `ps -E`) into a new session, prints nothing, exits at once | the stray check: new since spawn, re-parented to init, cwd is the run's |
| `grace-spawner` | spawns a detached `/bin/sleep` from inside its SIGTERM handler, during the grace period | second SIGKILL wave, stray check |
| `unpriced-model` | speaks stream-json for a model id with no list price | `--budget`, counted at the ceiling price |
| `noeol-stream` | one 900k-token event with no trailing newline, then silence | `--max-tokens`, complete objects are parsed without waiting for a newline |
| `orphan` | detaches `sleep 300` into its own session, exits 0 after 1.5 s | orphan sweep after exit |
| `fork-bomb-lite` | spawns 30 sleepers, goes silent | `--idle-timeout`, whole group dies |
| `disk-filler` | writes 2 MB every 50 ms | `--max-disk-growth --watch .` |
| `output-flood` | prints 1 MB every 5 ms | `--max-output`, checked per chunk |
| `budget-blower` | speaks stream-json, $0.50 per 100 ms, every message emitted twice | `--budget`, per-message dedupe |
| `token-blower` | same agent | `--max-tokens` |
| `send-loop` | 20 ledger claims plus one repeat against a 5/day limit | ledger: 5 allowed, 16 refused |
| `kill-file` | a well-behaved minute-long job | `nightshift stop latest` from the harness |
| `postcondition` | exits 0, never writes the required file | `--require`, exit code 3 |
| `stdin-waiter` | waits on stdin | stdin is closed by default, exits at once |
| `cgroup-escape` | detaches `/bin/sleep` with an empty environment and cwd `/`, prints nothing, exits at once: past all four nets | the cgroup net, Linux only ([docs/CGROUP.md](CGROUP.md)); reported as n/a where no cgroup can be had |

## Adding a case

1. Write the agent in `crashtest/agents/<name>.ts` (or `.sh`). Keep it under twenty lines; the point should be obvious from reading it.
2. Add an entry to `CASES` in `crashtest/run.ts` with the limits that should catch it and an `expect` that checks the outcome, the guard, and `survivors.length === 0`.
3. Run just that case while iterating: `bun run crashtest <name>`.
4. Update the count in the README badge and the block quoted there.

Cases should reproduce something that actually happened, or something you are certain will. The suite is a record of how agents fail, not a list of everything that could.

## What the suite does not cover

- A process that is detached into a new session by a silent parent that exits before the first tree walk, *and* hides or scrubs its environment (every Apple platform binary does this for free on macOS), *and* changes its working directory away from the run's. `silent-orphan` covers the first two; `cgroup-escape` does all three and is caught only where the cgroup net is active, which on macOS is never. A process that goes to that trouble is not misbehaving by accident.
- The `--idle-timeout` watchdog measures silence. An agent that prints a dot every second while doing nothing is not idle by that definition; `--max-runtime` and `--budget` are the limits for that shape.
- Disk growth outside the watched directories and off the working volume.
- Network side effects that do not go through the ledger or the hook.
- Anything that needs a real model. `budget-blower.ts` fakes the stream; the metering itself is covered by `test/claude-meter.test.ts` against events captured from a real run.
