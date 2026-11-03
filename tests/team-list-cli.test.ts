import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runTeamCommand } from "../apps/cli/src/teams.js";

afterEach(() => vi.restoreAllMocks());

it("lists an Objective's Teams through the Objective read", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValue({ id: "ship", teams: [{ id: "ship:leadership", name: "Leadership" }] });
  const output = await runTeamCommand({ url: "http://127.0.0.1:1", token: "t" }, [
    "list",
    "--objective",
    "ship",
  ]);
  expect(request).toHaveBeenCalledWith("/api/v1/coordination/read_objective", {
    method: "POST",
    body: JSON.stringify({ objectiveId: "ship" }),
  });
  expect(JSON.parse(output)).toEqual([{ id: "ship:leadership", name: "Leadership" }]);
});
