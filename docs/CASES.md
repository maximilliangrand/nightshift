# The scoreboard

Every issue becomes a case. When an agent gets past nightshift, the first thing that lands in the repository is not the fix; it is an agent under `crashtest/agents/` that does what the escaped one did, and an entry in `crashtest/run.ts` that fails. Then the fix, and the entry goes green. The suite is the record of how agents fail, and this page is the suite read out loud.

The badge in the README is this table's count. `bun scripts/cases.ts --check` fails CI when the two drift.

## Cases

<!-- cases:table -->
| Case | What the agent does | Caught by | Added in | Origin |
| --- | --- | --- | --- | --- |
| `hang` | goes silent forever | `--idle-timeout` | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | incident |
| `runaway` | never finishes | `--max-runtime` | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `ignore-sigterm` | traps SIGTERM | `--max-runtime`, escalates to SIGKILL | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `fast-orphan` | detaches a child, exits in 60ms | descendant walk on the output chunk, then the orphan sweep | v0.1.0, [fe224f0](https://github.com/maximilliangrand/nightshift/commit/fe224f0) | review |
| `wrapper-shell` | sh wrapper dies, worker ignores TERM | grace measured from the SIGTERM, then SIGKILL for the worker | v0.1.0, [fe224f0](https://github.com/maximilliangrand/nightshift/commit/fe224f0) | review |
| `spawn-fail` | command does not exist | outcome `failed`, exit 127 in the report, report still written | v0.1.0, [fe224f0](https://github.com/maximilliangrand/nightshift/commit/fe224f0) | review |
| `silent-orphan` | detaches /bin/sleep, exits silently | the stray check: new since spawn, re-parented to init, cwd is the run's | v0.1.0, [5e2338e](https://github.com/maximilliangrand/nightshift/commit/5e2338e) | red team |
| `grace-spawner` | spawns /bin/sleep from its SIGTERM handler | second SIGKILL wave, then the stray check | v0.1.0, [5e2338e](https://github.com/maximilliangrand/nightshift/commit/5e2338e) | red team |
| `unpriced-model` | spends on a model with no price | `--budget`, counted at the ceiling price | v0.1.0, [5e2338e](https://github.com/maximilliangrand/nightshift/commit/5e2338e) | red team |
| `noeol-stream` | one huge event, no newline | `--max-tokens`, a complete object is parsed without waiting for a newline | v0.1.0, [5e2338e](https://github.com/maximilliangrand/nightshift/commit/5e2338e) | red team |
| `orphan` | detaches a child, exits 0 | orphan sweep after exit | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `fork-bomb-lite` | 30 children, then silence | `--idle-timeout`, the whole group dies | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `disk-filler` | fills the disk | `--max-disk-growth --watch .` | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | incident |
| `output-flood` | floods stdout | `--max-output`, checked per chunk | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | incident |
| `budget-blower` | spends without limit | `--budget`, per-message dedupe | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `token-blower` | burns tokens | `--max-tokens` | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `send-loop` | sends 21 messages | ledger: 5 allowed, 16 refused | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | incident |
| `kill-file` | must be stopped by hand | `nightshift stop latest` from the harness | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `postcondition` | claims success, produced nothing | `--require`, exit code 3 | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | incident |
| `stdin-waiter` | waits for a keyboard | stdin is closed by default, exits at once | v0.1.0, [732af04](https://github.com/maximilliangrand/nightshift/commit/732af04) | design |
| `cgroup-escape` | setsid, env {}, cwd /, silent exit | the cgroup net (Linux only) | v0.1.0, pending | red team |
<!-- /cases:table -->

Origins: **incident** is something that happened on one of our machines; **design** is a limit the first version had to prove; **review** is a finding from the pre-release reviews; **red team** is an attack that got through and was closed; **issue #N** is a report from the tracker.

## History

<!-- cases:history -->
v0.1.0: 13 → 16 → 20 → 21
<!-- /cases:history -->

Counts per commit of `crashtest/run.ts`, grouped by the package version at that commit.

## How to add yours

1. Open an issue with the "My agent escaped" form: what the agent did, the command and limits, the `report.md`, the OS, and the smallest agent that reproduces it.
2. Write that agent into `crashtest/agents/<name>.ts` (or `.sh`), under twenty lines, and append a case to the end of `CASES` in `crashtest/run.ts` with `origin: "issue #N"`. Run it alone with `bun run crashtest <name>` and watch it fail.
3. Fix nightshift until the case passes and nothing from it is left running.
4. Run `bun scripts/cases.ts --write` to update this page and the README count, and `bun run crashtest` for the whole suite.

The harness, what a case may assert, and what the suite deliberately does not cover are in [CRASHTEST.md](CRASHTEST.md). The pull request checklist is in [CONTRIBUTING.md](../CONTRIBUTING.md).
