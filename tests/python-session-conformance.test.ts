import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { registerSessionGrpcRoutes } from "../apps/cli/src/session-grpc.js";
import type { SessionPersistence } from "../packages/control-plane/src/session-persistence.js";
import { TagMessagingError } from "../packages/core/src/index.js";
import type { StoredHarnessSessionState } from "../packages/runtime/sdk/src/index.js";
import {
  type RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";

it.skipIf(!process.env["SUPERTAG_CONFORMANCE_PYTHON"])(
  "streams native archives through the production adapter using independent Python bindings",
  async () => {
    const states = new Map<string, StoredHarnessSessionState>();
    const token = "python-fixture-authority";
    const service = {
      async execution(credential: string | undefined) {
        if (credential !== token) throw new TagMessagingError(401, "Invalid credential");
      },
      async command(
        operation: string,
        value: StoredHarnessSessionState,
        credential: string | undefined,
      ) {
        await this.execution(credential);
        if (operation === "save") {
          states.set(value.ref.id, value);
          return {};
        }
        return states.get(value.ref.id) ?? null;
      },
    };
    const listener = await startWorkletGrpcServer({
      remote: {} as RemoteWorkletServer,
      registerRoutes: (router) =>
        registerSessionGrpcRoutes(router, service as unknown as SessionPersistence),
    });
    try {
      const { stdout } = await promisify(execFile)(
        process.env["SUPERTAG_CONFORMANCE_PYTHON"] as string,
        ["tests/fixtures/python-execution/session_conformance.py"],
        {
          timeout: 30000,
          env: {
            ...process.env,
            PYTHONPATH: process.env["SUPERTAG_CONFORMANCE_BINDINGS"],
            SUPERTAG_SESSION_CONFORMANCE_ADDRESS: new URL(listener.url).host,
            SUPERTAG_SESSION_CONFORMANCE_TOKEN: token,
          },
        },
      );
      expect(stdout).toContain("conformance passed");
      expect(states.size).toBe(1);
    } finally {
      await listener.close();
    }
  },
);
