import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runObjectiveCommand } from "../apps/cli/src/objectives.js";
import { runTeamCommand } from "../apps/cli/src/teams.js";

afterEach(() => vi.restoreAllMocks());

it("lists every Objective without an owner", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    items: [{ id: "new" }, { id: "old" }],
  });
  expect(
    JSON.parse(await runObjectiveCommand({ url: "http://localhost", token: "t" }, ["list"])),
  ).toEqual({ items: [{ id: "new" }, { id: "old" }] });
  expect(request).toHaveBeenCalledWith("/api/v1/tag-messaging/objectives?");
});

it("filters Objectives by the named owner instead of a positional Tag", async () => {
  vi.spyOn(ControlPlaneClient.prototype, "getTag").mockResolvedValue({
    metadata: { id: "reviewer-id" },
  } as Awaited<ReturnType<ControlPlaneClient["getTag"]>>);
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValue({ items: [] });
  await runObjectiveCommand({ url: "http://localhost", token: "t" }, [
    "list",
    "--owner",
    "reviewer",
  ]);
  expect(request).toHaveBeenCalledWith("/api/v1/tag-messaging/objectives?tagId=reviewer-id");
});

it("lists Teams of unfinished Objectives when no Objective is selected", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockImplementation(async (path) =>
      path === "/api/v1/tag-messaging/objectives?limit=200&offset=0"
        ? {
            items: [
              { id: "active", status: "working" },
              { id: "done", status: "completed" },
            ],
          }
        : { teams: [{ id: "active:team" }] },
    );
  const result = await runTeamCommand({ url: "http://localhost", token: "t" }, ["list"]);
  expect(JSON.parse(result)).toEqual([{ id: "active:team" }]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("pages through every unfinished Objective before listing Teams", async () => {
  const first = Array.from({ length: 200 }, (_, index) => ({
    id: `finished-${index}`,
    status: "completed",
  }));
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockImplementation(async (path) => {
      if (path === "/api/v1/tag-messaging/objectives?limit=200&offset=0") return { items: first };
      if (path === "/api/v1/tag-messaging/objectives?limit=200&offset=200")
        return { items: [{ id: "later", status: "working" }] };
      return { teams: [{ id: "later:team" }] };
    });
  expect(
    JSON.parse(await runTeamCommand({ url: "http://localhost", token: "t" }, ["list"])),
  ).toEqual([{ id: "later:team" }]);
  expect(request).toHaveBeenCalledWith("/api/v1/tag-messaging/objectives?limit=200&offset=200");
});
