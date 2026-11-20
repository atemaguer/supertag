import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttp2Server } from "node:http2";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createTlsServer } from "node:tls";
import { promisify } from "node:util";
import {
  Code,
  ConnectError,
  createGatewayClient,
  PROTOCOL_VERSIONS,
  PrincipalRole,
  ProtocolMismatchError,
} from "supertag-ai/gateway-client";
import { openHarness, TaskState } from "supertag-ai/harness";

const token = "fixture-operator-token";
const hostToken = `stcr_${"0123456789abcdef".repeat(4)}`;
const gatewayCredential = `stcr_${"fedcba9876543210".repeat(4)}`;
const execute = promisify(execFile);
const loopback = "http://127.0.0.1:3434";
for (const url of [
  "https://user:pass@gateway.invalid",
  "https://gateway.invalid/path",
  `${loopback}\n`,
]) {
  assert.throws(() => createGatewayClient({ url, token }), /origin/);
}
assert.throws(() => createGatewayClient({ url: "http://gateway.invalid", token }), /loopback/);
assert.throws(() => createGatewayClient({ url: loopback, token: `${token}\n` }), /operator token/);
const closed = createGatewayClient({ url: loopback, token });
assert.equal(typeof closed.operator.listTags, "function");
assert.equal(typeof closed.events.watch, "function");
closed.close();
await assert.rejects(async () => closed.operator.listTags({}), /closed/);
await assert.rejects(openHarness((async function* () {})()), /bootstrap/);
console.log("Gateway client public package import passed.");

// Tunnel URLs, token and build rules, and connect timeouts, without a Gateway.
for (const url of ["ws://127.0.0.1:9/supertag", "wss://gateway.invalid/a/b", "wss://[::1]:9"]) {
  createGatewayClient({ url, token }).close();
}
for (const url of [
  "ws://user@127.0.0.1:9/tunnel",
  "wss://gateway.invalid/tunnel?query",
  "wss://gateway.invalid/tunnel#fragment",
  "ftp://gateway.invalid",
]) {
  assert.throws(() => createGatewayClient({ url, token }), /origin/);
}
assert.throws(() => createGatewayClient({ url: "ws://gateway.invalid/t", token }), /loopback/);
assert.throws(() => createGatewayClient({ url: "ws://127.0.0.1:0/t", token }), /valid port/);
assert.throws(
  () => createGatewayClient({ url: "ws://127.0.0.1:9", token, ca: "pem" }),
  /require HTTPS or WSS/,
);
// The Rust clients' bearer rule: 1 to 8192 ASCII graphic characters.
for (const accepted of ["x".repeat(8192), `stak_${"ab".repeat(32)}`, "a:b;c,d=e!"]) {
  createGatewayClient({ url: loopback, token: accepted }).close();
}
for (const refused of ["", "x".repeat(8193), "two words", "töken", "tab\t"]) {
  assert.throws(() => createGatewayClient({ url: loopback, token: refused }), /operator token/);
}
assert.throws(
  () => createGatewayClient({ url: loopback, token, buildVersion: "x".repeat(65) }),
  /Build version/,
);
assert.deepEqual([...PROTOCOL_VERSIONS], [7]);
assert.ok(Object.isFrozen(PROTOCOL_VERSIONS));

/** A loopback server that accepts connections and never answers them. */
async function silentServer() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
const silent = await silentServer();
try {
  for (const url of [
    `https://127.0.0.1:${silent.port}`,
    `ws://127.0.0.1:${silent.port}/tunnel`,
    `wss://127.0.0.1:${silent.port}/tunnel`,
  ]) {
    const started = Date.now();
    const client = createGatewayClient({ url, token, connectTimeoutMs: 300 });
    try {
      await assert.rejects(client.negotiate(), { code: Code.Unavailable });
    } finally {
      client.close();
    }
    assert.ok(Date.now() - started < 4000, `${url} waited past its connect timeout`);
  }
} finally {
  silent.close();
}

/**
 * A cleartext HTTP/2 server that answers protocol negotiation as another SuperTag release:
 * `answer` is a NegotiateProtocolResponse, or a refusal message.
 */
async function negotiationServer(answer) {
  const server = createHttp2Server();
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", () => {
      if (typeof answer === "string") {
        stream.respond(
          {
            ":status": 200,
            "content-type": "application/grpc",
            "grpc-status": String(Code.FailedPrecondition),
            "grpc-message": encodeURIComponent(answer),
          },
          { endStream: true },
        );
        return;
      }
      const build = Buffer.from(answer.build);
      const message = Buffer.from([
        0x08,
        2, // role: Gateway
        0x10,
        answer.version,
        0x1a,
        answer.versions.length,
        ...answer.versions,
        0x22,
        build.length,
        ...build,
      ]);
      const frame = Buffer.alloc(5);
      frame.writeUInt32BE(message.length, 1);
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.concat([frame, message]));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
for (const [answer, expected] of [
  [
    { version: 2, versions: [2], build: "0.3.1" },
    {
      peerBuild: "0.3.1",
      peerVersions: [2],
      text: "runs SuperTag 0.3.1 (protocol 2). Upgrade the Gateway.",
    },
  ],
  [
    "incompatible SuperTag protocol: this Gateway (SuperTag 9.0.0) speaks protocol versions [9, 10], but the connecting operator client (SuperTag supertag-ai) offered [7]; upgrade the connecting operator client",
    {
      peerBuild: "9.0.0",
      peerVersions: [9, 10],
      text: "runs SuperTag 9.0.0 (protocols 9, 10). Upgrade this client.",
    },
  ],
  [
    "incompatible SuperTag protocol: no\u0007pe.",
    {
      peerBuild: undefined,
      peerVersions: undefined,
      text: "refused it: incompatible SuperTag protocol: nope.",
    },
  ],
]) {
  const fake = await negotiationServer(answer);
  const client = createGatewayClient({ url: fake.url, token, buildVersion: "0.4.0" });
  try {
    const error = await client.negotiate().then(
      () => assert.fail("a Gateway from another release was accepted"),
      (error) => error,
    );
    assert.ok(error instanceof ProtocolMismatchError, String(error));
    assert.ok(error instanceof ConnectError);
    assert.equal(error.code, Code.FailedPrecondition);
    assert.equal(error.peerBuild, expected.peerBuild);
    assert.deepEqual(error.peerVersions && [...error.peerVersions], expected.peerVersions);
    assert.deepEqual([...error.ourVersions], [7]);
    assert.equal(error.endpoint, fake.url);
    assert.ok(
      error.rawMessage.startsWith(
        `This client speaks SuperTag protocol 7, but the Gateway at ${fake.url} `,
      ),
      error.rawMessage,
    );
    assert.ok(error.rawMessage.includes(expected.text), error.rawMessage);
    // Calls report the same mismatch, before sending any credential.
    await assert.rejects(client.operator.listTags({}), ProtocolMismatchError);
  } finally {
    client.close();
    fake.close();
  }
}
console.log("Gateway client URL, token, connect timeout, and protocol mismatch checks passed.");

/**
 * A WebSocket listener that accepts the upgrade and then ends the tunnel as `ending` says: with a
 * close frame, or by dropping the connection once the client writes.
 */
async function endingTunnel(ending) {
  const server = createServer((socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (upgraded) {
        if (ending === "drop") socket.destroy();
        return;
      }
      head = Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      if (!text.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key: *(\S+)/iu.exec(text)?.[1] ?? "";
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      upgraded = true;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      if (ending === "close") socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `ws://127.0.0.1:${server.address().port}/t`, close: () => server.close() };
}
for (const ending of ["close", "drop"]) {
  const tunnel = await endingTunnel(ending);
  const client = createGatewayClient({ url: tunnel.url, token });
  try {
    await assert.rejects(client.negotiate(), {
      code: Code.Unavailable,
      rawMessage: /WebSocket tunnel/u,
    });
  } finally {
    client.close();
    tunnel.close();
  }
}
console.log("A tunnel the Gateway closes or drops fails its calls as Unavailable.");

/** A private certificate authority and a certificate it issued for 127.0.0.1, or none. */
async function privateCertificates(directory) {
  const openssl = (args) => execute("openssl", args, { cwd: directory, timeout: 30_000 });
  try {
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-subj",
      "/CN=SuperTag SDK test CA",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ]);
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=127.0.0.1",
    ]);
    await writeFile(
      join(directory, "server.ext"),
      "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
    );
    await openssl([
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.pem",
      "-days",
      "2",
      "-extfile",
      "server.ext",
    ]);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return {
    ca: await readFile(join(directory, "ca.pem")),
    cert: join(directory, "server.pem"),
    key: join(directory, "server.key"),
  };
}

/**
 * A platform-style edge: it terminates the outer `wss://` TLS and forwards the plain WebSocket
 * connection, so the Gateway's own TLS runs inside the tunnel.
 */
async function tlsEdge(certificates, target) {
  const server = createTlsServer(
    {
      cert: await readFile(certificates.cert),
      key: await readFile(certificates.key),
      ALPNProtocols: ["http/1.1"],
    },
    (socket) => {
      const upstream = tcpConnect({ host: "127.0.0.1", port: target });
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

/** Every service the SDK added for the desktop app, through `client`. */
async function verifyServices(client, taskId) {
  const options = { timeoutMs: 10_000 };
  const me = await client.enrollments.whoAmI({}, options);
  assert.equal(me.role, PrincipalRole.OPERATOR);
  assert.match(me.principal, /^operator:/u);
  assert.ok(Array.isArray((await client.networkLogs.list({ tagId: "node-sdk" }, options)).logs));
  const located = await client.taskFiles.locate({ taskId, machineId: "" }, options);
  assert.ok(Array.isArray(located.locations));
  const scheduleId = `sdk-${randomBytes(4).toString("hex")}`;
  const schedule = await client.schedules.put(
    { scheduleId, tagId: "node-sdk", note: "Summarize the week.", every: "@weekly" },
    options,
  );
  assert.equal(schedule.scheduleId, scheduleId);
  const listed = await client.schedules.list({ tagId: "node-sdk" }, options);
  assert.ok(listed.schedules.some((entry) => entry.scheduleId === scheduleId));
  const paused = await client.schedules.pause({ scheduleId }, options);
  assert.notEqual(paused.state, schedule.state);
  await client.schedules.delete({ scheduleId }, options);
}

async function verifyTunnels(
  binary,
  root,
  start,
  children,
  controlPlane,
  nativeUrl,
  tunnelAddress,
  taskId,
) {
  const tunnelUrl = `ws://${tunnelAddress}/supertag/tunnel`;
  const tunnel = createGatewayClient({ url: tunnelUrl, token });
  try {
    assert.deepEqual(await tunnel.negotiate(), 7);
    const watch = tunnel.events.watch({}, { timeoutMs: 10_000 })[Symbol.asyncIterator]();
    assert.equal((await watch.next()).value.update.case, "heartbeat");
    await watch.return?.();
    // Larger than one WebSocket message both ways. A request split into 256 KiB messages
    // reaches the Control Plane whole, which refuses instructions this long.
    await assert.rejects(
      tunnel.operator.putTag(
        { tagId: "tunnel-sdk", instructions: "x".repeat(600 * 1024) },
        { timeoutMs: 10_000 },
      ),
      { code: Code.InvalidArgument, rawMessage: /instructions exceeds its size limit/u },
    );
    // A reply of several messages arrives whole.
    const instructions = "Write release notes. ".repeat(3_000);
    for (let index = 0; index < 6; index++) {
      await tunnel.operator.putTag(
        { tagId: `tunnel-sdk-${index}`, instructions },
        { timeoutMs: 10_000 },
      );
    }
    const { tags } = await tunnel.operator.listTags({ limit: 100 }, { timeoutMs: 10_000 });
    const large = tags.filter((entry) => entry.tagId.startsWith("tunnel-sdk-"));
    assert.equal(large.length, 6);
    assert.ok(large.every((entry) => entry.instructions === instructions));
    await verifyServices(tunnel, taskId);
  } finally {
    tunnel.close();
  }
  // The native listener is not a tunnel: the upgrade is refused, not retried as cleartext.
  const mismatched = createGatewayClient({ url: `ws://${new URL(nativeUrl).host}/t`, token });
  try {
    await assert.rejects(mismatched.negotiate(), { code: Code.Unavailable });
  } finally {
    mismatched.close();
  }

  // A client Auth Key enrolls this device through the tunnel; the credential it chose works.
  const { stdout } = await execute(
    binary,
    [
      "auth-key",
      "create",
      "--role",
      "client",
      "--tag",
      "node-sdk",
      "--gateway",
      nativeUrl,
      "sdk-device",
    ],
    {
      env: { SUPERTAG_OPERATOR_TOKEN: token, HOME: root, PATH: "/usr/bin:/bin" },
      timeout: 30_000,
    },
  );
  const key = JSON.parse(stdout).auth_key;
  assert.match(key, /^stak_/u);
  const credential = `stcr_${randomBytes(32).toString("hex")}`;
  const enrolling = createGatewayClient({ url: tunnelUrl, token: key });
  try {
    const enrollment = await enrolling.enrollments.enroll(
      {
        role: PrincipalRole.CLIENT,
        name: "sdk-device",
        operationId: randomBytes(16).toString("hex"),
        tokenDigest: createHash("sha256").update(credential).digest(),
      },
      { timeoutMs: 10_000 },
    );
    assert.equal(enrollment.principal, "client:sdk-device");
  } finally {
    enrolling.close();
  }
  const enrolled = createGatewayClient({ url: tunnelUrl, token: credential });
  try {
    const me = await enrolled.enrollments.whoAmI({}, { timeoutMs: 10_000 });
    assert.equal(me.principal, "client:sdk-device");
  } finally {
    enrolled.close();
  }
  console.log("ws:// tunnel, Auth Key enrollment, and every added service passed.");

  // A Gateway that stops mid-stream fails the stream through its tunnel as Unavailable.
  const [, stoppingTunnel] = await start(
    [
      "gateway",
      "--control-plane",
      controlPlane,
      "--listen",
      "127.0.0.1:0",
      "--websocket-listen",
      "127.0.0.1:0",
    ],
    { SUPERTAG_GATEWAY_CREDENTIAL: gatewayCredential },
    2,
  );
  const stopping = createGatewayClient({ url: `ws://${stoppingTunnel}/t`, token });
  try {
    const watch = stopping.events.watch({}, { timeoutMs: 30_000 })[Symbol.asyncIterator]();
    assert.equal((await watch.next()).value.update.case, "heartbeat");
    children.at(-1).kill("SIGKILL");
    await assert.rejects(
      (async () => {
        while (!(await watch.next()).done) {}
      })(),
      { code: Code.Unavailable },
    );
  } finally {
    stopping.close();
  }
  console.log("A stream through a tunnel whose Gateway stopped failed as Unavailable.");

  const certificates = await privateCertificates(await mkdtemp(join(root, "tls-")));
  if (certificates === undefined) {
    console.log("Skipped the wss:// tunnel: openssl is not installed.");
    return;
  }
  // A second Gateway serving TLS, natively and inside its tunnel, behind a TLS edge.
  const [secureNative, secureTunnel] = await start(
    [
      "gateway",
      "--control-plane",
      controlPlane,
      "--listen",
      "127.0.0.1:0",
      "--websocket-listen",
      "127.0.0.1:0",
    ],
    {
      SUPERTAG_GATEWAY_CREDENTIAL: gatewayCredential,
      SUPERTAG_TLS_CERT_FILE: certificates.cert,
      SUPERTAG_TLS_KEY_FILE: certificates.key,
    },
    2,
  );
  const edge = await tlsEdge(certificates, Number(secureTunnel.split(":")[1]));
  try {
    for (const url of [
      `https://${secureNative}`,
      `wss://127.0.0.1:${edge.address().port}/edge/supertag`,
    ]) {
      // Without the private authority, neither the native TLS nor the tunnel's is trusted.
      const untrusted = createGatewayClient({ url, token });
      try {
        await assert.rejects(untrusted.negotiate(), { rawMessage: /certificate/u });
      } finally {
        untrusted.close();
      }
      const secure = createGatewayClient({ url, token, ca: certificates.ca });
      try {
        assert.equal(await secure.negotiate(), 7);
        await verifyServices(secure, taskId);
      } finally {
        secure.close();
      }
    }
  } finally {
    edge.close();
  }
  console.log("wss:// tunnel and native TLS with a private certificate authority passed.");
}

async function verifyRuntime(binary) {
  const root = await mkdtemp(join(tmpdir(), "supertag-gateway-client-"));
  const children = [];
  const env = {
    SUPERTAG_DATABASE_URL: `sqlite://${join(root, "control.sqlite")}?mode=rwc`,
    SUPERTAG_OPERATOR_TOKEN: token,
    SUPERTAG_BOOTSTRAP_HOST_TOKEN: hostToken,
    SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL: gatewayCredential,
  };
  const abort = new AbortController();
  let client;
  try {
    /** Starts a service and reads the `count` addresses it reports, in order. */
    async function start(args, environment = env, count = 1) {
      const child = spawn(binary, args, { env: environment, stdio: ["ignore", "pipe", "inherit"] });
      children.push(child);
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const addresses = [];
      while (addresses.length < count) {
        const { value: endpoint } = await Promise.race([
          lines.next(),
          delay(10_000, undefined, { ref: false }).then(() => {
            throw new Error(`${args[0]} did not report its addresses`);
          }),
        ]);
        assert.match(endpoint, /^127\.0\.0\.1:[1-9][0-9]*$/u);
        addresses.push(endpoint);
      }
      return count === 1 ? `http://${addresses[0]}` : addresses;
    }
    const controlPlane = await start(["control-plane"]);
    // Clients connect to the Gateway, which forwards their calls to the Control Plane, natively
    // or through its WebSocket tunnel listener.
    const [native, tunnelAddress] = await start(
      [
        "gateway",
        "--control-plane",
        controlPlane,
        "--listen",
        "127.0.0.1:0",
        "--websocket-listen",
        "127.0.0.1:0",
      ],
      { SUPERTAG_GATEWAY_CREDENTIAL: gatewayCredential },
      2,
    );
    const url = `http://${native}`;
    const wrong = createGatewayClient({ url, token: "invalid-fixture-token" });
    try {
      await assert.rejects(wrong.operator.listTags({}, { timeoutMs: 3000 }), {
        code: Code.Unauthenticated,
      });
    } finally {
      wrong.close();
    }

    client = createGatewayClient({ url, token });
    await assert.rejects(
      client.artifactPublications.listPublications({ objectiveId: "unknown" }, { timeoutMs: 3000 }),
      { code: Code.NotFound },
    );
    const watch = client.events
      .watch({}, { signal: abort.signal, timeoutMs: 10_000 })
      [Symbol.asyncIterator]();
    const first = (await watch.next()).value;
    assert.equal(first.update.case, "heartbeat");
    const tag = await client.operator.putTag(
      { tagId: "node-sdk", instructions: "Build release notes." },
      { timeoutMs: 3000 },
    );
    const change = (await watch.next()).value;
    assert.equal(change.update.value.id, tag.tagId);
    assert.notEqual(change.resumeToken, first.resumeToken);

    const submission = {
      tagId: tag.tagId,
      sessionId: "fixture",
      operationId: "sdk-conformance",
      prompt: "Verify the installed Gateway client.",
    };
    const accepted = await client.operator.submitTask(submission, { timeoutMs: 3000 });
    const replay = await client.operator.submitTask(submission, { timeoutMs: 3000 });
    assert.ok(accepted.taskId);
    assert.equal(replay.taskId, accepted.taskId);
    console.log("Gateway authorization, Task replay, and streaming passed.");

    const adapter = join(root, "adapter.mjs");
    const harnessImport = import.meta.resolve("supertag-ai/harness");
    await writeFile(
      adapter,
      `import { EffectReceiptState, openHarness, receipt, TaskEventKind } from ${JSON.stringify(harnessImport)};
const harness = await openHarness(process.stdin);
try {
  const run = await receipt(() => harness.client.attach({}));
  if (!run.task || process.env.SUPERTAG_HOST_TOKEN) throw new Error("invalid execution scope");
  // Worker-managed effect receipts: a completed effect replays, an unsettled one is in doubt.
  const effect = { idempotencyKey: "ticket/1", operation: "create_ticket", argumentsJson: '{"title":"Release"}' };
  const begun = await harness.effects.begin(effect);
  if (begun.state !== EffectReceiptState.ACQUIRED) throw new Error("effect was not acquired");
  await harness.effects.complete({ ...effect, resultJson: '{"ticket":"T-1"}' });
  const replay = await harness.effects.begin(effect);
  if (replay.state !== EffectReceiptState.COMPLETED || !replay.replayed || replay.resultJson !== '{"ticket":"T-1"}')
    throw new Error("completed effect did not replay");
  const unsettled = { ...effect, idempotencyKey: "ticket/2" };
  await harness.effects.begin(unsettled);
  if ((await harness.effects.begin(unsettled)).state !== EffectReceiptState.IN_DOUBT)
    throw new Error("unsettled effect was not in doubt");
  const result = "Installed Node harness for " + run.task.tagId;
  const event = { sequence: 1n, text: result, kind: TaskEventKind.MESSAGE };
  await receipt(() => harness.client.publish(event));
  await receipt(() => harness.client.publish(event));
  await receipt(() => harness.client.complete({ succeeded: true, result }));
} finally {
  harness.close();
}`,
      { mode: 0o600 },
    );
    await execute(
      binary,
      [
        "worklet",
        "--control-plane",
        controlPlane,
        "--state-directory",
        join(root, "host"),
        "--adapter",
        process.execPath,
        "--adapter-arg",
        adapter,
        "--once",
      ],
      { env: { SUPERTAG_HOST_TOKEN: hostToken, PATH: "/usr/bin:/bin" }, timeout: 30_000 },
    );
    const task = await client.operator.getTask({ taskId: accepted.taskId }, { timeoutMs: 3000 });
    assert.equal(task.state, TaskState.SUCCEEDED);
    assert.equal(task.result, "Installed Node harness for node-sdk");
    const events = await client.operator.listEvents(
      { taskId: accepted.taskId },
      { timeoutMs: 3000 },
    );
    assert.equal(events.events.filter((event) => event.text === task.result).length, 1);
    console.log(
      "Installed Node harness executed one Task with an exact event replay and effect receipts.",
    );
    await verifyTunnels(
      binary,
      root,
      start,
      children,
      controlPlane,
      url,
      tunnelAddress,
      accepted.taskId,
    );
  } finally {
    abort.abort();
    client?.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
      const stopped = once(child, "exit");
      child.kill();
      await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.env.SUPERTAG_RUST_TEST_CLI) await verifyRuntime(process.env.SUPERTAG_RUST_TEST_CLI);
