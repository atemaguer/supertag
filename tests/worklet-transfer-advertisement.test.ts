import { describe, expect, it } from "vitest";
import { artifactTransferListen } from "../apps/cli/src/worker.js";

const connected = { transferPort: 0, allowInsecureHttp: false } as const;

describe("Worklet artifact transfer advertisement", () => {
  it("advertises no loopback address to consumers on other machines", () => {
    // `connect worklet` defaults: a consumer elsewhere would dial its own loopback.
    for (const transferHost of ["127.0.0.1", "localhost", "::1", "127.0.0.2", "0.0.0.0", "::"])
      expect(artifactTransferListen({ ...connected, transferHost })).toBeUndefined();
  });

  it("advertises loopback when every consumer runs on this machine", () => {
    expect(
      artifactTransferListen({
        ...connected,
        transferHost: "127.0.0.1",
        consumersOnThisMachine: true,
      }),
    ).toEqual({ host: "127.0.0.1", port: 0, allowInsecureHttp: false });
  });

  it("advertises an address the operator configured", () => {
    expect(
      artifactTransferListen({
        ...connected,
        transferHost: "0.0.0.0",
        transferUrl: "https://worker-a.internal:8788",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 0,
      advertiseUrl: "https://worker-a.internal:8788",
      allowInsecureHttp: false,
    });
    expect(
      artifactTransferListen({ ...connected, transferHost: "10.0.0.7", transferPort: 8788 }),
    ).toEqual({ host: "10.0.0.7", port: 8788, allowInsecureHttp: false });
  });
});
