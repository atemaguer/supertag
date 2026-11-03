import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const routes = new Map([
  ["/internal/v1/coordination/mcp", ["GET", "POST", "DELETE"]],
  ["/internal/v1/coordination/rebind", ["POST"]],
  ["/internal/v1/sessions/save", ["POST"]],
  ["/internal/v1/sessions/load", ["POST"]],
]);

export async function generateCoordinationTls(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caFile = join(directory, "ca.pem");
  const certFile = join(directory, "server.pem");
  const keyFile = join(directory, "server-key.pem");
  const caKey = join(directory, "ca-key.pem");
  const csr = join(directory, "server.csr");
  const extensions = join(directory, "server.ext");
  await writeFile(
    extensions,
    "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    { mode: 0o600, flag: "wx" },
  );
  const run = (args) => execute("openssl", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  await run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=SuperTag example CA",
    "-keyout",
    caKey,
    "-out",
    caFile,
  ]);
  await run([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=host.docker.internal",
    "-keyout",
    keyFile,
    "-out",
    csr,
  ]);
  await run([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    caFile,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    certFile,
    "-days",
    "1",
    "-extfile",
    extensions,
  ]);
  await Promise.all([caKey, keyFile, csr].map((path) => chmod(path, 0o600)));
  return { caFile, certFile, keyFile };
}

export async function checkCoordinationTls(url, caFile) {
  const ca = await readFile(caFile);
  return new Promise((resolve, reject) => {
    const probe = httpsRequest(new URL("/readiness", url), { ca, timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 404);
    });
    probe.on("timeout", () => probe.destroy(new Error("TLS readiness timed out")));
    probe.on("error", reject);
    probe.end();
  });
}

/** TLS crosses the container boundary; the fixed upstream remains host-local. */
export async function startCoordinationTls({
  targetUrl,
  certFile,
  keyFile,
  host = "127.0.0.1",
  port = 0,
}) {
  const target = new URL(targetUrl);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("Coordination TLS requires a fixed loopback HTTP upstream");
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("The example coordination TLS listener must bind loopback");
  const sockets = new Set();
  const server = createServer(
    { cert: await readFile(certFile), key: await readFile(keyFile), minVersion: "TLSv1.2" },
    (incoming, outgoing) => {
      if (!routes.get(incoming.url)?.includes(incoming.method)) {
        outgoing.writeHead(404).end();
        incoming.resume();
        return;
      }
      const upstream = request(
        new URL(incoming.url, target),
        {
          method: incoming.method,
          headers: { ...incoming.headers, host: target.host },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          outgoing.flushHeaders();
          response.pipe(outgoing);
          response.on("error", () => outgoing.destroy());
        },
      );
      upstream.setTimeout(600000, () => upstream.destroy());
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502).end();
        else outgoing.destroy();
      });
      incoming.on("aborted", () => upstream.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    url: `https://${host === "::1" ? "[::1]" : host}:${server.address().port}`,
    async close() {
      const closing = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help"))
    console.log("node coordination-tls.mjs <private-config-file>");
  else {
    const configuration = JSON.parse(await readFile(process.argv[2], "utf8"));
    const endpoint = await startCoordinationTls(configuration);
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, async () => {
        await endpoint.close();
      });
  }
}
