import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/u.test(id);

// A single-process sample provider. State and operation receipts commit in the same file.
// This contract belongs to this provider, not to arbitrary HTTP/MCP services.
export async function startPolicyService({
  path,
  readToken,
  writeToken,
  port = 0,
  dropFirstResponse = false,
}) {
  if (!readToken || !writeToken || readToken === writeToken)
    throw new Error("Distinct service credentials required");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = { policies: {}, operations: {}, dropped: false };
  }
  const persist = async () => {
    const temporary = `${path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  let queue = Promise.resolve();
  let storageUncertain = false;
  const server = createServer((request, response) => {
    queue = queue
      .then(async () => {
        const token = request.headers.authorization?.replace(/^Bearer /u, "");
        const writer = equal(token, writeToken);
        const reply = (status, value) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (!writer && !equal(token, readToken)) return reply(401, { error: "Unauthorized" });
        if (storageUncertain)
          return reply(503, {
            error: "Storage outcome uncertain; restart and inspect durable state",
          });
        const url = new URL(request.url, "http://localhost");
        if (request.method === "GET" && url.pathname === "/status") return reply(200, state);
        if (request.method === "GET" && url.pathname === "/policy") {
          const incidentId = url.searchParams.get("incidentId");
          if (!validId(incidentId)) return reply(400, { error: "Invalid incidentId" });
          return reply(
            200,
            (Object.hasOwn(state.policies, incidentId)
              ? state.policies[incidentId]
              : undefined) ?? { incidentId, revision: 1, responseMinutes: 60 },
          );
        }
        if (request.method === "GET" && url.pathname === "/operation") {
          return reply(200, {
            operation: Object.hasOwn(state.operations, url.searchParams.get("operationId"))
              ? state.operations[url.searchParams.get("operationId")]
              : null,
          });
        }
        if (request.method !== "POST" || url.pathname !== "/apply")
          return reply(404, { error: "Unknown route" });
        if (!writer) return reply(403, { error: "Only the manager may apply policies" });
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 16384) return reply(413, { error: "Request too large" });
        }
        let input;
        try {
          input = JSON.parse(raw);
        } catch {
          return reply(400, { error: "Invalid JSON" });
        }
        if (!input || typeof input !== "object" || Array.isArray(input))
          return reply(400, { error: "Invalid policy proposal" });
        const {
          operationId,
          incidentId,
          expectedRevision,
          responseMinutes,
          sourceArtifactId,
          sourceDigest,
        } = input;
        if (
          typeof operationId !== "string" ||
          !/^[a-zA-Z0-9:_-]{1,160}$/u.test(operationId) ||
          !validId(incidentId) ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 1 ||
          responseMinutes !== 30 ||
          typeof sourceArtifactId !== "string" ||
          !sourceArtifactId ||
          !/^sha256:[a-f0-9]{64}$/u.test(sourceDigest)
        )
          return reply(400, { error: "Invalid policy proposal" });
        const proposal = {
          operationId,
          incidentId,
          expectedRevision,
          responseMinutes,
          sourceArtifactId,
          sourceDigest,
        };
        const fingerprint = digest(proposal);
        const previous = Object.hasOwn(state.operations, operationId)
          ? state.operations[operationId]
          : undefined;
        if (previous)
          return previous.fingerprint === fingerprint
            ? reply(200, previous)
            : reply(409, { error: "Operation ID reused with different content" });
        const current = (Object.hasOwn(state.policies, incidentId)
          ? state.policies[incidentId]
          : undefined) ?? { revision: 1 };
        if (current.revision !== expectedRevision)
          return reply(409, { error: "Policy revision changed", current });
        const receipt = {
          ...proposal,
          fingerprint,
          revision: current.revision + 1,
          appliedAt: new Date().toISOString(),
        };
        // Use defineProperty to treat every identifier as data, including '__proto__'.
        Object.defineProperty(state.operations, operationId, {
          value: receipt,
          enumerable: true,
          configurable: true,
        });
        Object.defineProperty(state.policies, incidentId, {
          value: receipt,
          enumerable: true,
          configurable: true,
        });
        const drop = dropFirstResponse && !state.dropped;
        if (drop) state.dropped = true;
        try {
          await persist();
        } catch (error) {
          storageUncertain = true;
          throw error;
        }
        if (drop) return response.destroy(); // Applied, but the caller receives no acknowledgement.
        reply(200, receipt);
      })
      .catch((error) => {
        response.destroy();
        console.error(error.message);
      });
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await startPolicyService({
    path: process.env.SUPPORT_POLICY_STATE,
    port: Number(process.env.SUPPORT_POLICY_PORT),
    readToken: process.env.SUPPORT_READ_TOKEN,
    writeToken: process.env.SUPPORT_WRITE_TOKEN,
    dropFirstResponse: process.env.SUPPORT_DROP_RESPONSE === "1",
  });
  console.log(service.url);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await service.close();
      process.exit(0);
    });
}
