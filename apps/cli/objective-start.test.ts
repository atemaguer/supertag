import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "./src/action-command.js";
import { ControlPlaneClient, ControlPlaneRequestError } from "./src/control-plane-client.js";
import { runObjectiveCommand } from "./src/objectives.js";

afterEach(() => vi.restoreAllMocks());

const target = { url: "http://localhost", token: "test" };
const created = { id: "launch", status: "created", executionStartedAt: null };
const started = {
  ...created,
  status: "working",
  executionStartedAt: "2026-10-07T00:00:00Z",
  deadline: "2026-10-08T00:00:00Z",
  budgetLimitMinor: 500,
  budgetCurrency: "USD",
};

describe("start objective", () => {
  it("routes the public action-first command", () => {
    expect(
      normalizeActionFirstCommand(["start", "objective", "launch", "--output", "json"]),
    ).toEqual(["objective", "start", "launch", "--output", "json"]);
  });

  it("starts through coordination and prints a short human summary", async () => {
    let reads = 0;
    const request = vi
      .spyOn(ControlPlaneClient.prototype, "request")
      .mockImplementation(async (path) => {
        if (path.endsWith("/launch")) return (reads++ === 0 ? created : started) as never;
        if (path.endsWith("/start_objective")) return { taskId: "launch:start" } as never;
        throw new Error(path);
      });
    const output = await runObjectiveCommand(target, ["start", "launch"]);
    expect(request).toHaveBeenCalledWith("/api/v1/coordination/start_objective", {
      method: "POST",
      body: JSON.stringify({ objectiveId: "launch" }),
    });
    expect(output).toContain("objective/launch started; status working");
    expect(output).toContain("Deadline: 2026-10-08T00:00:00Z");
    expect(output).toContain("Budget: $5.00");
    expect(output).toContain("supertag describe objective launch");
    expect(output).not.toContain("executionStartedAt");
  });

  it("prints the structured start result as JSON", async () => {
    vi.spyOn(ControlPlaneClient.prototype, "request").mockImplementation(async (path) => {
      if (path.endsWith("/launch")) return (thisRead++ === 0 ? created : started) as never;
      return { taskId: "launch:start", teamId: "launch:leadership" } as never;
    });
    let thisRead = 0;
    const result = JSON.parse(
      await runObjectiveCommand(target, ["start", "launch", "--output", "json"]),
    );
    expect(result).toEqual({ taskId: "launch:start", teamId: "launch:leadership" });
  });

  it("reports an unknown Objective before starting", async () => {
    const request = vi
      .spyOn(ControlPlaneClient.prototype, "request")
      .mockRejectedValue(new ControlPlaneRequestError("Not found", 404));
    await expect(runObjectiveCommand(target, ["start", "missing"])).rejects.toThrow(
      "Objective missing was not found",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports an Objective that has already started", async () => {
    const request = vi
      .spyOn(ControlPlaneClient.prototype, "request")
      .mockResolvedValue(started as never);
    await expect(runObjectiveCommand(target, ["start", "launch"])).rejects.toThrow(
      "Objective launch has already started",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
