/**
 * The branch a Tag's Session delivers to, `supertag/session/<id>`, where `<id>` is the SHA-256 of
 * the JSON array of the Tag and Session IDs, as `supertag_protocol::session_branch` names it.
 */
export async function sessionBranch(tagId: string, sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([tagId, sessionId])),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `supertag/session/${hex.join("")}`;
}
