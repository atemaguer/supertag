import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const header = (kind: string, name: string) =>
  `apiVersion: supertag/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`;

/** The Workspace comes first, so dependency ordering, not file order, applies Volumes first. */
const organization = `${header("Workspace", "research")}spec:
  delivery: branch
---
${header("Volume", "datasets")}spec:
  source: s3://acme-data/datasets/v3/
  credential: acme-data
---
${header("Volume", "shared")}spec:
  source: file:///srv/shared
  credential: srv-shared
`;

describe("Volume manifests", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-volume-manifest-"));
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

  it("applies Volumes before Workspaces, round-trips through get and diff, lists, and describes them", async () => {
    const path = await write("organization.yaml", organization);
    expect(await run("apply", "-f", path)).toBe(
      [
        "Volume/datasets configured",
        "Volume/shared configured",
        "Workspace/research configured",
        "",
      ].join("\n"),
    );
    const datasets = await client.request<{ kind: string; spec: unknown; status: unknown }>(
      "/api/v1/volumes/datasets",
    );
    expect(datasets).toMatchObject({
      kind: "Volume",
      spec: { source: "s3://acme-data/datasets/v3/", credential: "acme-data" },
      status: { phase: "active" },
    });

    expect(await run("diff", "-f", path)).toContain("No changes.");

    const exported = await run("get", "volume", "datasets", "--output", "yaml");
    expect(exported).toBe(
      [
        "apiVersion: supertag/v1",
        "kind: Volume",
        "metadata:",
        "  name: datasets",
        "spec:",
        "  source: s3://acme-data/datasets/v3/",
        "  credential: acme-data",
        "",
      ].join("\n"),
    );
    expect(await run("diff", "-f", await write("exported.yaml", exported))).toContain(
      "No changes.",
    );

    const listed = JSON.parse(await run("list", "volume", "--output", "json")) as {
      items: { metadata: { name: string } }[];
    };
    expect(listed.items.map((item) => item.metadata.name)).toEqual(["datasets", "shared"]);

    expect(await run("describe", "volume", "datasets")).toBe(
      [
        "Volume: datasets",
        "Source: s3://acme-data/datasets/v3/",
        "Region: us-east-1",
        "Endpoint: AWS S3 (regional default)",
        "Force path style: false",
        "Credential: acme-data (a name; each Worker Host that serves this Volume maps it to a secret)",
        "",
      ].join("\n"),
    );
    expect(await run("describe", "volume", "shared")).toContain(
      "Credential: srv-shared (a name; each Worker Host that maps it consents to exposing this directory)",
    );
    expect(await fail("get", "volume", "missing")).toContain("Volume missing does not exist");
  });

  it("refuses an invalid source or a secret value as the credential, storing nothing", async () => {
    const unsupported = await write(
      "unsupported.yaml",
      `${header("Volume", "data")}spec:\n  source: azure://acme/x\n`,
    );
    expect(await fail("apply", "-f", unsupported)).toContain(
      "must start with s3://, r2://, gs://, modal-volume://, or file://",
    );
    const secret = await write(
      "secret.yaml",
      `${header("Volume", "data")}spec:\n  source: s3://acme-data\n  credential: AKIAIOSFODNN7EXAMPLE\n`,
    );
    expect(await fail("apply", "-f", secret)).toContain("never a secret value");
    const listed = await client.request<{ items: unknown[] }>("/api/v1/volumes");
    expect(listed.items).toEqual([]);
  });

  it("applies and describes native sources without pretending they are S3 stores", async () => {
    const manifest = await write(
      "native.yaml",
      `${header("Volume", "gcs")}spec:
  source: gs://datasets/train/
  credential: datasets
---
${header("Volume", "modal")}spec:
  source: modal-volume://training/models/
  credential: team-data
`,
    );
    await run("apply", "-f", manifest);
    expect(await run("describe", "volume", "gcs")).toContain("native mounts only");
    const description = await run("describe", "volume", "modal");
    expect(description).toContain("Modal environment: Worker Host configuration");
    expect(description).toContain(
      "Credential: team-data (a name; each Worker Host maps it to exact-name modal-volume consent)",
    );
    const resource = await client.request<{ spec: unknown }>("/api/v1/volumes/modal");
    expect(resource.spec).toEqual({
      source: "modal-volume://training/models/",
      credential: "team-data",
    });
  });

  it("prunes a Volume its apply set no longer declares, without a delete command", async () => {
    await run("apply", "-f", await write("set.yaml", organization), "--set", "data");
    expect(await run("delete", "volume", "shared", "--dry-run")).toContain("Nothing was changed.");
    const withoutShared = await write(
      "next.yaml",
      organization.slice(0, organization.lastIndexOf("---")),
    );
    expect(await run("apply", "-f", withoutShared, "--set", "data", "--prune")).toContain(
      "Volume/shared deleted\n",
    );
    const listed = await client.request<{ items: { metadata: { name: string } }[] }>(
      "/api/v1/volumes",
    );
    expect(listed.items.map((item) => item.metadata.name)).toEqual(["datasets"]);
  });
});
