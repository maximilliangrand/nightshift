# nightshift

**Supervisor for unattended AI agent runs.** Hard limits on time, tokens, dollars, disk and side effects. A kill that actually kills. A report of what happened while you slept.

```bash
nightshift run --budget 5usd --max-runtime 2h --idle-timeout 15m --report telegram \
  -- claude -p "fix the failing tests and open a PR"
```

Zero dependencies. One command. Works with Claude Code, Codex, OpenClaw, Hermes, a shell script, anything you can start from a terminal.

[![ci](https://github.com/maximilliangrand/nightshift/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilliangrand/nightshift/actions/workflows/ci.yml)
[![crash suite](https://img.shields.io/badge/crash_suite-24%2F24_failure_modes_caught-2ea44f)](docs/CASES.md) <!-- cases:badge -->
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
    -- claude -p "Create a file hello.py that prints hello, then run it with python3" --model haiku

nightshift 20260902-195455-auvk5t-e2e · pid 11024 · runtime ≤ 3m · no output for ≤ 1m · spend ≤ $0.25 · stop with: nightshift stop 20260902-195455-auvk5t-e2e
  ⚙ Write: /private/tmp/ns-e2e-ZjqB/hello.py
  ⚙ Bash: python3 /private/tmp/ns-e2e-ZjqB/hello.py
Done. Created `hello.py` and ran it, it printed "hello" as expected.

✅ nightshift e2e
Completed in 11s, exit 0.
$0.0339 · 53.6k tokens · 11s
1 files written
```

And the report it leaves behind, the one you read on your phone (abridged):

```markdown
# ✅ nightshift run e2e (20260902-195455-auvk5t-e2e)

**Completed in 11s, exit 0.**

- Limits: runtime ≤ 3m; no output for ≤ 1m; spend ≤ $0.25

## Spend
- **$0.0339** reported by Claude Code (live estimate $0.0321) on claude-haiku-4-5-20251001
- Tokens: 53.6k (18 in, 5 out, 39.5k cache read, 14.1k cache write)
- 2 model messages, 3 turns
- Subscription windows after this run: 5h 82%, 7d 27% used

## What it did
- Tool calls: Write ×1, Bash ×1
- Files written (1):
  - `/private/tmp/ns-e2e-ZjqB/hello.py`
- Commands run (1):
  - `python3 /private/tmp/ns-e2e-ZjqB/hello.py`

## Footprint
- Git (main): 0 new commits, 1 untracked file, dirty 0 → 1
- Disk: volume -1.2MB free space change
- Output: 26KB → `~/.nightshift/runs/20260902-195455-auvk5t-e2e/output.log`
```

Every run writes `report.md`, `report.json`, the full `output.log` and, for Claude Code, the raw `events.jsonl`, under `~/.nightshift/runs/<id>/`. That includes the runs that were killed, the ones whose command did not exist, and the ones where you hit Ctrl-C. A run you cannot read about in the morning did not happen.

## Limits

Each of these is a kill, not a warning. The agent gets SIGTERM, a grace period, then SIGKILL, and the report says which limit fired and why.

| Flag | Stops the run when | Notes |
|---|---|---|
| `--max-runtime 2h` | it has run this long | wall clock |
| `--idle-timeout 15m` | it prints nothing for this long | the hung-subprocess watchdog; it measures silence, so pair it with `--max-runtime` and `--budget` for an agent that prints dots while doing nothing |
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

Most supervisors send one signal to one pid and hope. Agents spawn shells, which spawn tools, which spawn servers. nightshift casts five nets, four of them everywhere and one on Linux:

1. **The process group.** The agent runs as leader of its own group, so one signal reaches the whole tree.
2. **The descendant map.** A `ps` tree walk at spawn, on every chunk of output and on every tick. Every pid is remembered with its start time, so a pid recycled by an unrelated process is dropped rather than signalled, and a grandchild that re-parented to `init` stays on the list.
3. **The environment marker.** Every process nightshift starts inherits `NIGHTSHIFT_RUN_ID`. Anything still carrying it is ours, regardless of what it did to its group or parent (`ps -E` on macOS, `/proc/*/environ` on Linux).
4. **The stray check.** A snapshot of the process table is taken before spawn. Anything that was not there then, started after the run began, has been re-parented to `init`, and still has the run's working directory as its cwd (`lsof` on macOS, `/proc/*/cwd` on Linux) is ours too. This is the net that catches a silent parent detaching `/bin/sleep` into a new session and exiting within a millisecond, which the red team did on its first try.
5. **The cgroup (Linux).** Every one of the first four nets identifies a process by something it can change about itself: its group, its parent, its environment, its working directory. Cgroup membership is inherited on fork and cannot be given up without write access to `/sys/fs/cgroup`, so on Linux nightshift starts the agent inside a cgroup of its own and `cgroup.procs` lists every descendant no matter what it did. It takes a sub-cgroup under its own when it may create one (a systemd user session, a user service, root anywhere), or a transient `systemd-run --user --scope` otherwise; the agent is moved in by a one-line `sh` wrapper that then `exec`s it, so the pid and exit code are the agent's. Kill waves write to `cgroup.kill` on kernels that have it. Where no cgroup can be had (cron as a normal user, a container with a read-only cgroup mount, macOS) the run proceeds with four nets and the report says `cgroup net: unavailable (<reason>)` in the kernel's own words; otherwise it says `cgroup net: active (<dir>)`. Details in [docs/CGROUP.md](docs/CGROUP.md).

The grace period is measured from the SIGTERM, not from when the direct child happened to exit: a `sh` wrapper dying instantly does not shorten the grace for the worker underneath it. After the agent exits on its own, the same nets sweep for orphans; anything found is killed and listed in the report. Anything that survives all of that is listed by pid under **Survivors**, in bold, because a kill that quietly did not kill is the worst outcome there is.

The honest gap, found by trying to break it: on macOS, Apple platform binaries (`/bin/sh`, `/bin/sleep`, `/usr/bin/tail`) never show their environment to `ps -E`, so net 3 does not see them. A process escapes on macOS only if it is detached into a new session by a parent that prints nothing and exits before the first tree walk, *and* it scrubs or cannot show its environment, *and* it changes its working directory away from the run's. Every one of those steps has to be deliberate. The `cgroup-escape` case in the suite does exactly that: on Linux with the cgroup net active it is caught, and everywhere else the suite reports it as n/a rather than pretending. Ctrl-C once stops gracefully, twice sends SIGKILL now, three times leaves without a report.

## The ledger: side effects that happen once

Two of the incidents above were the same bug: an agent sent something it had already sent. The fix is not a smarter prompt. It is a ledger the agent must write to before any side effect, with a rate limit on the scope.

```bash
# in any script or agent tool: claim before you send
nightshift ledger claim --scope telegram --key "listing-8812" --limit 40/day && send_listing 8812
```

`claim` exits 0 once per key per scope, ever (keys are trimmed and whitespace-collapsed, so `"listing-8812 "` from a sloppy `$(...)` is the same key). The same key again is a **duplicate** (exit 3). The 41st claim in a sliding day is **capped** (exit 4). Refusals are recorded too, so the morning report can say "the ledger refused 16 sends". Several agents on one machine share the same ledger through a lock file; there is no database. A line damaged by a crash mid-write or a full disk is skipped and counted, never allowed to erase the history before it.

### The Claude Code hook

For Claude Code you do not need to change the agent at all. Install the hook and describe the commands that are side effects:

```bash
nightshift hook install
nightshift hook add --scope telegram --limit 40/day \
  --match 'api\.telegram\.org\.?/bot[^/]+/(send|forward|copy)' --note 'Telegram sends:'
nightshift hook add --scope github-prs --match '^gh pr create'
```

Every matching `Bash` call is now claimed in the ledger before it runs. A duplicate or a capped scope is denied with a reason Claude reads directly:

> nightshift ledger: Telegram sends: scope "telegram" is at its limit of 40/day (40 used). Stop sending; do not work around this limit.

For a command no rule matches, the hook fails open: if nightshift itself is broken, the call falls through to Claude Code's normal permission flow. For a command a rule *did* match, it fails closed: if the ledger cannot record the claim (directory made unwritable, disk full), the send is denied, because a side effect that cannot be recorded cannot be deduplicated. The refusals are deterministic and come from the ledger, never from a model. Write your patterns for the family of calls, not one endpoint: the red team delivered through `sendPhoto` and `api.telegram.org.` (trailing dot) past a rule that only knew `sendMessage`. `hook install` edits `~/.claude/settings.json` in place, keeps a `.bak`, and refuses to touch a file it cannot parse. The ledger stores the hash of the command, not the command, because the command is where the token lives.

## Metering

nightshift knows how to read three agents' machine output: Claude Code, Codex CLI and OpenClaw. `--adapter auto` picks one by the command name. Each adapter switches the agent's structured output on for you, renders it back into readable text, and keeps a live count of tokens and dollars.

**Claude Code.** When you run `claude -p …` under nightshift, it adds `--output-format stream-json` and reads it.

Two things we learned by looking rather than assuming:

- Claude Code emits one `assistant` event per content block, all carrying the same message id and the same usage. Summing naively double-counts by up to 2×. The meter keys usage by message id.
- Dollars are only reported at the end (`total_cost_usd`). A budget that fires after the money is spent is not a budget, so spend is estimated live from tokens at list prices and reconciled against the reported figure when the run ends. The report shows both. The live estimate does not see thinking tokens until the result arrives, so it runs a few percent low; the reported figure is the bill. A model with no list price is counted at the most expensive rate, so a budget is never blind to an unknown model id. An event that arrives without its trailing newline is counted as soon as it is a complete object.

A dollar budget is also passed to Claude Code as `--max-budget-usd`, so the agent stops itself first and nightshift is the second line, not the only one.

**Codex CLI.** Run `codex exec "…"` under nightshift and it adds `--json`, renders agent messages, commands, file changes and tool calls back into readable text, and meters the run. Three things we learned from the Codex sources rather than from the docs alone: the usage on `turn.completed` is the thread's running total, so the meter replaces rather than sums; cached and cache-write tokens are part of `input_tokens`, so "in" in the report is the uncached remainder; and the stream never names the model, so nightshift takes it from `-m`, then from `~/.codex/config.toml`, then assumes Codex's current default and says so in the report. Pass `-m` for an exact estimate. Codex has no spend flag of its own, so with `--budget` nightshift is the only line. The adapter was built from the Codex sources and documented fixtures, not from a live run; the first real run under it should be checked against `events.jsonl`. See [docs/ADAPTERS.md](docs/ADAPTERS.md).

**OpenClaw.** Run `openclaw agent …` under nightshift and it adds `--json` and meters the turn from two places: the JSON envelope OpenClaw prints when the turn is over, and the session transcript the gateway writes while it runs, which is where per-message usage, cache tokens, tool calls and OpenClaw's own cost figure live. The transcript is tailed once a second, so `--budget` fires while the money is being spent, not after. Dollars come from OpenClaw's reported cost when it has one, from list prices for a Claude model id, and from the ceiling rate for anything else. Two things to know: OpenClaw has no budget flag, so nightshift is the only line; and `openclaw agent` is a thin client whose model calls run inside the gateway, so a kill stops the wait and writes the report but does not stop a gateway-side turn. Pass `--local` for a run the kill reaches, and `--session-id` for exact attribution. See [docs/ADAPTERS-openclaw.md](docs/ADAPTERS-openclaw.md).

Prices are list prices as of 2026-09-02, cached input included. Override any of them with `NIGHTSHIFT_PRICES='{"claude-opus-5":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":10}}'` (USD per million tokens); an unknown model id is counted at the most expensive rate, so a budget is never blind.

| Command | Supervised | Metered |
|---|---|---|
| `claude -p …` | yes | yes: tokens, dollars, tool calls, files, commands, rate-limit windows |
| `codex exec …` | yes | yes: tokens, dollars, commands, file changes, tool calls |
| `openclaw agent …` | yes | yes: tokens, dollars (OpenClaw's own figure when it has one), tool calls, from the envelope and the session transcript |
| `claude` / `codex` interactive | yes | no |
| Hermes, Aider, your script | yes | no; `--budget` and `--max-tokens` refuse to start unless you pass `--allow-unmetered` |
| Anything that speaks one of those formats on stdout | yes | yes, with `--adapter claude`, `codex` or `openclaw` |

nightshift refuses to start a run with a `--budget` it cannot measure. A limit that silently does nothing is worse than none.

## Delivery

```bash
export NIGHTSHIFT_TELEGRAM_TOKEN=123:abc NIGHTSHIFT_TELEGRAM_CHAT=4567
export NIGHTSHIFT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/…
export NIGHTSHIFT_WEBHOOK=https://your.server/nightshift     # receives report.json by POST

nightshift run --report telegram,discord -- ./job.sh
```

Delivery happens before the report files are written, so a failed notification lands in the report's notes; it never turns a completed run into a failed one. The supervisor keeps these variables to itself: the agent's environment does not contain them, and anything the agent prints that looks like a token (Telegram bot tokens, bearer headers, `sk-` and `sk_live_` keys, Slack and Discord webhook URLs, `TOKEN=`/`password=` assignments, PEM private keys, JWTs) is redacted before it is stored or sent.

## Scheduling

```bash
nightshift schedule --at 03:00 --label research --install \
  -- nightshift run --budget 10usd --max-runtime 3h --report telegram -- claude -p "…"
```

On macOS this writes a `launchd` plist and prints the `launchctl bootstrap` line; on Linux it prints a crontab line. Commands are resolved to absolute paths and the current `PATH` is carried along, because launchd and cron have neither. Or wrap nightshift in whatever scheduler you already use; it is just a process.

## Everyday commands

```
nightshift runs                 every run, status, duration, spend
nightshift report [id|latest]   the morning report; --json for machines
nightshift stop [id|latest]     graceful stop via the run's kill file; --all, --force
nightshift ledger show [scope]  what has been claimed and refused
```

Exit codes: `0` completed · `1` failed · `2` killed by a limit · `3` postcondition failed · `64` usage error. `ledger claim`: `0` claimed · `3` duplicate · `4` capped.

## The crash suite

Claims about supervisors are cheap. `bun run crashtest` runs <!-- cases:count -->24<!-- /cases:count --> deliberately broken cases under nightshift, each with the limit that should catch it, and passes only if the report says the right thing **and no process from the case is left alive**.

```
nightshift crash suite · 24 failure modes

  hang             goes silent forever                  ✅ idle-timeout: silent for 2s, limit 2s (2.4s)
  runaway          never finishes                       ✅ max-runtime: ran for 2s, limit 2s (2.4s)
  ignore-sigterm   traps SIGTERM                        ✅ max-runtime: ran for 2s, limit 2s → SIGKILL (3.7s)
  fast-orphan      detaches a child, exits in 60ms      ✅ exit 0; killed 1 orphan (0.3s)
  wrapper-shell    sh wrapper dies, worker ignores TERM ✅ max-runtime: ran for 2s, limit 2s → SIGKILL (3.7s)
  spawn-fail       command does not exist               ✅ failed in 21ms (0.1s)
  silent-orphan    detaches /bin/sleep, exits silently  ✅ exit 0; killed 1 orphan (0.2s)
  grace-spawner    spawns /bin/sleep from its SIGTERM handler ✅ max-runtime: ran for 2s, limit 2s → SIGKILL (4.8s)
  unpriced-model   spends on a model with no price      ✅ budget: $2.00 spent (estimated), limit $2.00 (0.5s)
  noeol-stream     one huge event, no newline           ✅ max-tokens: 900k tokens used, limit 300k (0.4s)
  orphan           detaches a child, exits 0            ✅ exit 0; killed 1 orphan (1.7s)
  fork-bomb-lite   30 children, then silence            ✅ idle-timeout: silent for 2s, limit 2s (2.4s)
  disk-filler      fills the disk                       ✅ max-disk-growth: grew 98MB, limit 30MB (2.9s)
  output-flood     floods stdout                        ✅ max-output: 8.2MB of output, limit 8.0MB (0.4s)
  budget-blower    spends without limit                 ✅ budget: $2.00 spent (estimated), limit $2.00 (0.7s)
  token-blower     burns tokens                         ✅ max-tokens: 300k tokens used, limit 300k (0.7s)
  send-loop        sends 21 messages                    ✅ ledger allowed 5, refused 16 (0.6s)
  kill-file        must be stopped by hand              ✅ kill-file: kill file present (2.9s)
  postcondition    claims success, produced nothing     ✅ exit 0 but path out.json missing → exit 3 (0.1s)
  stdin-waiter     waits for a keyboard                 ✅ completed in 37ms (0.1s)
  cgroup-escape    setsid, env {}, cwd /, silent exit   ➖ n/a: not linux, no cgroup net; the escape works here, which is the documented gap (0.2s)
  codex-budget-blower speaks codex JSONL, spends without limit ✅ budget: $2.00 spent (estimated), limit $2.00 (0.8s)
  openclaw-budget-blower reports $50 of usage at the end      ✅ budget: $50.00 spent (estimated), limit $2.00 (0.3s)
  openclaw-transcript-blower spends in the gateway, prints nothing ✅ budget: $9.00 spent (estimated), limit $2.00 (1.4s)

23/23 failure modes caught, 1 n/a on this machine
```

It runs in CI on macOS and Linux; a case that a machine cannot exercise (the cgroup net on macOS) is reported as n/a, never as a pass. Every case is on the scoreboard in [docs/CASES.md](docs/CASES.md): what the agent does, what catches it, which commit added it and where it came from, an incident on one of our machines, a review, the red team, or an issue somebody opened. The badge above is that table's count, and CI refuses to go green when the two drift: `bun scripts/cases.ts --check` is the gate, `--write` fixes it, `bun run cases` prints the table without running anything. If an agent got past nightshift on your machine, open an issue with the "My agent escaped" form. An accepted escape becomes a case in the suite before it is fixed; the rules are in [CONTRIBUTING.md](CONTRIBUTING.md), and how to write one is in [docs/CRASHTEST.md](docs/CRASHTEST.md).

## What it is not

- **Not a sandbox.** nightshift bounds how *much* and how *long*, not *what*. Use Claude Code's permission modes and sandbox, or a container, to bound what an agent may touch.
- **Not a scheduler.** It runs one job and reports. `launchd`, `cron`, CI or Claude Code Routines decide when.
- **Not an approval flow.** A ledger refusal is a rule, not a human. For "ask me before force-pushing" use a PreToolUse hook that reaches a person.

## Design notes

- No daemon, no database, no dependencies. State is files under `~/.nightshift` that you can `cat`.
- Every exit path writes a report, including the ones where the agent was killed or the supervisor received SIGINT.
- Everything that can fail open does (notifications, the hook). Everything that must fail closed does (an unmeasurable budget refuses to start).
- The samples in this README are from real runs on 2026-09-02, abridged where marked. Re-run them: `bun test && bun run crashtest`.
- Before the first release the code was reviewed by four independent reviewers and every finding was adversarially re-verified by two more; 31 confirmed defects were fixed. Three red-team agents then attacked the result: two escaped the kill through a silent detach that the first three nets could not see, one found the budget blind to unknown model ids, the meter blind to an event without a newline, and the hook failing open on an unwritable ledger. Each of those is now a case in the crash suite, and the fourth net exists because of them.

## Development

```bash
git clone https://github.com/maximilliangrand/nightshift && cd nightshift
bun install
bun test              # unit tests
bun run crashtest     # every case; `bun run cases` lists them without running
bun run build         # dist/ for node
```

MIT. Built in Vienna by [MYG Media](https://myg-media.com).
