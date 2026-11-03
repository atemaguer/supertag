/** Scripted runners must not match another Task's preview in shared context. */
export function harnessRequest(prompt: string): string {
  const marker = "\nUser question:\n";
  const start = prompt.lastIndexOf(marker);
  if (start < 0) throw new Error("Missing Harness user request");
  return prompt.slice(start + marker.length);
}
