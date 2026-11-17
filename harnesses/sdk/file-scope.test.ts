import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import vectors from "../../core/crates/protocol/testdata/file_scope_vectors.json" with {
  type: "json",
};
import {
  FileScopeRules,
  fileScopeOf,
  fileScopeRefusal,
  resolveOutsideDirectories,
} from "./src/file-scope.js";

interface Vector {
  readonly name: string;
  readonly write?: string[];
  readonly readOnly?: string[];
  readonly hidden?: string[];
  readonly checks: {
    readonly path: string;
    readonly read: boolean;
    readonly write: boolean;
    readonly searchMayContainHidden?: boolean;
  }[];
}

it("agrees with the Rust matcher on every shared vector", () => {
  for (const vector of vectors.cases as Vector[]) {
    const rules = new FileScopeRules({
      write: vector.write ?? [],
      readOnly: vector.readOnly ?? [],
      hidden: vector.hidden ?? [],
    });
    for (const check of vector.checks) {
      expect(rules.readDenial(check.path) === undefined, `${vector.name}: read ${check.path}`).toBe(
        check.read,
      );
      expect(
        rules.writeDenial(check.path) === undefined,
        `${vector.name}: write ${check.path}`,
      ).toBe(check.write);
      if (check.searchMayContainHidden !== undefined)
        expect(rules.mayContainHidden(check.path), `${vector.name}: search ${check.path}`).toBe(
          check.searchMayContainHidden,
        );
    }
  }
});

const empty = { write: [], readOnly: [], hidden: [], outsideWrite: [], outsideRead: [] };

function task(actions: string[], files: Partial<typeof empty>, workspace = true) {
  return {
    allowedActions: actions,
    ...(workspace ? { workspace: {} } : {}),
    policySnapshot: { runtimeAuthority: { files: { ...empty, ...files } } },
  };
}

it("refuses scopes a harness cannot apply before it starts", () => {
  expect(fileScopeOf(task(["files:read"], {}))).toBeUndefined();
  const hidden = { hidden: ["**/.env"] };
  expect(fileScopeRefusal(task(["files:read"], hidden), "claude-code")).toBeUndefined();
  expect(
    fileScopeRefusal(task(["files:write", "commands:execute"], hidden), "claude-code"),
  ).toContain("hidden paths (**/.env)");
  expect(
    fileScopeRefusal(task(["files:write", "commands:execute"], { write: ["src/"] }), "opencode"),
  ).toBeUndefined();
  expect(
    fileScopeRefusal(
      task(["files:write", "commands:execute"], { write: ["src/"] }, false),
      "opencode",
    ),
  ).toContain("without a Workspace");
  expect(fileScopeRefusal(task(["files:read"], hidden), "cursor-local")).toContain("local tools");
  expect(fileScopeRefusal(task(["files:read"], {}), "cursor-local")).toBeUndefined();
  expect(fileScopeRefusal(task(["files:read"], hidden), "cursor-remote")).toBeUndefined();
  expect(
    fileScopeRefusal(task(["files:read"], { outsideRead: ["/opt/data"] }), "cursor-remote"),
  ).toContain("additionalDirectories");
  expect(
    fileScopeRefusal(task(["files:write", "commands:execute"], hidden), "cursor-shared"),
  ).toContain("shared execution");
  expect(fileScopeRefusal(task(["files:write"], hidden), "cursor-shared")).toBeUndefined();
});

it("expands, verifies, and fences outside directories", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "supertag-scope-")));
  try {
    const workspace = join(root, "workspace");
    const cache = join(root, "cache");
    const state = join(root, "state");
    for (const path of [join(workspace, ".git"), cache, state])
      await mkdir(path, { recursive: true });
    const resolved = await resolveOutsideDirectories(
      { ...empty, outsideWrite: [cache], outsideRead: [cache, root.replace(/\/$/u, "")] },
      workspace,
      [state],
    ).catch((error: Error) => error);
    // The root contains the Workspace and the reserved state.
    expect(resolved).toBeInstanceOf(Error);
    expect(
      await resolveOutsideDirectories({ ...empty, outsideWrite: [cache] }, workspace, [state]),
    ).toEqual({ write: [cache], read: [] });
    for (const bad of [
      join(workspace, ".git"),
      workspace,
      state,
      join(root, "missing"),
      userInfo().homedir,
      "/",
    ])
      await expect(
        resolveOutsideDirectories({ ...empty, outsideRead: [bad] }, workspace, [state]),
      ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
