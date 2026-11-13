import { describe, expect, it } from "vitest";
import {
  CONTAINER_KEYS,
  CONTROL_PLANE_COMMAND,
  containerCommand,
  containerEnvironment,
  forwardable,
  PAIR_COMMAND,
} from "../deploy/cloudflare/src/routing.ts";

/** The Worker in front of the SuperTag container: it forwards only tunnels and the health check. */
describe("Cloudflare tunnel Worker", () => {
  it("forwards a WebSocket upgrade unchanged, Origin included, on any path", () => {
    const request = new Request("https://supertag.example.workers.dev/any/path", {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Origin: "https://evil.example",
      },
    });
    const forwarded = forwardable(request);
    expect(forwarded).toBeInstanceOf(Request);
    const out = forwarded as Request;
    expect(out.url).toBe(request.url);
    // The container refuses browsers; the Worker makes no authentication decision.
    expect(out.headers.get("Origin")).toBe("https://evil.example");
    expect(out.headers.get("Sec-WebSocket-Key")).toBe("dGhlIHNhbXBsZSBub25jZQ==");
  });

  it("removes a client's container port selection", () => {
    const forwarded = forwardable(
      new Request("https://supertag.example.workers.dev/", {
        headers: { Upgrade: "websocket", "cf-container-target-port": "3434" },
      }),
    ) as Request;
    expect(forwarded.headers.has("cf-container-target-port")).toBe(false);
  });

  it("forwards the plain health check and refuses everything else", async () => {
    expect(forwardable(new Request("https://supertag.example.workers.dev/healthz"))).toBeInstanceOf(
      Request,
    );
    for (const request of [
      new Request("https://supertag.example.workers.dev/"),
      new Request("https://supertag.example.workers.dev/healthz", { method: "POST", body: "" }),
      new Request("https://supertag.example.workers.dev/supertag.runtime.v2.Operator/ListHosts", {
        method: "POST",
        headers: { "Content-Type": "application/grpc" },
        body: "",
      }),
    ]) {
      const response = forwardable(request);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(426);
    }
  });

  it("passes only deployment settings and TLS PEM values into the container", () => {
    const environment = containerEnvironment({
      SUPERTAG_DATABASE_URL: "postgresql://user:secret@db.example.com/supertag",
      SUPERTAG_TLS_CERT_PEM: "-----BEGIN CERTIFICATE-----",
      SUPERTAG_GATEWAY: "on",
      SUPERTAG: { binding: true },
      CLOUDFLARE_API_TOKEN: "not-for-the-container",
      VAULT_TOKEN: "",
    });
    expect(environment).toEqual({
      SUPERTAG_DATABASE_URL: "postgresql://user:secret@db.example.com/supertag",
      SUPERTAG_TLS_CERT_PEM: "-----BEGIN CERTIFICATE-----",
    });
    expect(CONTAINER_KEYS).not.toContain("SUPERTAG_TLS_CERT_FILE");
  });

  it("runs the Control Plane alone unless SUPERTAG_GATEWAY is on", () => {
    expect(containerCommand({})).toEqual(CONTROL_PLANE_COMMAND);
    expect(containerCommand({ SUPERTAG_GATEWAY: "off" })).toEqual(CONTROL_PLANE_COMMAND);
    expect(containerCommand({ SUPERTAG_GATEWAY: "on" })).toEqual(PAIR_COMMAND);
    expect(() => containerCommand({ SUPERTAG_GATEWAY: "yes" })).toThrow(/on or off/u);
    expect(CONTROL_PLANE_COMMAND).toContain("--websocket-listen");
    expect(CONTROL_PLANE_COMMAND[CONTROL_PLANE_COMMAND.indexOf("--listen") + 1]).toBe(
      "127.0.0.1:3434",
    );
  });
});
