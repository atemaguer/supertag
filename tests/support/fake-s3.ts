/**
 * A local S3-compatible server for tests: path-style ListObjectsV2, GetObject, and PutObject over
 * real HTTPS,
 * so the AWS SDK client SuperTag uses signs and sends real requests. It checks the access key in
 * each request's SigV4 Authorization header and records every request. No cloud is involved.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCoordinationTls } from "../../examples/shared-organization/coordination-tls.mjs";

// Pass the fixture CA only to HTTPS connections targeting an active fixture endpoint.
// Keep verification enabled and use APIs supported by Node 22.13.0. Reuse certificates
// within the suite and remove their files at once.
let certificates: Promise<{ ca: string; cert: Buffer; key: Buffer }> | undefined;
const trustedPorts = new Map<number, string>();
let originalCreateConnection: typeof Agent.prototype.createConnection;
function trustEndpoint(port: number, ca: string): void {
  if (trustedPorts.size === 0) {
    originalCreateConnection = Agent.prototype.createConnection;
    Agent.prototype.createConnection = function (options, callback) {
      const fixtureCa =
        options.host === "127.0.0.1" ? trustedPorts.get(Number(options.port)) : undefined;
      return originalCreateConnection.call(
        this,
        fixtureCa === undefined ? options : { ...options, ca: fixtureCa },
        callback,
      );
    };
  }
  trustedPorts.set(port, ca);
}
async function testCertificates() {
  certificates ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-fake-s3-tls-"));
    try {
      const files = await generateCoordinationTls(directory);
      return {
        ca: await readFile(files.caFile, "utf8"),
        cert: await readFile(files.certFile),
        key: await readFile(files.keyFile),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return certificates;
}

export interface FakeS3Request {
  readonly method: string;
  readonly bucket: string;
  readonly key?: string;
  readonly query: Readonly<Record<string, string>>;
  readonly accessKeyId?: string;
  /** Every request header, to check what reached the store. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface StoredObject {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly listedSize?: number;
}

export class FakeS3 {
  readonly requests: FakeS3Request[] = [];
  /** Most keys one listing page returns, whatever MaxKeys asks for. */
  pageSize = 1000;
  /** When true, every listing is an empty page that says it is truncated, without end. */
  endlessEmptyPages = false;
  /** When set, listings fail with AccessDenied and this message. */
  listError?: string;
  /**
   * When set, every object request fails with this code, and its message and response echo the
   * request's access key and Authorization header, as a misbehaving store might.
   */
  echoError?: string;
  /** Called before an object is served, to change it between listing and download. */
  beforeGet?: (bucket: string, key: string) => void;
  readonly #buckets = new Map<string, Map<string, StoredObject>>();
  #closed = false;
  #port = 0;

  private constructor(
    readonly server: Server,
    readonly accessKeyId: string,
  ) {}

  static async start(accessKeyId = "fake-access-key"): Promise<FakeS3> {
    const tls = await testCertificates();
    let fake: FakeS3 | undefined;
    const server = createServer(tls, (request, response) => {
      try {
        fake?.handle(request, response);
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    });
    fake = new FakeS3(server, accessKeyId);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    fake.#port = (server.address() as AddressInfo).port;
    trustEndpoint(fake.#port, tls.ca);
    return fake;
  }

  get endpoint(): string {
    return `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Creates an empty bucket, so PutObject into it succeeds. */
  bucket(bucket: string): void {
    if (!this.#buckets.has(bucket)) this.#buckets.set(bucket, new Map());
  }

  /** An object's bytes, or undefined when absent. */
  object(bucket: string, key: string): Uint8Array | undefined {
    return this.#buckets.get(bucket)?.get(key)?.body;
  }

  put(bucket: string, key: string, body: string | Uint8Array, listedSize?: number): void {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    let objects = this.#buckets.get(bucket);
    if (objects === undefined) {
      objects = new Map();
      this.#buckets.set(bucket, objects);
    }
    objects.set(key, {
      body: bytes,
      etag: `"${createHash("md5").update(bytes).digest("hex")}"`,
      ...(listedSize === undefined ? {} : { listedSize }),
    });
  }

  /** Object downloads, as opposed to listings. */
  get downloads(): readonly FakeS3Request[] {
    return this.requests.filter((request) => request.key !== undefined);
  }

  get listings(): readonly FakeS3Request[] {
    return this.requests.filter((request) => request.key === undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    trustedPorts.delete(this.#port);
    if (trustedPorts.size === 0) Agent.prototype.createConnection = originalCreateConnection;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://fake");
    const [, bucket = "", ...rest] = url.pathname.split("/");
    const key = rest.length === 0 ? undefined : rest.map(decodeURIComponent).join("/");
    const accessKeyId = /Credential=([^/]+)\//u.exec(request.headers.authorization ?? "")?.[1];
    this.requests.push({
      method: request.method ?? "GET",
      bucket,
      ...(key === undefined || key === "" ? {} : { key }),
      query: Object.fromEntries(url.searchParams),
      ...(accessKeyId === undefined ? {} : { accessKeyId }),
      headers: { ...request.headers },
    });
    if (this.echoError !== undefined && key !== undefined && key !== "") {
      request.resume();
      const authorization = request.headers.authorization ?? "";
      response.writeHead(403, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${this.echoError}</Code><Message>Signature for ${xml(accessKeyId ?? "")} did not match: ${xml(authorization)}</Message><AWSAccessKeyId>${xml(accessKeyId ?? "")}</AWSAccessKeyId></Error>`,
      );
      return;
    }
    if (request.method === "PUT" && key !== undefined && key !== "") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (accessKeyId !== this.accessKeyId) {
          error(response, 403, "InvalidAccessKeyId", "The access key is not known");
          return;
        }
        if (!this.#buckets.has(bucket)) {
          error(response, 404, "NoSuchBucket", "No such bucket");
          return;
        }
        const body = Buffer.concat(chunks);
        this.put(bucket, key, body);
        response.writeHead(200, { etag: this.#buckets.get(bucket)?.get(key)?.etag ?? "" });
        response.end();
      });
      return;
    }
    request.resume();
    if (accessKeyId !== this.accessKeyId) {
      error(response, 403, "InvalidAccessKeyId", "The access key is not known");
      return;
    }
    const objects = this.#buckets.get(bucket);
    if (objects === undefined) {
      error(response, 404, "NoSuchBucket", "No such bucket");
      return;
    }
    if (key === undefined || key === "") {
      if (this.listError !== undefined) {
        error(response, 403, "AccessDenied", this.listError);
        return;
      }
      this.#list(bucket, objects, url.searchParams, response);
      return;
    }
    this.beforeGet?.(bucket, key);
    const object = this.#buckets.get(bucket)?.get(key);
    if (object === undefined) {
      error(response, 404, "NoSuchKey", "No such key");
      return;
    }
    const ifMatch = request.headers["if-match"];
    if (ifMatch !== undefined && ifMatch !== object.etag) {
      error(response, 412, "PreconditionFailed", "At least one precondition failed");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(object.body.byteLength),
      etag: object.etag,
    });
    response.end(Buffer.from(object.body));
  }

  #list(
    bucket: string,
    objects: ReadonlyMap<string, StoredObject>,
    query: URLSearchParams,
    response: ServerResponse,
  ): void {
    const prefix = query.get("prefix") ?? "";
    const maximum = Math.min(Number(query.get("max-keys") ?? "1000"), this.pageSize);
    const after = query.get("continuation-token") ?? "";
    if (this.endlessEmptyPages) {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>0</KeyCount><MaxKeys>${maximum}</MaxKeys><IsTruncated>true</IsTruncated><NextContinuationToken>${xml(`${after}x`)}</NextContinuationToken></ListBucketResult>`,
      );
      return;
    }
    const keys = [...objects.keys()]
      .filter((key) => key.startsWith(prefix) && key > after)
      .toSorted();
    const page = keys.slice(0, maximum);
    const truncated = keys.length > page.length;
    const contents = page
      .map((key) => {
        const object = objects.get(key) as StoredObject;
        return `<Contents><Key>${xml(key)}</Key><LastModified>2026-10-04T00:00:00.000Z</LastModified><ETag>${xml(object.etag)}</ETag><Size>${object.listedSize ?? object.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join("");
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maximum}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xml(page.at(-1) ?? "")}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
    );
  }
}

function error(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`,
  );
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
