import { Code, ConnectError } from "@connectrpc/connect";
import type { WorkerHost } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { controlPlaneControl } from "../apps/cli/src/operator-control-plane.ts";

describe("the Control Plane's operator control", () => {
  it("refuses to enroll the ID of the embedded Worklet's host, which is not stored", async () => {
    const enrolled: string[] = [];
    const control = controlPlaneControl(
      {
        controlPlane: {
          objectives: {},
          listWorkerHosts: async () => [{ id: "local" } as WorkerHost],
          enrollWorkerHost: async ({ id }: { id: string }) => {
            enrolled.push(id);
            return { workerHost: { id } as WorkerHost, token: "issued" };
          },
        } as never,
        store: {} as never,
        credentialVault: {} as never,
      },
      {} as never,
    );
    const refused = await control.enrollWorkerHost("local").then(
      () => undefined,
      (error: unknown) => ConnectError.from(error),
    );
    expect(refused?.code).toBe(Code.AlreadyExists);
    expect(refused?.rawMessage).toBe("Worker Host is already enrolled");
    expect(enrolled).toEqual([]);
    expect((await control.enrollWorkerHost("laptop")).workerHost.id).toBe("laptop");
    expect(enrolled).toEqual(["laptop"]);
  });
});
