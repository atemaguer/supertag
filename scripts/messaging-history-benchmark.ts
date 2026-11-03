import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { TagMessageHistoryCursor } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "SUPERTAG_POSTGRES_URL=... pnpm exec tsx --conditions=development scripts/messaging-history-benchmark.ts [--iterations 100] --output report.json\nUses a temporary private database; requires CREATEDB.\n",
  );
} else await main();

async function main() {
  const source = process.env["SUPERTAG_POSTGRES_URL"];
  if (!source) throw new Error("SUPERTAG_POSTGRES_URL required");
  const iterations = Number(values.iterations ?? 100);
  if (!Number.isSafeInteger(iterations) || iterations < 10 || iterations > 1000)
    throw new Error("iterations must be 10–1000");
  const Pool = createRequire(new URL("../packages/store/package.json", import.meta.url))("pg")
    .Pool as new (options: {
    connectionString: string;
    max: number;
  }) => {
    query(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
  const admin = new Pool({ connectionString: source, max: 1 });
  const database = `supertag_history_bench_${randomUUID().replaceAll("-", "")}`;
  const stores: DrizzleStore[] = [];
  let fixture: InstanceType<typeof Pool> | undefined;
  let created = false;
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      architecture: arch(),
      cpu: cpus()[0]?.model,
    },
    methodology:
      "Closed-loop warm-cache reads through production Store API, including active-Tag authorization lookup and JSON decoding. Fixture SQL inserts are untimed. Four Store instances in one process, not four Control Planes. EXPLAIN covers the history SQL, excluding authorization lookup. No latency thresholds imply a production SLO.",
    payloadBytes: 1024,
    iterations,
    warmup: 10,
    pageLimit: 50,
    cases: [] as unknown[],
  };
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const url = new URL(source);
    url.pathname = `/${database}`;
    await migrateDatabase({ url: url.toString() });
    fixture = new Pool({ connectionString: url.toString(), max: 1 });
    report["database"] = (
      await fixture.query(
        "SELECT version(), current_setting('shared_buffers') AS shared_buffers, current_setting('work_mem') AS work_mem, current_setting('max_connections') AS max_connections",
      )
    ).rows[0];
    for (let i = 0; i < 4; i++) {
      const store = new DrizzleStore({ url: url.toString() });
      await store.connect();
      stores.push(store);
    }
    const first = stores[0];
    if (!first) throw new Error("Missing Store");
    const actor = await first.createTag({ name: "history-actor" });
    const peer = await first.createTag({ name: "history-peer" });
    const unrelated = await first.createTag({ name: "unrelated" });
    for (const totalRows of [1000, 10000, 100000]) {
      for (const scope of ["fixed100", "all"] as const) {
        const matchingRows = scope === "all" ? totalRows : 100;
        // This private fixture has no Task assignments. PostgreSQL still requires
        // CASCADE for the source-message foreign key when truncating its parent.
        await fixture.query('TRUNCATE "TagMessage" CASCADE');
        // Timestamps tie in groups of ten. Only the first matchingRows involve actor;
        // unrelated rows are newer, exercising visibility-filtered history reads.
        await fixture.query(
          `INSERT INTO "TagMessage"
          (id,"senderTagId","recipientTagId","objectiveId",type,body,"idempotencyKey",fingerprint,status,"attemptCount","createdAt","updatedAt","processedAt")
          SELECT 'bench-'||lpad(g::text,8,'0'),
            CASE WHEN g <= $2 AND g % 2 = 0 THEN $3 ELSE $4 END,
            CASE WHEN g <= $2 AND g % 2 = 1 THEN $3 ELSE $5 END,
            'history-benchmark','progress.updated',jsonb_build_object('text',repeat('x',1024)),
            'key-'||g,md5(g::text),'processed',1,
            to_char(timestamp '2026-01-01 00:00:00' + (g / 10) * interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            '2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z'
          FROM generate_series(1,$1::integer) AS g`,
          [totalRows, matchingRows, actor.id, peer.id, unrelated.id],
        );
        await fixture.query('ANALYZE "TagMessage"');
        const count = await fixture.query(
          'SELECT count(*) AS n FROM "TagMessage" WHERE "senderTagId"=$1 OR "recipientTagId"=$1',
          [actor.id],
        );
        assert.equal(Number(count.rows[0]?.["n"]), matchingRows);
        const relationBytes = (
          await fixture.query(`SELECT pg_total_relation_size('"TagMessage"') AS bytes`)
        ).rows[0]?.["bytes"];
        const cursorOffset = Math.floor(matchingRows * 0.9);
        const row = (
          await fixture.query(
            'SELECT id,"createdAt" FROM "TagMessage" WHERE "senderTagId"=$1 OR "recipientTagId"=$1 ORDER BY "createdAt" DESC,id DESC OFFSET $2 LIMIT 1',
            [actor.id, cursorOffset],
          )
        ).rows[0];
        if (!row) throw new Error("Missing cursor fixture");
        const deepCursor: TagMessageHistoryCursor = {
          createdAt: String(row["createdAt"]),
          id: String(row["id"]),
        };
        for (const depth of ["latest", "90-percent"] as const) {
          const before = depth === "latest" ? undefined : deepCursor;
          const expectedCount = Math.min(
            50,
            depth === "latest" ? matchingRows : matchingRows - cursorOffset - 1,
          );
          const parameters: unknown[] = [actor.id];
          let predicate = '("senderTagId"=$1 OR "recipientTagId"=$1)';
          if (before) {
            parameters.push(before.createdAt, before.id);
            predicate += ' AND ("createdAt"<$2 OR ("createdAt"=$2 AND id<$3))';
          }
          const plan = (
            await fixture.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM "TagMessage" WHERE ${predicate} ORDER BY "createdAt" DESC,id DESC LIMIT 51`,
              parameters,
            )
          ).rows;
          for (const concurrency of [1, 8]) {
            const read = async (i: number) => {
              const store = stores[i % stores.length];
              if (!store) throw new Error("Missing Store");
              const result = await store.listTagMessageHistory(actor.id, {
                ...(before ? { before } : {}),
                limit: 50,
              });
              assert.equal(result.items.length, expectedCount);
              for (const item of result.items)
                assert.ok(item.senderTagId === actor.id || item.recipientTagId === actor.id);
            };
            for (let i = 0; i < 10; i++) await read(i);
            const samples: number[] = [];
            let next = 0;
            const started = performance.now();
            await Promise.all(
              Array.from({ length: concurrency }, async () => {
                while (next < iterations) {
                  const i = next++;
                  const t = performance.now();
                  await read(i);
                  samples.push(performance.now() - t);
                }
              }),
            );
            const elapsedMs = performance.now() - started;
            samples.sort((a, b) => a - b);
            const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1];
            const result = {
              totalRows,
              matchingRows,
              scope,
              direction: "evenly mixed sent/received",
              depth,
              relationBytes: Number(relationBytes),
              storeInstances: stores.length,
              concurrency,
              n: samples.length,
              returnedRowsPerRead: expectedCount,
              elapsedMs,
              readsPerSecond: (iterations / elapsedMs) * 1000,
              p50Ms: percentile(0.5),
              p95Ms: percentile(0.95),
              p99Ms: percentile(0.99),
              explain: plan,
            };
            (report["cases"] as unknown[]).push(result);
            process.stdout.write(
              `${totalRows} rows / ${matchingRows} visible / ${depth} / c${concurrency}: ${result.p95Ms?.toFixed(2)}ms p95\n`,
            );
          }
        }
      }
    }
    report["completedAt"] = new Date().toISOString();
    const output = resolve(values.output ?? ".supertag/benchmarks/history.json");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Report: ${output}\n`);
  } finally {
    await Promise.all(stores.map((store) => store.disconnect()));
    await fixture?.end();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
}
