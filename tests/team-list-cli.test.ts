import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runTeamCommand } from "../apps/cli/src/teams.js";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.js";

afterEach(() => vi.restoreAllMocks());

it("lists every Team, which stands on its own rather than under an Objective", async () => {
  const teams = [
    {
      id: "crew",
      name: "Crew",
      members: [
        { tagId: "a", tag: "alpha" },
        { tagId: "b", tag: "beta" },
      ],
      maxConcurrency: 2,
      revision: "1",
    },
  ];
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "t" });
  const rpc = fakeOperatorRpc({
    "TeamService/ListTeams": (body) =>
      body["pageToken"] ? { teams: [teams[0]] } : { teams, nextPageToken: "o1" },
  });
  expect(JSON.parse(await runTeamCommand(client, ["list"]))).toEqual({
    teams: [teams[0], teams[0]],
  });
  expect(rpc.called("TeamService/ListTeams").map((call) => call.body)).toEqual([
    { pageSize: 500 },
    { pageSize: 500, pageToken: "o1" },
  ]);
});

it("refuses an Objective filter, which no longer selects Teams", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "t" });
  await expect(runTeamCommand(client, ["list", "--objective", "ship"])).rejects.toThrow(
    /Unknown option '--objective'/u,
  );
});
