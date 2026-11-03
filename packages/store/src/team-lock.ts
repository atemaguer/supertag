// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle transaction across dialects.
import { TagMessagingError } from "@supertag/core";
import { eq, sql } from "drizzle-orm";

/** Objective lock first, then ancestor Team locks in ID order, then Tag locks. */
export function* lockTeamAncestors(tx: any, teams: any, teamId: string): Generator<any, void, any> {
  const ids = new Set<string>();
  let id: string | null = teamId;
  while (id) {
    if (ids.has(id)) throw new TagMessagingError(409, "Team hierarchy cycle");
    ids.add(id);
    const [team]: any[] = yield tx.select().from(teams).where(eq(teams.id, id));
    if (!team) throw new TagMessagingError(404, "Team not found");
    id = team.parentTeamId;
  }
  for (const id of [...ids].sort()) {
    yield tx
      .update(teams)
      .set({ updatedAt: sql`${teams.updatedAt}` })
      .where(eq(teams.id, id))
      .returning();
  }
}
