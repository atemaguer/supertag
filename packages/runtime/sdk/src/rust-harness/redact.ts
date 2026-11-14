/** Strip exact execution credentials from content crossing the private Harness. */
export function redact(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets)
    if (secret.length >= 8) output = output.split(secret).join("[REDACTED]");
  return output;
}
