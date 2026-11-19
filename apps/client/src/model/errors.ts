/** A failed Gateway request as one message to show: the message itself, or a fixed sentence. */
export function describe(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "The Gateway request failed.";
}
