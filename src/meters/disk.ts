/**
 * Two ways to notice an agent eating the disk:
 *
 * - free space on the volume under the working directory, via `df`. Cheap,
 *   catches writes anywhere on that volume, but noisy: other processes
 *   write too, so treat it as a smoke alarm rather than a meter.
 * - size of specific directories, via `du`. Exact, but `du` on a huge tree is
 *   slow, so if one sample takes longer than a few seconds that directory is
 *   dropped from the watch list and the report says so.
 *
 * Growth is the larger of the two signals.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DU_TIMEOUT_MS = 5000;

export interface DiskGrowth {
  bytes: number;
  where: string;
  freeDeltaBytes: number;
  watched: Record<string, number>;
}

export class DiskMeter {
  private baseFree: number | null = null;
  private baseSizes = new Map<string, number>();
  private dropped = new Set<string>();
  readonly notes: string[] = [];

  constructor(
    private readonly volumePath: string,
    private readonly watchDirs: string[],
  ) {}

  describe(): string {
    const dirs = this.watchDirs.length ? `watching ${this.watchDirs.join(", ")}` : "no watched dirs";
    return `free space on ${this.volumePath}; ${dirs}`;
  }

  async baseline(): Promise<void> {
    this.baseFree = await freeBytes(this.volumePath);
    for (const dir of this.watchDirs) {
      const size = await dirBytes(dir);
      if (size === null) {
        this.dropped.add(dir);
        this.notes.push(`du on ${dir} took longer than ${DU_TIMEOUT_MS / 1000}s; not watching it`);
      } else {
        this.baseSizes.set(dir, size);
      }
    }
  }

  async growth(): Promise<DiskGrowth> {
    const free = await freeBytes(this.volumePath);
    const freeDeltaBytes = this.baseFree !== null && free !== null ? this.baseFree - free : 0;
    let bytes = Math.max(0, freeDeltaBytes);
    let where = `volume under ${this.volumePath}`;
    const watched: Record<string, number> = {};
    for (const [dir, base] of this.baseSizes) {
      if (this.dropped.has(dir)) continue;
      const size = await dirBytes(dir);
      if (size === null) {
        this.dropped.add(dir);
        this.notes.push(`du on ${dir} became slow mid-run; stopped watching it`);
        continue;
      }
      const grew = size - base;
      watched[dir] = grew;
      if (grew > bytes) {
        bytes = grew;
        where = dir;
      }
    }
    return { bytes, where, freeDeltaBytes, watched };
  }
}

export async function freeBytes(p: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("df", ["-k", p]);
    const line = stdout.trim().split("\n").pop() ?? "";
    const cols = line.trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted
    const available = Number(cols[3]);
    return Number.isFinite(available) ? available * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * `du` exits 1 for any warning (an unreadable subdirectory, a temp file that
 * vanished between readdir and stat) while still printing a correct total.
 * Only a timeout means the directory is unmeasurable.
 */
export async function dirBytes(dir: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("du", ["-sk", dir], { timeout: DU_TIMEOUT_MS }));
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stdout?: string };
    if (failure.killed || failure.signal || typeof failure.stdout !== "string") return null;
    stdout = failure.stdout;
  }
  const kb = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}
