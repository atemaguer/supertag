import { afterEach, expect, it, vi } from "vitest";
import { runObjectiveCommand } from "../apps/cli/src/objectives.js";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.js";

afterEach(() => vi.restoreAllMocks());

const LIST = "ObjectiveService/ListObjectives";

it("lists every Objective without an owner", async () => {
  const rpc = fakeOperatorRpc({ [LIST]: () => ({ objectives: [{ id: "new" }, { id: "old" }] }) });
  expect(
    JSON.parse(await runObjectiveCommand({ url: "http://localhost", token: "t" }, ["list"])),
  ).toEqual({ objectives: [{ id: "new" }, { id: "old" }] });
  expect(rpc.called(LIST)[0]?.body).toEqual({});
});

it("filters Objectives by the named owner instead of a positional Tag", async () => {
  const rpc = fakeOperatorRpc({ [LIST]: () => ({}) });
  await runObjectiveCommand({ url: "http://localhost", token: "t" }, [
    "list",
    "--owner",
    "reviewer",
  ]);
  expect(rpc.called(LIST)[0]?.body).toEqual({ owner: "reviewer" });
});
