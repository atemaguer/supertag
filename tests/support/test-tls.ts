/** Disposable CA and server certificate for HTTPS test fixtures, made with openssl. */
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface TestTlsFiles {
  readonly caFile: string;
  readonly certFile: string;
  readonly keyFile: string;
}

export async function generateTestTls(directory: string): Promise<TestTlsFiles> {
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
  const run = (args: string[]) =>
    execute("openssl", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
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
