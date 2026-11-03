import { Agent, get } from "node:https";
import { connect } from "node:tls";
import { expect, it } from "vitest";
import { FakeS3 } from "./support/fake-s3.ts";

it("scopes fixture trust to active HTTPS endpoints and restores agents after closing", async () => {
  const original = Agent.prototype.createConnection;
  const first = await FakeS3.start();
  const second = await FakeS3.start();
  const request = (endpoint: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      get(endpoint, { agent: new Agent() }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
  try {
    expect(await request(first.endpoint)).toBe(403);
    await first.close();
    expect(await request(second.endpoint)).toBe(403);
    // Direct TLS has no fixture CA: verification must still reject the certificate.
    const error = await new Promise<Error>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: Number(new URL(second.endpoint).port) });
      socket.once("error", resolve);
      socket.once("secureConnect", () => {
        socket.destroy();
        reject(new Error("Fixture CA leaked into default TLS trust"));
      });
    });
    expect(error.message).toMatch(/certificate/i);
  } finally {
    await first.close();
    await second.close();
  }
  expect(Agent.prototype.createConnection).toBe(original);
});
