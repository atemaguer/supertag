/** One `target: mcp` grant frozen into a Task's authorization snapshot. */
export interface TagMcpGrant {
  /** `server/tool`, where the tool part may contain `*`. */
  readonly action: string;
  /** A resource the call's arguments must name, when the server has a resource mapping. */
  readonly resource?: string;
}
