#!/bin/sh
# A shell wrapper (dies on SIGTERM at once) around a worker that ignores it.
# The worker must still get the grace period, then SIGKILL.
exec_dir=$(dirname "$0")
bun "$exec_dir/ignore-sigterm.ts" &
wait
