# Contributing

nightshift is a supervisor, so the thing we care about most is an agent that got past it. If that happened to you, the issue is the contribution; the fix can come later, from you or from us.

## Every escape becomes a case

Open an issue with the **My agent escaped** form. Say what the agent did, the exact `nightshift run` command and limits, paste `report.md`, name the OS, and give the smallest agent that does the same thing. An accepted escape becomes a case in the crash suite *before* it is fixed: an agent under `crashtest/agents/`, an entry at the end of `CASES` in `crashtest/run.ts` with `origin: "issue #N"`, and a red line in `bun run crashtest`. Then the fix, and the line goes green. The scoreboard in [docs/CASES.md](docs/CASES.md) is that history; the badge in the README is its count.

We will not merge a fix without a case. A fix without a case is a claim, and the suite exists because claims about supervisors are cheap.

## Running one case

```bash
bun run crashtest <name>       # one case, with the report it produced
bun run crashtest              # all of them
bun run cases                  # the table, without running anything
```

Each case runs the real CLI against the agent with the limits that should catch it, reads the report it wrote, and then checks `ps` for anything the case left alive. How the harness works and what a case may assert is in [docs/CRASHTEST.md](docs/CRASHTEST.md).

## Pull request checklist

- `bun run typecheck` and `bun test` pass.
- `bun run crashtest` passes on your machine, and CI passes it on macOS and Linux.
- A new failure mode has an agent under twenty lines and a case that says what catches it and where it came from (`caught`, `origin`).
- `bun scripts/cases.ts --write` has been run, so the README badge and count and `docs/CASES.md` match the suite. `bun scripts/cases.ts --check` is the CI gate.
- No em-dashes or en-dashes anywhere, in code, comments, docs or commit messages. Commas, colons and hyphens do the job. `grep -rn -e $'\xe2\x80\x94' -e $'\xe2\x80\x93' --exclude-dir=node_modules --exclude-dir=.git .` should print nothing (those are the two dashes as UTF-8 bytes, so this file stays clean too).
- Comments explain why, not what. No stray `console.log`, no TODOs.
- Conventional commit messages: `feat(scope): ...`, `fix(scope): ...`.

## What we will not accept

- A fix without a case.
- A case that needs a real model or a network. `budget-blower.ts` fakes the stream; yours can too.
- A limit that can silently do nothing. If nightshift cannot measure something, it must refuse to start, not pretend.
- README samples that were not produced by a real run.
