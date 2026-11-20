/**
 * A Team: its members, how many of their turns may run at once, and the newest posts of its
 * Workstream, where its members coordinate. The Watch keeps it current.
 */
import { describe, type Team, type WatchUpdate, type WorkstreamPost } from "@supertag/client/model";
import { useWatchRefresh, type WatchFeed } from "@supertag/client/react";
import { useCallback, useState } from "react";
import type { TuiGateway } from "./connection";
import { safe, shortTime } from "./text";
import { color } from "./ui";

export function TeamView({
  gateway,
  watch,
  team,
  tagName,
}: {
  gateway: TuiGateway;
  watch: WatchFeed | undefined;
  team: Team;
  tagName(tagId: string): string;
}) {
  const [posts, setPosts] = useState<WorkstreamPost[] | undefined>();
  const [problem, setProblem] = useState("");
  const id = team.teamId;
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const listed = await gateway.workstreamPosts(id);
        if (signal.aborted) return;
        setPosts(listed);
        setProblem("");
      } catch (error) {
        if (!signal.aborted) setProblem(describe(error));
        return false;
      }
    },
    [gateway, id],
  );
  const changed = useCallback(
    (update: WatchUpdate) => update.kind === "team" && update.teamId === id,
    [id],
  );
  useWatchRefresh(read, 5_000, watch, changed);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      minWidth={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color.strong}>{safe(team.name)}</text>
      <text fg={color.muted}>
        {safe(team.teamId)} · {team.memberTagIds.length}{" "}
        {team.memberTagIds.length === 1 ? "member" : "members"}
      </text>
      <text fg={color.text}>
        Members: {team.memberTagIds.map((tagId) => safe(tagName(tagId))).join(", ") || "none"}
      </text>
      <text fg={color.faint} marginTop={1}>
        Workstream
      </text>
      {problem ? <text fg={color.warning}>{safe(problem)}</text> : null}
      {posts === undefined && !problem ? <text fg={color.muted}>Loading posts…</text> : null}
      {posts?.length === 0 ? <text fg={color.muted}>No posts yet.</text> : null}
      <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
        {(posts ?? []).map((post) => (
          <box key={post.postId} flexDirection="column" marginBottom={1}>
            <text fg={color.accent}>
              {safe(tagName(post.authorTagId))}
              {post.toTagIds.length
                ? ` → ${post.toTagIds.map((tagId) => safe(tagName(tagId))).join(", ")}`
                : ""}
              <span fg={color.faint}> {post.createdAtMs ? shortTime(post.createdAtMs) : ""}</span>
            </text>
            <text fg={color.text}>{safe(post.body)}</text>
          </box>
        ))}
      </scrollbox>
    </box>
  );
}
