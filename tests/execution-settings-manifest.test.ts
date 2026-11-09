import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import type { ResourcePath } from "../apps/cli/src/resource-protos.ts";
import { migrateSqlite } from "./support/database.ts";
import { getResource } from "./support/resources.ts";

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

const reviewerRole = `${header("Role", "Reviewer")}spec:
  purpose: Review changes.
  execution:
    harness: codex
    model: [gpt-6-sol, gpt-6-max]
    effort: [medium, high]
`;

describe("Role and Tag execution settings in manifests", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-execution-manifest-"));
    const serverState = join(directory, "server");
    const databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
    });
    output = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
    await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
    client = new ControlPlaneClient({ url: runtime.url, token });
  });

  afterEach(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const write = async (name: string, content: string) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };
  const run = async (...args: string[]) => {
    output.length = 0;
    await expect(main(args)).resolves.toBe(0);
    return output.join("");
  };
  const fail = async (...args: string[]) => {
    const error = await main(args).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  };
  const resource = (path: ResourcePath, name: string) =>
    getResource<{ spec: Record<string, unknown>; status: Record<string, unknown> }>(
      client,
      path,
      name,
    );

  it("applies, exports, and removes a Role's execution settings", async () => {
    const path = await write("role.yaml", reviewerRole);
    await run("apply", "-f", path);
    expect((await resource("roles", "Reviewer")).spec["execution"]).toEqual({
      harness: "codex",
      model: ["gpt-6-sol", "gpt-6-max"],
      effort: ["medium", "high"],
    });
    expect(await run("diff", "-f", path)).toContain("No changes.");
    const exported = await run("get", "role", "Reviewer", "--output", "yaml");
    expect(exported).toContain("execution:");
    expect(exported).toContain("gpt-6-max");
    // The exported manifest applies back without changes.
    expect(await run("diff", "-f", await write("exported.yaml", exported))).toContain(
      "No changes.",
    );
    // A single value means only that value.
    await run(
      "apply",
      "-f",
      await write(
        "single.yaml",
        `${header("Role", "Reviewer")}spec:\n  purpose: Review changes.\n  execution:\n    model: gpt-6-sol\n`,
      ),
    );
    expect((await resource("roles", "Reviewer")).spec["execution"]).toEqual({
      model: ["gpt-6-sol"],
    });
    // Dropping the field removes what this manager set.
    await run(
      "apply",
      "-f",
      await write("bare.yaml", `${header("Role", "Reviewer")}spec:\n  purpose: Review changes.\n`),
    );
    expect((await resource("roles", "Reviewer")).spec["execution"]).toBeUndefined();
  });

  it("rejects invalid execution settings with the field and allowed values", async () => {
    const invalid = await write(
      "invalid.yaml",
      `${header("Role", "Reviewer")}spec:\n  purpose: Review changes.\n  execution:\n    effort: maximum\n`,
    );
    expect(await fail("apply", "-f", invalid)).toContain(
      "Role spec.execution.effort entries must be low, medium, high",
    );
    const unknown = await write(
      "unknown.yaml",
      `${header("Tag", "builder")}spec:\n  execution:\n    models: [gpt-6-sol]\n`,
    );
    expect(await fail("apply", "-f", unknown)).toContain(
      "Tag spec.execution contains unknown fields: models",
    );
  });

  it("lets a Tag override its Role and shows the effective range", async () => {
    await run(
      "apply",
      "-f",
      await write(
        "organization.yaml",
        `${reviewerRole}---\n${header("Tag", "reviewer")}spec:\n  roles: [Reviewer]\n  execution:\n    effort: high\n`,
      ),
    );
    const tag = await resource("tags", "reviewer");
    expect(tag.spec["execution"]).toEqual({ effort: ["high"] });
    expect(tag.status["execution"]).toEqual({
      harness: "codex",
      model: ["gpt-6-sol", "gpt-6-max"],
      effort: ["high"],
    });
    expect(await run("describe", "tag", "reviewer")).toContain(
      "Execution: harness codex; model gpt-6-sol, gpt-6-max; effort high",
    );
    const exported = await run("get", "tag", "reviewer", "--output", "yaml");
    expect(exported).toContain("execution:");
    expect(exported).toContain("- high");
  });

  it("treats execution as one field another manager owns", async () => {
    const tag = (effort: string) =>
      `${header("Tag", "builder")}spec:\n  execution:\n    effort: ${effort}\n`;
    await run("apply", "-f", await write("a.yaml", tag("medium")), "--set", "team-a");
    const conflicting = await write("b.yaml", tag("high"));
    expect(await run("diff", "-f", conflicting, "--set", "team-b")).toContain(
      "spec.execution owned by team-a",
    );
    expect(await fail("apply", "-f", conflicting, "--set", "team-b")).toContain(
      "spec.execution is owned by team-a",
    );
    await run("apply", "-f", conflicting, "--set", "team-b", "--force-conflicts");
    expect((await resource("tags", "builder")).spec["execution"]).toEqual({
      effort: ["high"],
    });
    // A manifest without execution leaves another manager's settings alone.
    await run("apply", "-f", await write("bare.yaml", `${header("Tag", "builder")}spec: {}\n`));
    expect((await resource("tags", "builder")).spec["execution"]).toEqual({
      effort: ["high"],
    });
  });
});
