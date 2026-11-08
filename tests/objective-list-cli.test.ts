import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { runObjectiveCommand } from "../apps/cli/src/objectives.js";

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
