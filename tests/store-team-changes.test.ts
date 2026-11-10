import type { Store } from "@supertag/core";
import { describe, expect, it } from "vitest";
import {
  type ChangeNotice,
  ChangeNotifications,
} from "../packages/control-plane/src/change-notifications.ts";
import { observeStoreChanges } from "../packages/control-plane/src/store-changes.ts";

describe("observeStoreChanges for Teams", () => {
  it("publishes a team notice for each Team created, changed or deleted, and none for a no-op", async () => {
    const team = { id: "team-1", name: "billing", memberTagIds: ["tag-1"], revision: 1 };
    const fake = {
      connect: async () => {},
      disconnect: async () => {},
      createTeam: async () => team,
      updateTeam: async () => ({ ...team, revision: 2 }),
      deleteTeam: async (id: string) => id === "team-1",
    };
    const changes = new ChangeNotifications();
    const seen: ChangeNotice[] = [];
    changes.subscribe((notice) => seen.push(notice));
    const store = observeStoreChanges(fake as unknown as Store, changes);
    await store.connect();
    await store.createTeam({ id: "team-1", name: "billing", memberTagIds: ["tag-1"] });
    await store.updateTeam("team-1", { expectedRevision: 1, memberTagIds: ["tag-1", "tag-2"] });
    await store.deleteTeam("team-missing");
    await store.deleteTeam("team-1");
    await store.disconnect();
    expect(seen.map(({ kind, id, teamId, reason }) => ({ kind, id, teamId, reason }))).toEqual([
      { kind: "team", id: "team-1", teamId: "team-1", reason: "created" },
      { kind: "team", id: "team-1", teamId: "team-1", reason: "changed" },
      { kind: "team", id: "team-1", teamId: "team-1", reason: "deleted" },
    ]);
  });
});
