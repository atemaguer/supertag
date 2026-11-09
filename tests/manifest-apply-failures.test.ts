import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isInternalFailure,
  type ManifestApplyContext,
  ManifestInputError,
} from "../apps/cli/src/manifest-apply.ts";
import { controlPlaneResourceControl } from "../apps/cli/src/resource-operations.ts";
import { TagMessagingError } from "../packages/core/src/index.ts";
import { ErrorReason, ManifestOutcome } from "../packages/operator-api/src/index.ts";
import { DrizzleStore } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const principal = { operatorId: "operator", scopes: { actions: ["*"] } } as never;
const tag = (name: string) => ({
  manifest: { apiVersion: "supertag/v1", kind: "Tag", metadata: { name }, spec: {} },
  source: `${name}.yaml`,
  secrets: {},
});
const request = (...names: string[]) =>
  ({
    documents: names.map(tag),
    applySet: "",
    prune: false,
    forceConflicts: false,
    createOnly: false,
    imperative: false,
  }) as never;

describe("an apply the Control Plane itself fails", () => {
  let directory: string;
  let store: DrizzleStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-apply-failures-"));
    const database = join(directory, "state.db");
    await migrateSqlite(database);
    store = new DrizzleStore({ url: `file:${database}` });
    await store.connect();
  });

  afterEach(async () => {
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  /** The store, losing its database connection when `failing` is first called. */
  function context(failing: string): ManifestApplyContext {
    const lost = new Proxy(store, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (property === failing) await target.disconnect();
          return (value as (...values: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return {
      store: lost,
      credentialVault: {} as never,
      controlPlane: { isAccepting: () => true, listWorkerHosts: async () => [] } as never,
      startedAt: new Date().toISOString(),
      verifySurface: async () => {
        throw new Error("unused");
      },
    };
  }

  it("reports a document's write failure as internal, naming no database detail", async () => {
    const applied = await controlPlaneResourceControl(context("createTag")).applyManifests(
      request("builder", "reviewer"),
      principal,
    );
    expect(applied.complete).toBe(false);
    expect(applied.results?.map((result) => result.outcome)).toEqual([
      ManifestOutcome.FAILED,
      ManifestOutcome.NOT_APPLIED,
    ]);
    expect(applied.results?.[0]).toMatchObject({
      failureMessage: "Control Plane internal error",
      failure: { reason: ErrorReason.INTERNAL },
    });
  });

  it("fails the call, rather than refusing the input, when the database fails during validation", async () => {
    const failed = await controlPlaneResourceControl(context("findTagByName"))
      .applyManifests(request("builder"), principal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).not.toBeInstanceOf(ManifestInputError);
    expect(isInternalFailure(failed)).toBe(true);
  });

  it("keeps the input's own refusals, including one that wraps a database error", () => {
    expect(isInternalFailure(new Error("Role reviewer does not exist"))).toBe(false);
    expect(
      isInternalFailure(new Error("A Tag named x already exists", { cause: new TypeError("x") })),
    ).toBe(false);
    expect(isInternalFailure(new TagMessagingError(409, "in use"))).toBe(false);
    expect(isInternalFailure(new TypeError("Cannot read properties of undefined"))).toBe(true);
    expect(
      isInternalFailure(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      ),
    ).toBe(true);
  });
});
