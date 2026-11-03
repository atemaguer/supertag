import { isIP } from "node:net";

/** Socket peer evidence: only numeric loopback addresses, never DNS names or unspecified IPs. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  if (family !== 6 || address.includes("%")) return false;
  // URL canonicalization handles compressed, expanded, and dotted IPv4-mapped forms alike.
  const hostname = new URL(`http://[${address}]`).hostname;
  return hostname === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/u.test(hostname);
}
