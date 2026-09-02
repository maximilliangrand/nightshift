# nightshift

**Supervisor for unattended AI agent runs.** Hard limits on time, tokens, dollars, disk and side effects. A kill that actually kills. A report of what happened while you slept.

```bash
nightshift run --budget 5usd --max-runtime 2h --idle-timeout 15m --report telegram \
  -- claude -p "fix the failing tests and open a PR"
```

Zero dependencies. One binary. Works with Claude Code, Codex, OpenClaw, Hermes, a shell script, anything you can start from a terminal.

[![ci](https://github.com/maximilliangrand/nightshift/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilliangrand/nightshift/actions/workflows/ci.yml)
[![crash suite](https://img.shields.io/badge/crash_suite-13%2F13_failure_modes_caught-2ea44f)](docs/CRASHTEST.md)
[![npm](https://img.shields.io/npm/v/nightshift)](https://www.npmjs.com/package/nightshift)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why

Agents do not fail loudly. They fail at three in the morning, quietly, and you find out at breakfast. Every one of these happened to us on real machines running real jobs:

- A media pipeline filled **86 GB** of disk overnight. Nothing crashed. The disk was just full.
- A broadcast bot got a phone number **banned** by sending about 1,100 messages in a day. It was doing exactly what it was told.
- A listings bot **re-sent** items it had already sent, because the file it read from changed under it.
- A subprocess **hung** and the exit trap around it never fired, so the "finished" notification never came either.
- Log files quietly grew to **400 MB** because nothing was watching them.

None of these are model problems. They are supervision problems, and the supervisor did not exist. `launchd` and `systemd` will restart a process; they will not notice that it has spent $40, written 2 GB, or sent the same Telegram message thirty times. So we built the thing that does.

## Install

```bash
npm install -g nightshift      # Node 20+, macOS or Linux
```

or run it without installing:

```bash
npx nightshift run --max-runtime 30m -- ./overnight.sh
```

## What a run looks like

```
$ nightshift run --name e2e --budget 0.25 --max-runtime 3m --idle-timeout 60s \
    -- claude -p "Create hello.py that prints hello, then run it" --model haiku

nightshift 20260902-191218-gn64lj-e2e · pid 22352 · runtime ≤ 3m · no output for ≤ 1m · spend ≤ $0.25
  ⚙ Write: /private/tmp/ns-e2e-KjNJ/hello.py
  ⚙ Bash: python3 /private/tmp/ns-e2e-KjNJ/hello.py
Done. Created hello.py and ran it. Printed "hello" as expected.

✅ nightshift e2e
Completed in 9s, exit 0.
$0.0377 · 57.6k tokens · 9s
1 files written
```

And the report it leaves behind, the one you read on your phone:

```markdown
# ✅ nightshift run e2e (20260902-191218-gn64lj-e2e)

**Completed in 9s, exit 0.**

## Spend
- **$0.0377** reported by Claude Code (live estimate $0.0361) on claude-haiku-4-5-20251001
- Tokens: 57.6k total: 18 in, 4 out, 41.6k cache read, 16k cache write
- Subscription windows after this run: 5h 24%, 7d 16% used

## What it did
- Tool calls: Write ×1, Bash ×1
- Files written (1): `/private/tmp/ns-e2e-KjNJ/hello.py`
- Commands run (1): `python3 /private/tmp/ns-e2e-KjNJ/hello.py`

## Footprint
- Git (main): 0 new commits, 1 untracked file, dirty 0 → 1
- Disk: volume -1.4MB free space change
- Output: 26KB → ~/.nightshift/runs/20260902-191218-gn64lj-e2e/output.log
```

Every run writes `report.md`, `report.json`, the full `output.log` and, for Claude Code, the raw `events.jsonl`, under `~/.nightshift/runs/<id>/`. A run you cannot read about in the morning did not happen.

## Limits

Each of these is a kill, not a warning. The agent gets SIGTERM, a grace period, then SIGKILL, and the report says which limit fired and why.

| Flag | Stops the run when | Notes |
|---|---|---|
| `--max-runtime 2h` | it has run this long | wall clock |
| `--idle-timeout 15m` | it prints nothing for this long | the hung-subprocess watchdog |
| `--budget 5usd` | estimated spend reaches this | metered commands only, see below |
| `--max-tokens 2M` | total tokens reach this | metered commands only |
| `--max-disk-growth 2gb` | the volume loses this much free space, or a `--watch <dir>` grows this much | `df` is a smoke alarm, `du` on a watched dir is exact |
| `--max-output 50mb` | it has printed this much | logs are disk too; the log stops growing at the cap |
| `--kill-file <path>` | the file appears | `nightshift stop` and a global `~/.nightshift/stop` always work, no flag needed |

Output, token and dollar limits are checked on every chunk the agent writes, not just on the polling tick. A flood is stopped within one write.

## Postconditions

Postconditions do not kill; they turn a run that *said* it succeeded into one that did not.

```bash
nightshift run --require ./out/report.json --max-runtime 1h -- ./research.sh
```

An agent that exits 0 without producing `out/report.json` gets outcome `postcondition-failed` and exit code 3. Nothing downstream should trust "exit 0" from an agent; make it prove it.

## A kill that kills

Most supervisors send one signal to one pid and hope. Agents spawn shells, which spawn tools, which spawn servers. nightshift casts three nets:

1. **The process group.** The agent runs as leader of its own group, so one signal reaches the whole tree.
2. **The descendant map.** A `ps` tree walk every tick, unioned rather than replaced, so a grandchild that re-parented to `init` is still on the list.
3. **The environment marker.** Every process nightshift starts inherits `NIGHTSHIFT_RUN_ID`. Anything still carrying it is ours, regardless of what it did to its group or parent (`ps -E` on macOS, `/proc/*/environ` on Linux).

After the agent exits on its own, the same nets sweep for orphans; anything found is killed and listed in the report. Anything that survives all of that is listed by pid under **Survivors**, in bold, because a kill that quietly did not kill is the worst outcome there is.

The honest gap: a process that scrubs its own environment *and* detaches into a new session *and* whose parent exits within one tick can escape. We have not seen an agent do that by accident.

## The ledger: side effects that happen once

Two of the incidents above were the same bug: an agent sent something it had already sent. The fix is not a smarter prompt. It is a ledger the agent must write to before any side effect, with a rate limit on the scope.

```bash
# in any script or agent tool: claim before you send
nightshift ledger claim --scope telegram --key "listing-8812" --limit 40/day && send_listing 8812
```

`claim` exits 0 once per key per scope, ever. The same key again is a **duplicate** (exit 3). The 41st claim in a sliding day is **capped** (exit 4). Refusals are recorded too, so the morning report can say "the ledger refused 16 sends". Several agents on one machine share the same ledger through a lock file; there is no database.

### The Claude Code hook

For Claude Code you do not need to change the agent at all. Install the hook and describe the commands that are side effects:

```bash
nightshift hook install
nightshift hook add --scope telegram --limit 40/day \
  --match 'api\.telegram\.org/bot[^/]+/sendMessage' --note 'Telegram sends:'
nightshift hook add --scope github-prs --match '^gh pr create'
```

Every matching `Bash` call is now claimed in the ledger before it runs. A duplicate or a capped scope is denied with a reason Claude reads directly:

> nightshift ledger: Telegram sends: scope "telegram" is at its limit of 40/day (40 used). Stop sending; do not work around this limit.

The hook fails open: if nightshift itself is broken, the call falls through to Claude Code's normal permission flow. The refusals are deterministic and come from the ledger, never from a model.

## Metering

nightshift knows how to read Claude Code's `--output-format stream-json`. When you run `claude -p …` under it, it turns that on for you, renders the stream back into readable text, and keeps a live count of tokens and dollars.

Two things we learned by looking rather than assuming:

- Claude Code emits one `assistant` event per content block, all carrying the same message id and the same usage. Summing naively double-counts by up to 2×. The meter keys usage by message id.
- Dollars are only reported at the end (`total_cost_usd`). A budget that fires after the money is spent is not a budget, so spend is estimated live from tokens at list prices and reconciled against the reported figure when the run ends. The report shows both. The live estimate does not see thinking tokens until the result arrives, so it runs a few percent low; the reported figure is the bill.

A dollar budget is also passed to Claude Code as `--max-budget-usd`, so the agent stops itself first and nightshift is the second line, not the only one. Override prices with `NIGHTSHIFT_PRICES='{"claude-opus-5":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":10}}'` (USD per million tokens).

| Command | Supervised | Metered |
|---|---|---|
| `claude -p …` | yes | yes: tokens, dollars, tool calls, files, commands, rate-limit windows |
| `claude` (interactive) | yes | no |
| Codex, OpenClaw, Hermes, Aider, your script | yes | no; `--budget` and `--max-tokens` refuse to start unless you pass `--allow-unmetered` |
| Anything that speaks stream-json on stdout | yes | yes, with `--adapter claude` |

nightshift refuses to start a run with a `--budget` it cannot measure. A limit that silently does nothing is worse than none.

## Delivery

```bash
export NIGHTSHIFT_TELEGRAM_TOKEN=123:abc NIGHTSHIFT_TELEGRAM_CHAT=4567
export NIGHTSHIFT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/…
export NIGHTSHIFT_WEBHOOK=https://your.server/nightshift     # receives report.json by POST

nightshift run --report telegram,discord -- ./job.sh
```

A notification that fails is written into the report's notes. It never turns a completed run into a failed one.

## Scheduling

```bash
nightshift schedule --at 03:00 --label research --install \
  -- nightshift run --budget 10usd --max-runtime 3h --report telegram -- claude -p "…"
```

On macOS this writes a `launchd` plist and prints the `launchctl bootstrap` line; on Linux it prints a crontab line. Or wrap nightshift in whatever scheduler you already use; it is just a process.

## Everyday commands

```
nightshift runs                 every run, status, duration, spend
nightshift report [id|latest]   the morning report; --json for machines
nightshift stop [id|latest]     graceful stop via the run's kill file; --all, --force
nightshift ledger show [scope]  what has been claimed and refused
```

Exit codes: `0` completed · `1` failed · `2` killed by a limit · `3` postcondition failed · `64` usage.

## The crash suite

Claims about supervisors are cheap. `bun run crashtest` runs thirteen deliberately broken agents under nightshift, each with the limit that should catch it, and passes only if the report says the right thing **and no process from the case is left alive**.

```
nightshift crash suite · 13 failure modes

  hang             goes silent forever                  ✅ idle-timeout: silent for 2s, limit 2s
  runaway          never finishes                       ✅ max-runtime: ran for 2s, limit 2s
  ignore-sigterm   traps SIGTERM                        ✅ max-runtime → SIGKILL
  orphan           detaches a child, exits 0            ✅ exit 0; killed 1 orphan
  fork-bomb-lite   30 children, then silence            ✅ idle-timeout: silent for 2s, limit 2s
  disk-filler      fills the disk                       ✅ max-disk-growth: grew 98MB, limit 30MB
  output-flood     floods stdout                        ✅ max-output: 8.2MB of output, limit 8.0MB
  budget-blower    spends without limit                 ✅ budget: $2.00 spent, limit $2.00
  token-blower     burns tokens                         ✅ max-tokens: 300k tokens used, limit 300k
  send-loop        sends 21 messages                    ✅ ledger allowed 5, refused 16
  kill-file        must be stopped by hand              ✅ kill-file: kill file present
  postcondition    claims success, produced nothing     ✅ exit 0 but path out.json missing → exit 3
  stdin-waiter     waits for a keyboard                 ✅ completed in 15ms

13/13 failure modes caught
```

It runs in CI on macOS and Linux. Add a case when you meet a new way for an agent to go wrong; see [docs/CRASHTEST.md](docs/CRASHTEST.md).

## What it is not

- **Not a sandbox.** nightshift bounds how *much* and how *long*, not *what*. Use Claude Code's permission modes and sandbox, or a container, to bound what an agent may touch.
- **Not a scheduler.** It runs one job and reports. `launchd`, `cron`, CI or Claude Code Routines decide when.
- **Not an approval flow.** A ledger refusal is a rule, not a human. For "ask me before force-pushing" use a PreToolUse hook that reaches a person.

## Design notes

- No daemon, no database, no dependencies. State is files under `~/.nightshift` that you can `cat`.
- Every exit path writes a report, including the ones where the agent was killed or the supervisor received SIGINT.
- Everything that can fail open does (notifications, the hook). Everything that must fail closed does (an unmeasurable budget refuses to start).
- The numbers in this README are from real runs on 2026-09-02. Re-run them: `bun test && bun run crashtest`.

## Development

```bash
git clone https://github.com/maximilliangrand/nightshift && cd nightshift
bun install
bun test              # unit tests
bun run crashtest     # the thirteen misbehaving agents
bun run build         # dist/ for node
```

MIT. Built in Vienna by [MYG Media](https://myg-media.com).
