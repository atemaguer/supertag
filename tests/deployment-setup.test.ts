import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runDeploymentCommand,
  serializeDeploymentEnvironment,
  verifyDeployment,
} from "../apps/cli/src/deploy.ts";
import {
  DEPLOYMENT_ENVIRONMENT_KEYS,
  DEPLOYMENT_PLATFORMS,
  resolveDeploymentEnvironment,
} from "../deploy/shared/src/index.ts";

const common = {
  SUPERTAG_DATABASE_URL: "postgresql://test:private-password@database.example.com/supertag",
  SUPERTAG_ADMIN_TOKEN: "private-admin-token",
  SUPERTAG_COORDINATION_URL: "https://supertag.example.com",
};
const external = {
  SUPERTAG_CREDENTIAL_VAULT: "vault",
  VAULT_ADDR: "https://vault.example.com",
  VAULT_TOKEN: "private-vault-token",
};
afterEach(() => vi.unstubAllEnvs());

describe("shared deployment configuration", () => {
  it.each(DEPLOYMENT_PLATFORMS)(
    "preserves an optional verified operator destination on %s",
    (platform) => {
      const env = resolveDeploymentEnvironment(platform, {
        ...common,
        ...(platform === "cloudflare" || platform === "modal" ? external : {}),
        SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID: "  surface-task-123  ",
        SUPERTAG_OPERATOR_CHANNEL: " slack:C0OPS ",
      });
      expect(env.SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID).toBe("surface-task-123");
      expect(env.SUPERTAG_OPERATOR_CHANNEL).toBe("slack:C0OPS");
      expect(serializeDeploymentEnvironment(env)).toContain(
        "SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID",
      );
    },
  );

  it("requires supported ingress and mounted TLS files for gRPC", () => {
    const grpc = {
      ...common,
      SUPERTAG_DEPLOYMENT_RPC_TRANSPORT: "grpc",
      SUPERTAG_WORKLET_GRPC_PORT: "3435",
      SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE: "/var/lib/supertag/tls/fullchain.pem",
      SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE: "/var/lib/supertag/tls/privkey.pem",
    };
    expect(resolveDeploymentEnvironment("fly", grpc)).toMatchObject(grpc);
    for (const platform of ["railway", "render", "cloudflare", "modal"] as const)
      expect(() => resolveDeploymentEnvironment(platform, { ...external, ...grpc })).toThrow(
        "template requires WebSocket",
      );
    for (const changes of [
      { SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE: "relative.pem" },
      { SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE: "" },
      { SUPERTAG_WORKLET_GRPC_PORT: "3434" },
      { SUPERTAG_DEPLOYMENT_RPC_TRANSPORT: "websocket" },
    ])
      expect(() => resolveDeploymentEnvironment("fly", { ...grpc, ...changes })).toThrow();
  });
  it("generates isolated TLS passthrough ingress without changing HTTP management", async () => {
    const manifest = await readFile(
      new URL("../deploy/fly/fly.grpc.toml", import.meta.url),
      "utf8",
    );
    expect(manifest).toContain('SUPERTAG_DEPLOYMENT_RPC_TRANSPORT = "grpc"');
    expect(manifest).toContain("internal_port = 3434");
    expect(manifest).toContain("internal_port = 3435");
    expect(manifest).toContain("port = 8443");
    expect(manifest).toContain("handlers = []");
    expect(manifest).not.toContain('handlers = ["tls"]');
  });

  it.each(DEPLOYMENT_PLATFORMS)("validates %s against the same runtime contract", (platform) => {
    const env = resolveDeploymentEnvironment(platform, {
      ...common,
      ...(platform === "cloudflare" || platform === "modal" ? external : {}),
    });
    expect(env).toMatchObject({
      ...common,
      SUPERTAG_DEPLOYMENT_PLATFORM: platform,
      SUPERTAG_WORKLET_TRANSPORT: "remote",
      SUPERTAG_STATE_DIR: "/var/lib/supertag",
    });
  });
  it.each(["railway", "render", "fly"] as const)(
    "allows durable external storage on %s",
    (platform) => {
      expect(
        resolveDeploymentEnvironment(platform, { ...common, ...external })
          .SUPERTAG_CREDENTIAL_VAULT,
      ).toBe("vault");
    },
  );
  it("rejects incompatible hosts, local databases, local state and mismatched platforms", () => {
    for (const changes of [
      { SUPERTAG_DATABASE_URL: "file:/tmp/db" },
      { SUPERTAG_WORKLET_TRANSPORT: "embedded" },
      { SUPERTAG_STATE_DIR: "/tmp" },
      { SUPERTAG_DEPLOYMENT_PLATFORM: "render" },
      { SUPERTAG_COORDINATION_URL: "https://example.com/path" },
    ])
      expect(() => resolveDeploymentEnvironment("railway", { ...common, ...changes })).toThrow();
    expect(() =>
      resolveDeploymentEnvironment("cloudflare", {
        ...common,
        ...external,
        SUPERTAG_CREDENTIAL_VAULT: "file",
      }),
    ).toThrow("requires SUPERTAG_CREDENTIAL_VAULT=vault");
  });
  it("redacts malformed values from validation errors", () => {
    expect(() =>
      resolveDeploymentEnvironment("railway", {
        ...common,
        SUPERTAG_DATABASE_URL: "private-secret",
      }),
    ).toThrow(/^SUPERTAG_DATABASE_URL must be a valid URL$/);
  });
  it.each(["cloudflare", "modal"] as const)(
    "requires durable external credentials on %s",
    (platform) => {
      expect(() => resolveDeploymentEnvironment(platform, common)).toThrow("Missing VAULT_ADDR");
      expect(() =>
        resolveDeploymentEnvironment(platform, {
          ...common,
          ...external,
          SUPERTAG_CREDENTIAL_VAULT: "file",
        }),
      ).toThrow("requires SUPERTAG_CREDENTIAL_VAULT=vault");
      for (const key of ["VAULT_ADDR", "VAULT_TOKEN"]) {
        expect(() =>
          resolveDeploymentEnvironment(platform, { ...common, ...external, [key]: undefined }),
        ).toThrow(`Missing ${key}`);
      }
    },
  );
});

describe("deployment setup and verification", () => {
  it.each(DEPLOYMENT_PLATFORMS)(
    "writes private %s configuration and refuses overwrites",
    async (platform) => {
      const directory = await mkdtemp(join(tmpdir(), "deployment-setup-"));
      const output = join(directory, ".env.deployment");
      for (const key of DEPLOYMENT_ENVIRONMENT_KEYS) vi.stubEnv(key, undefined);
      for (const [key, value] of Object.entries({
        ...common,
        ...(platform === "modal" || platform === "cloudflare" ? external : {}),
      }))
        vi.stubEnv(key, value);
      vi.stubEnv("UNRELATED_SECRET", "never-export");
      try {
        const args = ["setup", "--platform", platform, "--output", output, "--non-interactive"];
        const message = await runDeploymentCommand(args);
        expect(message).not.toContain(common.SUPERTAG_ADMIN_TOKEN);
        const content = await readFile(output, "utf8");
        expect(parseEnv(content)).toMatchObject(common);
        expect(content).not.toContain("never-export");
        expect((await stat(output)).mode & 0o777).toBe(0o600);
        await expect(
          runDeploymentCommand(["check", "--platform", platform, "--env-file", output]),
        ).resolves.toContain("is valid");
        await expect(runDeploymentCommand(args)).rejects.toThrow("EEXIST");
        expect(await readFile(output, "utf8")).toBe(content);
        await writeFile(output, "UNKNOWN_KEY='secret'\n");
        await expect(
          runDeploymentCommand(["check", "--platform", platform, "--env-file", output]),
        ).rejects.toThrow("Unknown deployment environment key: UNKNOWN_KEY");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("round-trips quotes and shell metacharacters without evaluating them", () => {
    const env = { ONE: "a'b$HOME`cmd`", TWO: 'a"b\\c', THREE: "#comment=not-a-comment" };
    expect(parseEnv(serializeDeploymentEnvironment(env))).toEqual(env);
    expect(() => serializeDeploymentEnvironment({ TOKEN: "injected\nBAD=1" })).toThrow(
      "TOKEN cannot be represented",
    );
  });

  it("checks health, anonymous rejection, authenticated management and optional readiness", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/healthz") return Response.json({ ok: true });
      if (path === "/readyz") return Response.json({ ok: false }, { status: 503 });
      expect(path).toBe("/supertag.operator.v1.OrganizationService/GetStatus");
      return new Headers(init?.headers).has("authorization")
        ? Response.json({ phase: "CONTROL_PLANE_PHASE_ACCEPTING" })
        : Response.json({ code: "unauthenticated", message: "token required" }, { status: 401 });
    });
    await expect(
      verifyDeployment(
        common.SUPERTAG_COORDINATION_URL,
        common.SUPERTAG_ADMIN_TOKEN,
        false,
        request,
      ),
    ).resolves.toContain("not ready");
    await expect(
      verifyDeployment(
        common.SUPERTAG_COORDINATION_URL,
        common.SUPERTAG_ADMIN_TOKEN,
        true,
        request,
      ),
    ).rejects.toThrow("readiness check failed");
    expect(request.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
    const openApi = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    await expect(
      verifyDeployment(common.SUPERTAG_COORDINATION_URL, "token", false, openApi),
    ).rejects.toThrow("did not reject an anonymous request");
  });
});
