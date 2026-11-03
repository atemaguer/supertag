import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const requireStore = createRequire(new URL("../packages/store/package.json", import.meta.url));
const { Client } = requireStore("pg");
const databaseNamePattern = /^supertag_test_[0-9a-f]{32}$/;
const markerPrefix = "supertag-test-wrapper:v1:";
// Serialize provisioning and reclamation, but never hold this lock during the test run.
const lifecycleLock = "SELECT pg_advisory_lock(1398032212, 0)";
const lifecycleUnlock = "SELECT pg_advisory_unlock(1398032212, 0)";
const allowedParameters = new Set([
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
  "uselibpqcompat",
  "application_name",
]);

function isLoopback(host) {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

export function testPostgresTarget(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Test PostgreSQL requires a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.includes("%") ||
    url.pathname.length <= 1 ||
    url.hash
  ) {
    throw new Error("Test PostgreSQL requires an explicit host and database");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // pg preserves URL brackets in its hostname. A matching host parameter carries the
  // unbracketed literal through both the admin client and child test runners.
  const ipv6 = isIP(host) === 6;
  for (const key of url.searchParams.keys()) {
    const normalizedHost =
      key === "host" &&
      ipv6 &&
      url.searchParams.getAll("host").length === 1 &&
      url.searchParams.get("host") === host;
    if (!allowedParameters.has(key) && !normalizedHost) {
      throw new Error("Test PostgreSQL URL contains an unsupported connection parameter");
    }
  }
  if (ipv6) url.searchParams.set("host", host);
  return { url, local: host === "localhost" || isLoopback(host) };
}

async function ownedDatabases(admin, baseOid) {
  return (
    await admin.query(`
    SELECT oid::text, datname AS name, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database
    WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND NOT datistemplate AND datname <> current_database()
  `)
  ).rows.filter(
    ({ oid, name, marker }) =>
      databaseNamePattern.test(name) && marker === `${markerPrefix}${baseOid}:${oid}:${name}`,
  );
}

async function dropOwnedDatabase(admin, database, baseOid) {
  // Recheck the catalog identity: a callback may have dropped or replaced its database.
  const current = (await ownedDatabases(admin, baseOid)).find(
    ({ oid, name }) => oid === database.oid && name === database.name,
  );
  if (current) await admin.query(`DROP DATABASE "${current.name}" WITH (FORCE)`);
}

async function reclaimDatabases(admin, baseOid) {
  for (const database of await ownedDatabases(admin, baseOid)) {
    const { rows } = await admin.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [
      database.oid,
    ]);
    if (!rows[0].acquired) continue;
    try {
      await dropOwnedDatabase(admin, database, baseOid);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1::bigint)", [database.oid]);
    }
  }
}

export async function withTestPostgres(baseUrl, run) {
  if (!baseUrl) return run(undefined);
  const { url: isolated, local } = testPostgresTarget(baseUrl);
  // A dedicated session holds the live-run lock until cleanup, including long idle runs.
  const admin = new Client({
    connectionString: isolated.toString(),
    connectionTimeoutMillis: 10_000,
  });
  let connectionError;
  admin.on("error", (error) => {
    connectionError = error;
  });
  let database;
  let baseOid;
  try {
    await admin.connect();
    const {
      rows: [base],
    } = await admin.query(`
      SELECT oid::text, host(inet_server_addr()) AS address,
        shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname = current_database()
    `);
    // A loopback URL may forward to a remote server; verify both ends.
    if ((!local || !isLoopback(base.address)) && base.marker !== "supertag-test-server") {
      throw new Error(
        "Refusing PostgreSQL target: use a loopback server or mark the base database with COMMENT ON DATABASE ... IS 'supertag-test-server'",
      );
    }
    baseOid = base.oid;
    await admin.query(lifecycleLock);
    try {
      await reclaimDatabases(admin, baseOid);
      const name = `supertag_test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${name}"`);
      const {
        rows: [created],
      } = await admin.query(
        "SELECT oid::text, datname AS name FROM pg_database WHERE datname = $1",
        [name],
      );
      await admin.query("SELECT pg_advisory_lock($1::bigint)", [created.oid]);
      await admin.query(
        `COMMENT ON DATABASE "${name}" IS '${markerPrefix}${baseOid}:${created.oid}:${name}'`,
      );
      database = created;
      isolated.pathname = `/${name}`;
    } finally {
      await admin.query(lifecycleUnlock);
    }
    const result = await run(isolated.toString());
    if (connectionError) throw connectionError;
    return result;
  } finally {
    try {
      if (database && !connectionError) {
        await admin.query(lifecycleLock);
        await dropOwnedDatabase(admin, database, baseOid);
      }
    } finally {
      // Ending the session releases both lifecycle and live-run locks, even on errors.
      await admin.end();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [script, ...args] = process.argv.slice(2);
  if (!script) throw new Error("Test runner script required");
  let child;
  let receivedSignal;
  const forward = (signal) => {
    receivedSignal ??= signal;
    child?.kill(signal);
  };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    const code = await withTestPostgres(
      process.env.SUPERTAG_POSTGRES_URL,
      (url) =>
        new Promise((resolve, reject) => {
          child = spawn(process.execPath, [script, ...args], {
            stdio: "inherit",
            env: { ...process.env, ...(url ? { SUPERTAG_POSTGRES_URL: url } : {}) },
          });
          child.on("error", reject);
          child.on("close", (exitCode, signal) =>
            resolve(exitCode ?? (signal ? 128 + constants.signals[signal] : 0)),
          );
          if (receivedSignal) child.kill(receivedSignal);
        }),
    );
    process.exitCode = receivedSignal ? 128 + constants.signals[receivedSignal] : code;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}
