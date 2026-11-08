import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runTeamCommand } from "../apps/cli/src/teams.js";

afterEach(() => vi.restoreAllMocks());

it("lists every Team, which stands on its own rather than under an Objective", async () => {
  const items = [
    { id: "crew", name: "Crew", memberTagIds: ["a", "b"], maxConcurrency: 2, revision: 1 },
  ];
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "t" });
  const request = vi.spyOn(client, "request").mockResolvedValue({ items });
  expect(JSON.parse(await runTeamCommand(client, ["list"]))).toEqual({ items });
  expect(request).toHaveBeenCalledWith("/api/v1/tag-messaging/teams");
});

it("refuses an Objective filter, which no longer selects Teams", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "t" });
  await expect(runTeamCommand(client, ["list", "--objective", "ship"])).rejects.toThrow(
    /Unknown option '--objective'/u,
  );
});
