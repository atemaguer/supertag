import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { testPostgresTarget, withTestPostgres } from "./with-test-postgres.mjs";

const requireStore = createRequire(new URL("../packages/store/package.json", import.meta.url));
const { Client, Pool } = requireStore("pg");
const baseUrl = process.env.SUPERTAG_POSTGRES_URL;
const wrapper = new URL("./with-test-postgres.mjs", import.meta.url).pathname;

test("target validation refuses endpoint overrides and implicit connection defaults", () => {
  for (const url of [
    "postgresql:///supertag_test",
    "postgresql://localhost",
    "https://localhost/supertag_test",
    "postgresql://%2ftmp/supertag_test",
    "postgresql://localhost/supertag_test?host=production.example",
    "postgresql://localhost/supertag_test?%68ost=production.example",
    "postgresql://localhost/supertag_test?hostaddr=10.0.0.1",
    "postgresql://localhost/supertag_test?connectionString=postgresql://production/db",
    "postgresql://localhost/supertag_test?database=production",
  ])
    assert.throws(() => testPostgresTarget(url), /Test PostgreSQL/);
  for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) {
    assert.equal(
      testPostgresTarget(`postgresql://supertag@${host}:55432/supertag_test`).local,
      true,
    );
  }
  for (const host of ["production.example", "localhost.example", "10.0.0.1", "[2001:db8::1]"]) {
    assert.equal(testPostgresTarget(`postgresql://${host}/supertag_test`).local, false);
  }
});

test("IPv6 targets reach pg as unbracketed addresses without allowing endpoint overrides", () => {
  for (const host of ["::1", "2001:db8::1"]) {
    const target = testPostgresTarget(`postgresql://user:password@[${host}]:55432/supertag_test`);
    const client = new Client({ connectionString: target.url.toString() });
    assert.equal(client.host, host);
    assert.equal(client.port, 55432);
    assert.equal(client.database, "supertag_test");
    assert.equal(client.user, "user");
    assert.equal(client.password, "password");
    // Child test runners may pass the wrapper's normalized URL through it again.
    assert.equal(testPostgresTarget(target.url.toString()).url.toString(), target.url.toString());
  }
  for (const query of ["host=127.0.0.1", "host=::2", "host=::1&host=::2", "host=::1&host=::1"]) {
    assert.throws(
      () => testPostgresTarget(`postgresql://[::1]/supertag_test?${query}`),
      /unsupported connection parameter/,
    );
  }
});

test("unmarked remote targets are refused before writes; marked test servers are allowed", async () => {
  for (const [host, address, marker, allowed] of [
    ["production.example", "10.0.0.1", null, false],
    ["production.example", "10.0.0.1", "supertag-test-server", true],
    ["production.example", "10.0.0.1", "almost-supertag-test-server", false],
    // Tunnels and Docker endpoints require the explicit marker.
    ["localhost", "192.168.215.2", null, false],
    ["127.0.0.1", "192.168.215.2", null, false],
    ["[::1]", "172.17.0.2", null, false],
    ["127.0.0.1", "127.0.0.1", null, true],
    ["localhost", "172.17.0.2", "supertag-test-server", true],
    ["[::1]", "::1", null, true],
  ]) {
    const writes = [];
    mock.method(Client.prototype, "connect", async () => {});
    mock.method(Client.prototype, "end", async () => {});
    mock.method(Client.prototype, "query", async (sql) => {
      if (sql.includes("datname = current_database()")) {
        assert.match(sql, /host\(inet_server_addr\(\)\)/);
        return { rows: [{ oid: "1", address, marker }] };
      }
      if (sql.startsWith("CREATE DATABASE")) {
        writes.push(sql);
        throw new Error("Approved target reached CREATE DATABASE");
      }
      assert.ok(sql.trim().startsWith("SELECT"));
      return { rows: [] };
    });
    try {
      await assert.rejects(
        withTestPostgres(`postgresql://${host}/supertag_test`, () => {
          assert.fail("must not run without a database");
        }),
        allowed ? /Approved target/ : /Refusing PostgreSQL target/,
      );
      assert.equal(writes.length, allowed ? 1 : 0);
    } finally {
      mock.restoreAll();
    }
  }
});

async function exists(admin, name) {
  const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return result.rowCount === 1;
}

async function waitForFile(path) {
  for (let i = 0; i < 100; i++) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Child did not write ${path}`);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-pg-wrapper-"));
  const script = join(directory, "child.mjs");
  await writeFile(
    script,
    "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], JSON.stringify({ url: process.env.SUPERTAG_POSTGRES_URL, pid: process.pid })); setInterval(() => {}, 1000); setTimeout(() => process.exit(3), 10_000);\n",
  );
  return { directory, script };
}

test("signal forwards to child and drops the database", {
  skip: !baseUrl,
  timeout: 20_000,
}, async () => {
  if (!baseUrl) return;
  const { directory, script } = await fixture();
  const marker = join(directory, "url");
  const admin = new Pool({ connectionString: baseUrl });
  const child = spawn(process.execPath, [wrapper, script, marker], {
    env: { ...process.env, SUPERTAG_POSTGRES_URL: baseUrl },
  });
  try {
    const fixture = JSON.parse(await waitForFile(marker));
    const name = new URL(fixture.url).pathname.slice(1);
    assert.equal(await exists(admin, name), true);
    child.kill("SIGTERM");
    const status = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(status, { code: 143, signal: null });
    assert.equal(await exists(admin, name), false);
  } finally {
    child.kill("SIGKILL");
    try {
      process.kill(JSON.parse(await readFile(marker, "utf8")).pid, "SIGKILL");
    } catch {}
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent wrappers use distinct databases and clean both", {
  skip: !baseUrl,
  timeout: 20_000,
}, async () => {
  if (!baseUrl) return;
  const { directory, script } = await fixture();
  const admin = new Pool({ connectionString: baseUrl });
  const children = [0, 1].map((i) =>
    spawn(process.execPath, [wrapper, script, join(directory, `url-${i}`)], {
      env: { ...process.env, SUPERTAG_POSTGRES_URL: baseUrl },
    }),
  );
  try {
    const fixtures = await Promise.all(
      [0, 1].map(async (i) => JSON.parse(await waitForFile(join(directory, `url-${i}`)))),
    );
    const names = fixtures.map((item) => new URL(item.url).pathname.slice(1));
    assert.notEqual(names[0], names[1]);
    assert.deepEqual(await Promise.all(names.map((name) => exists(admin, name))), [true, true]);
    for (const child of children) child.kill("SIGINT");
    const statuses = await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      ),
    );
    assert.deepEqual(statuses, [
      { code: 130, signal: null },
      { code: 130, signal: null },
    ]);
    assert.deepEqual(await Promise.all(names.map((name) => exists(admin, name))), [false, false]);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    for (const i of [0, 1]) {
      try {
        process.kill(
          JSON.parse(await readFile(join(directory, `url-${i}`), "utf8")).pid,
          "SIGKILL",
        );
      } catch {}
    }
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a run uses a fresh database and removes it afterwards", { skip: !baseUrl }, async () => {
  if (!baseUrl) return;
  let name = "";
  await withTestPostgres(baseUrl, async (url) => {
    assert.ok(url);
    name = new URL(url).pathname.slice(1);
    assert.notEqual(name, new URL(baseUrl).pathname.slice(1));
    const pool = new Pool({ connectionString: url });
    try {
      const rows = (
        await pool.query(
          "SELECT count(*)::int AS count FROM pg_class WHERE relname = 'supertag_run_marker'",
        )
      ).rows;
      assert.equal(rows[0].count, 0);
      await pool.query("CREATE TABLE supertag_run_marker (id integer)");
    } finally {
      await pool.end();
    }
  });
  const admin = new Pool({ connectionString: baseUrl });
  try {
    const rows = (
      await admin.query("SELECT count(*)::int AS count FROM pg_database WHERE datname = $1", [name])
    ).rows;
    assert.equal(rows[0].count, 0);
  } finally {
    await admin.end();
  }
});

test("the next run reclaims a killed wrapper's database but preserves unmarked databases", {
  skip: !baseUrl,
  timeout: 20_000,
}, async () => {
  const { directory, script } = await fixture();
  const marker = join(directory, "url");
  const admin = new Pool({ connectionString: baseUrl });
  const unrelated = `supertag_test_${randomUUID().replaceAll("-", "")}`;
  let abandoned;
  let fixturePid;
  await admin.query(`CREATE DATABASE "${unrelated}"`);
  const child = spawn(process.execPath, [wrapper, script, marker], {
    env: { ...process.env, SUPERTAG_POSTGRES_URL: baseUrl },
  });
  try {
    const fixture = JSON.parse(await waitForFile(marker));
    fixturePid = fixture.pid;
    abandoned = new URL(fixture.url).pathname.slice(1);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    process.kill(fixturePid, "SIGKILL");
    fixturePid = undefined;
    assert.equal(await exists(admin, abandoned), true);
    await withTestPostgres(baseUrl, async () => {
      assert.equal(await exists(admin, abandoned), false);
      assert.equal(await exists(admin, unrelated), true);
    });
  } finally {
    child.kill("SIGKILL");
    if (fixturePid) {
      try {
        process.kill(fixturePid, "SIGKILL");
      } catch {}
    }
    // These exact names were created by this test, including on the pre-fix failure path.
    if (abandoned) await admin.query(`DROP DATABASE IF EXISTS "${abandoned}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE "${unrelated}" WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup preserves a replacement database even when its ownership comment was copied", {
  skip: !baseUrl,
}, async () => {
  const admin = new Pool({ connectionString: baseUrl });
  let name;
  try {
    await withTestPostgres(baseUrl, async (url) => {
      name = new URL(url).pathname.slice(1);
      const {
        rows: [original],
      } = await admin.query(
        "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
        [name],
      );
      assert.ok(original.marker);
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}"`);
      // Only this test creates the replacement. The wrapper has no ownership of its new OID.
      await admin.query(`COMMENT ON DATABASE "${name}" IS '${original.marker}'`);
    });
    assert.equal(await exists(admin, name), true);
    await withTestPostgres(baseUrl, async () => {
      assert.equal(await exists(admin, name), true);
    });
  } finally {
    if (name) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});

test("callback failures still release the database and locks", { skip: !baseUrl }, async () => {
  let name;
  await assert.rejects(
    withTestPostgres(baseUrl, async (url) => {
      name = new URL(url).pathname.slice(1);
      throw new Error("test runner failed");
    }),
    /test runner failed/,
  );
  const admin = new Pool({ connectionString: baseUrl });
  try {
    assert.equal(await exists(admin, name), false);
    await withTestPostgres(baseUrl, async () => {});
  } finally {
    await admin.end();
  }
});
