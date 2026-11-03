import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/**
 * The name this machine goes by, for naming its host service and Worker Host. On macOS the
 * `hostname` can be a network-assigned name such as `Mac.attlocal.net`, so the user-set
 * LocalHostName (`Dana-MacBook-Pro`) comes first there.
 */
export function machineName(
  platform: NodeJS.Platform = process.platform,
  localHostName: () => string | undefined = macLocalHostName,
): string {
  if (platform === "darwin") {
    const name = localHostName()?.trim();
    if (name) return name;
  }
  return hostname();
}

function macLocalHostName(): string | undefined {
  try {
    return execFileSync("scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
