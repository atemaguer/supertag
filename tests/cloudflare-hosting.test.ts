import { describe, expect, it, vi } from "vitest";
import { containerEnvironment } from "../deploy/cloudflare/src/config.ts";
import { maintainContainer, routeRequest } from "../deploy/cloudflare/src/routing.ts";

const config = {
  SUPERTAG_DATABASE_URL:
    "postgresql://user:secret@database.example.com/supertag?sslmode=verify-full",
  SUPERTAG_ADMIN_TOKEN: "admin-secret",
  SUPERTAG_COORDINATION_URL: "https://supertag.example.com",
  VAULT_ADDR: "https://vault.example.com",
  VAULT_TOKEN: "vault-secret",
};

describe("Cloudflare request routing and lifecycle", () => {
  function fixture(maintenance = "false") {
    const container = {
      fetch: vi.fn(async (_request: Request) => new Response("healthy")),
      stop: vi.fn(async () => {}),
    };
    const env = {
      SUPERTAG_MAINTENANCE: maintenance,
      CONTROL_PLANE: { getByName: vi.fn(() => container) },
    };
    return { container, env };
  }

  it("forwards API, webhook, artifact catalog and WebSocket requests intact to one instance", async () => {
    const { container, env } = fixture();
    for (const path of [
      "/api/v1/tags",
      "/webhooks/github",
      "/internal/v1/artifacts/catalog/upload",
      "/worklets",
    ]) {
      const request = new Request(`https://supertag.example.com${path}?cursor=123`, {
        headers: { authorization: "Bearer host-token", upgrade: "websocket" },
      });
      await routeRequest(request, env);
      expect(container.fetch).toHaveBeenLastCalledWith(request);
      expect(env.CONTROL_PLANE.getByName).toHaveBeenLastCalledWith("control-plane");
    }
    const post = new Request("https://supertag.example.com/api/v1/tags", {
      method: "POST",
      body: "payload",
    });
    await routeRequest(post, env);
    expect(container.fetch).toHaveBeenLastCalledWith(post);
    expect(await post.text()).toBe("payload");
  });

  it("checks liveness and surfaces failures to Cron monitoring", async () => {
    const { container, env } = fixture();
    await maintainContainer(env);
    expect(container.fetch.mock.calls[0][0].url).toBe("http://localhost/healthz");
    container.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(maintainContainer(env)).rejects.toThrow("health check failed (503)");
  });

  it("blocks ingress and stops the instance during maintenance without waking it", async () => {
    const { container, env } = fixture("true");
    expect(
      (await routeRequest(new Request("https://supertag.example.com/healthz"), env)).status,
    ).toBe(503);
    expect(env.CONTROL_PLANE.getByName).not.toHaveBeenCalled();
    await maintainContainer(env);
    expect(container.stop).toHaveBeenCalledOnce();
    expect(container.fetch).not.toHaveBeenCalled();
  });
});

describe("Cloudflare hosting storage boundaries", () => {
  it("requires remote state and forwards only explicitly selected configuration", () => {
    const env = containerEnvironment({
      ...config,
      UNRELATED_SECRET: "excluded",
      SUPERTAG_ARTIFACT_BUCKET: "removed-setting",
      CONTROL_PLANE: {},
    });
    expect(env).toMatchObject({
      ...config,
      SUPERTAG_CREDENTIAL_VAULT: "vault",
      SUPERTAG_WORKLET_TRANSPORT: "remote",
    });
    expect(env).not.toHaveProperty("UNRELATED_SECRET");
    expect(env).not.toHaveProperty("SUPERTAG_ARTIFACT_BUCKET");
    expect(env).not.toHaveProperty("CONTROL_PLANE");
  });

  it.each(Object.keys(config))("refuses to start without %s", (key) => {
    expect(() => containerEnvironment({ ...config, [key]: "" })).toThrow(`Missing ${key}`);
  });

  it("rejects local SQLite and insecure remote services", () => {
    expect(() =>
      containerEnvironment({ ...config, SUPERTAG_DATABASE_URL: "file:/tmp/db" }),
    ).toThrow("require PostgreSQL");
    for (const key of ["VAULT_ADDR", "SUPERTAG_COORDINATION_URL"]) {
      expect(() => containerEnvironment({ ...config, [key]: "http://example.com" })).toThrow(
        "must be an HTTPS URL",
      );
    }
  });

  it("does not include malformed database credentials in errors", () => {
    expect(() =>
      containerEnvironment({ ...config, SUPERTAG_DATABASE_URL: "private-secret" }),
    ).toThrow(/^SUPERTAG_DATABASE_URL must be a valid URL$/);
  });
});
