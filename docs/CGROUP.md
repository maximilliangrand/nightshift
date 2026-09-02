# The cgroup net

The README describes four nets that a kill casts over an agent's process tree: the process group, the descendant map, the environment marker and the stray check. Each identifies a process by something the process can change about itself. A process that calls `setsid()`, is orphaned onto `init`, starts with an empty environment and `chdir`s away from the run's directory is invisible to all four. The `cgroup-escape` case in the crash suite does exactly that, on purpose, in five lines.

On Linux there is a fifth net that does not care about any of it. Cgroup membership is inherited on `fork()` and can only be changed by writing to the cgroup filesystem, which the agent cannot do unless it owns the directory. So `cgroup.procs` lists every descendant of the agent, however it was started and whatever it did afterwards.

## What it does

When a run starts on Linux, `src/cgroup.ts` tries, in this order:

1. **An own sub-cgroup.** `/proc/self/cgroup` names the cgroup v2 directory nightshift itself lives in (the `0::/...` line). nightshift tries `mkdir /sys/fs/cgroup/<that>/nightshift-<runId>` and, if that works, proves the directory is usable by moving a throwaway `sh` into it. The agent is then started through a one-line wrapper (below) so that it is inside the cgroup before it can spawn anything.
2. **A systemd user scope.** `systemd-run --user --scope --quiet --collect --unit=nightshift-<runId> -- <command>`, proven first with a no-op through the same flags. `systemd-run --scope` execs the command in place, so the pid nightshift spawned is the agent's pid and the exit code passes straight through. The scope's directory is read back from `/proc/<pid>/cgroup` once the agent is inside it.

If neither works, the run proceeds with the four nets exactly as before, and the report says why.

While the cgroup is active:

- `survivors()` unions the pids in `cgroup.procs` with what the other nets found, on every check.
- The SIGTERM wave signals every pid in the cgroup. The SIGKILL wave writes `1` to `cgroup.kill` (kernel 5.14 and later), which takes the whole cgroup down atomically; on an older kernel it sends SIGKILL to every pid listed.
- The orphan sweep after a normal exit reads the same list, so an escapee left behind by an agent that exited 0 is found and killed and appears under **Orphans** in the report.
- When the run ends, the directory is removed (`rmdir`, retried briefly while a just-killed process is still leaving). A directory that could not be removed is a note in the report with the count of processes still inside; those are the same pids listed under **Survivors**.

## When it is active

The first strategy needs cgroup v2 mounted at `/sys/fs/cgroup` and a cgroup directory nightshift's own user may write to. That is true for a systemd user session (`user@<uid>.service` is delegated to the user, and anything started from a user service, from `systemd-run --user`, or from a terminal under a desktop session lives inside it) and for root anywhere. The second strategy needs a running user manager, which a login session has and cron typically does not.

Typical outcomes:

| Where nightshift runs | Result |
|---|---|
| a terminal in a systemd user session | active, own sub-cgroup or user scope |
| a systemd user service or timer | active, own sub-cgroup |
| root, anywhere with cgroup v2 | active, own sub-cgroup |
| cron as a normal user | unavailable: the cron cgroup belongs to root and there is no user bus |
| a Docker container | unavailable: `/sys/fs/cgroup` is usually read-only inside the container |
| a GitHub hosted runner as the `runner` user | unavailable: no delegated cgroup, no user manager |
| macOS | unavailable: no cgroups |

## How to check

Every report carries one of these notes:

```
- cgroup net: active (/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/nightshift-20260902-195455-auvk5t.scope)
- cgroup net: unavailable (mkdir /sys/fs/cgroup/system.slice/cron.service/nightshift-...: EACCES; systemd-run --user --scope: Failed to connect to bus: No medium found)
- cgroup net: unavailable (only on Linux)
```

The reason strings are the kernel's and systemd's own words, so `EACCES` on the mkdir means the parent directory is not yours, `EROFS` means a read-only mount (containers), and "Failed to connect to bus" means there is no user manager for this uid. `nightshift report latest` shows the note under **Notes**; `report.json` has it in `notes`. The crash suite prints the same note in the `cgroup-escape` line, followed by `caught 1 escapee` when the net was active and `n/a` with the reason when it was not.

To make the net available under cron, run the job through the user's systemd instead: `systemd-run --user --on-calendar=03:00 nightshift run ...`, or `loginctl enable-linger <user>` plus a user timer. The job then lives in `user@<uid>.service`, which the user owns.

## The wrapper trick

The agent must be inside the cgroup before its first `fork()`, or that first child is already outside. Moving the agent's pid after `spawn` returns is a race that a fast agent wins. So the command is wrapped:

```
sh -c 'echo $$ > "$0/cgroup.procs" && exec "$@"' <cgroupDir> <command...>
```

`sh` writes its own pid into the cgroup (`$0` is the first argument after the script, the directory), then `exec`s the agent in place. The agent inherits the pid, the membership, the stdio pipes and the process group; the exit code passes through unchanged; the report's pid is the agent's pid. If the move fails the `&&` prevents the `exec`, so the agent never runs outside the net by accident, but that path is closed off earlier: the directory was already proven writable with a throwaway `sh`, and a command that does not exist on `PATH` is never wrapped at all, so it still fails to start the way the report expects.

`cgroup.subtree_control` is not touched. Tracking processes needs no controller.

## What remains impossible

- **A cgroup the agent may write to.** If the agent runs as the same user and that user owns the cgroup directory (which is the case for an own sub-cgroup under a delegated tree), the agent can move a child out by writing to another `cgroup.procs` it can also write to. The net stops accidents and every ordinary detach; it does not stop an agent that deliberately edits `/sys/fs/cgroup`. A different uid, or a container with a read-only cgroup mount, closes that too.
- **Anything without cgroup v2.** v1-only kernels, macOS, and containers with a read-only `/sys/fs/cgroup` get the four nets and a note saying so.
- **A supervisor that dies hard.** If nightshift itself is SIGKILLed, the own sub-cgroup directory stays behind. An empty cgroup directory costs nothing and `rmdir` removes it; a systemd scope is collected by systemd on its own.
- **Anything nightshift did not start.** A process the agent talks to over a socket, a daemon it asked systemd to start, a container it launched through a daemon: those are in someone else's cgroup.

The crash suite does not prove the net on every machine it runs on. On macOS the `cgroup-escape` case is n/a. On a GitHub hosted runner the runner user has no cgroup of its own, so the `check` job reports n/a there too, and a separate `cgroup-probe` job runs the same case as root, where an own sub-cgroup can be created under the runner's service cgroup. The report note is the source of truth for any given run.
