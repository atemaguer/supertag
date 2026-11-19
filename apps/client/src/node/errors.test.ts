import { createServer, type Server, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { codeOf, rpcError, statusOf } from "./errors";
import { Code, ConnectError, createGatewayClient } from "./sdk";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

/** A listener on a free loopback port that `accept` handles; resolves to its port. */
async function listen(accept: (socket: Socket) => void): Promise<number> {
  const server = createServer(accept);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

/** How negotiating with `url` fails. */
async function negotiationFailure(url: string): Promise<unknown> {
  const client = createGatewayClient({ url, token: "test-token", buildVersion: "test" });
  try {
    await client.negotiate();
  } catch (error) {
    return error;
  } finally {
    client.close();
  }
  throw new Error("negotiated with a Gateway that is not there");
}

const reset = (message: string) =>
  Object.assign(new Error(message), { code: "ECONNRESET", errno: -54, syscall: "read" });

it("counts a reset connection as Unavailable, and other aborts as they are", () => {
  // As connect-node reports a socket the server reset: Aborted, with the Node.js error as cause.
  const aborted = new ConnectError(
    "read ECONNRESET",
    Code.Aborted,
    undefined,
    undefined,
    reset("read ECONNRESET"),
  );
  expect(codeOf(aborted)).toBe(Code.Unavailable);
  expect(statusOf(aborted)).toEqual({ code: Code.Unavailable, message: "read ECONNRESET" });
  expect(rpcError(aborted)).toBe("The Gateway is unavailable. Try again once it is running.");
  // A reset further down the chain counts too.
  const wrapped = new Error("stream failed", { cause: reset("read ECONNRESET") });
  expect(
    codeOf(new ConnectError("stream failed", Code.Aborted, undefined, undefined, wrapped)),
  ).toBe(Code.Unavailable);
  // An abort without a reset, and a reset reported under another code, keep their code.
  expect(codeOf(new ConnectError("cancelled", Code.Aborted))).toBe(Code.Aborted);
  expect(
    codeOf(new ConnectError("read ECONNRESET", Code.Internal, undefined, undefined, reset("x"))),
  ).toBe(Code.Internal);
  expect(rpcError(new ConnectError("cancelled", Code.Aborted))).toBe("The Gateway request failed.");
});

it("reports a Gateway that resets the connection as Unavailable, as one that refuses it", async () => {
  const resetting = await listen((socket) => socket.resetAndDestroy());
  const resetFailure = await negotiationFailure(`http://127.0.0.1:${resetting}`);
  // connect-node calls it Aborted; once it says Unavailable itself, `codeOf` has nothing to do.
  expect(ConnectError.from(resetFailure).code).toBe(Code.Aborted);
  expect(codeOf(resetFailure)).toBe(Code.Unavailable);

  const closed = await listen(() => {});
  const refusing = servers.pop() as Server;
  await new Promise<void>((done) => refusing.close(() => done()));
  const refused = await negotiationFailure(`http://127.0.0.1:${closed}`);
  expect(codeOf(refused)).toBe(Code.Unavailable);
});
