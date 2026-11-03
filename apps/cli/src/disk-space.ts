import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface DiskSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** The host's temporary filesystem is where local Task Attempt scratch is allocated. */
export async function readHostDiskSpace(): Promise<DiskSpace> {
  const volume = await statfs(tmpdir());
  return { freeBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize };
}

export function lowDiskWarning(space: DiskSpace | undefined): string | undefined {
  if (!space || !Number.isFinite(space.freeBytes) || !Number.isFinite(space.totalBytes))
    return undefined;
  if (space.totalBytes <= 0 || space.freeBytes < 0) return undefined;
  const threshold = Math.min(10 * 1024 ** 3, space.totalBytes * 0.05);
  if (space.freeBytes >= threshold) return undefined;
  return `Warning: Worker Host free disk ${Math.floor(space.freeBytes / 1024 ** 3)} GiB is below ${Math.ceil(threshold / 1024 ** 3)} GiB (min of 10 GiB and 5% of volume)`;
}
