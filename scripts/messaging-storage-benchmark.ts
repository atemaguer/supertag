import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, availableParallelism, cpus, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string" },
    repeats: { type: "string" },
    concurrency: { type: "string" },
    scenarios: { type: "string" },
    stores: { type: "string" },
    warmup: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: node --conditions=development --import tsx scripts/messaging-storage-benchmark.ts [--iterations 300] [--repeats 3] [--concurrency 1,8,32] [--warmup 30] [--stores 1,4] [--scenarios mailbox-hot,mailbox-distributed,posts-hot-stream,posts-same-objective,posts-independent-objectives] --output report.json\nRequires SUPERTAG_POSTGRES_URL with CREATEDB; creates and drops a private benchmark database.\n",
  );
} else await main();
function integer(value: string | undefined, fallback: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Expected integer 1–${max}`);
  return n;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function distribution(samples: number[]) {
  const ordered = [...samples].sort((a, b) => a - b);
  const quantile = (p: number) => ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)] ?? null;
  return { n: ordered.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95), p99Ms: quantile(0.99) };
}
async function parallel(n: number, concurrency: number, operation: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, concurrency) }, async () => {
      while (next < n) {
        const i = next++;
        await operation(i);
      }
    }),
  );
}
async function main() {
  const source = process.env["SUPERTAG_POSTGRES_URL"];
  if (!source) throw new Error("SUPERTAG_POSTGRES_URL required");
  const iterations = integer(values.iterations, 300, 10000),
    repeats = integer(values.repeats, 3, 20),
    warmup = integer(values.warmup, 30, 1000);
  const concurrencies = (values.concurrency ?? "1,8,32")
    .split(",")
    .map((value) => integer(value, 1, 64));
  const availableScenarios = [
    "mailbox-hot",
    "mailbox-distributed",
    "posts-hot-stream",
    "posts-same-objective",
    "posts-independent-objectives",
  ];
  const scenarios =
    values.scenarios === undefined ? availableScenarios : values.scenarios.split(",");
  if (
    !scenarios.length ||
    scenarios.some((name) => !availableScenarios.includes(name)) ||
    new Set(scenarios).size !== scenarios.length
  )
    throw new Error(`scenarios must be distinct names from ${availableScenarios.join(",")}`);
  const storeInstances = (values.stores ?? "1,4").split(",").map((value) => Number(value));
  if (
    !storeInstances.length ||
    storeInstances.some((count) => count !== 1 && count !== 4) ||
    new Set(storeInstances).size !== storeInstances.length
  )
    throw new Error("stores must be 1, 4, or 1,4");
  const Pool = createRequire(new URL("../packages/store/package.json", import.meta.url))("pg")
    .Pool as new (input: {
    connectionString: string;
    max: number;
  }) => {
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  };
  const database = `supertag_bench_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: source, max: 1 });
  const stores: DrizzleStore[] = [];
  let created = false;
  const startedAt = new Date().toISOString();
  const reports: unknown[] = [];
  let unexpectedErrors = 0;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const privateUrl = new URL(source);
    privateUrl.pathname = `/${database}`;
    await migrateDatabase({ url: privateUrl.toString() });
    for (let i = 0; i < 4; i++) {
      const store = new DrizzleStore({ url: privateUrl.toString() });
      await store.connect();
      stores.push(store);
    }
    const primary = required(stores[0]);
    const metadata = new Pool({ connectionString: privateUrl.toString(), max: 1 });
    let databaseVersion: unknown;
    try {
      databaseVersion = (await metadata.query("SELECT version() AS version")).rows[0]?.["version"];
    } finally {
      await metadata.end();
    }
    const sender = await primary.createTag({ name: `sender-${randomUUID()}` });
    const recipients = await Promise.all(
      Array.from({ length: 32 }, () => primary.createTag({ name: randomUUID() })),
    );
    const credentials = await Promise.all(
      recipients.map(async (tag) => {
        const id = randomUUID();
        await primary.createTagMailboxCredential({
          id,
          tagId: tag.id,
          tokenHash: randomUUID(),
          createdAt: new Date().toISOString(),
        });
        await primary.setTagMessagingGrant({
          senderTagId: sender.id,
          recipientTagId: tag.id,
          messageTypes: ["progress.updated"],
        });
        return id;
      }),
    );
    const objective = await primary.createObjective({
      id: randomUUID(),
      ownerTagId: sender.id,
      outcome: "Benchmark",
    });
    const payload = "x".repeat(1024);
    async function measure(
      name: string,
      instances: number,
      concurrency: number,
      operation: (i: number, store: DrizzleStore, admissions: number[]) => Promise<void>,
    ) {
      if (!scenarios.includes(name)) return;
      for (let repeat = 0; repeat < repeats; repeat++) {
        await parallel(warmup, concurrency, (i) =>
          operation(i, required(stores[i % instances]), []),
        );
        const cycles: number[] = [],
          admissions: number[] = [],
          errors: string[] = [];
        const start = performance.now();
        await parallel(iterations, concurrency, async (i) => {
          const at = performance.now();
          try {
            await operation(i, required(stores[i % instances]), admissions);
            cycles.push(performance.now() - at);
          } catch (error) {
            errors.push(String(error));
            unexpectedErrors++;
          }
        });
        const elapsedMs = performance.now() - start;
        const result = {
          name,
          storeInstances: instances,
          concurrency,
          repeat: repeat + 1,
          n: iterations,
          elapsedMs,
          operationsPerSecond: (cycles.length / elapsedMs) * 1000,
          cycle: distribution(cycles),
          admission: distribution(admissions),
          totalErrors: errors.length,
          errors: errors.slice(0, 10),
        };
        reports.push(result);
        process.stdout.write(
          `${name} stores=${instances} c=${concurrency} repeat=${repeat + 1}: ${result.operationsPerSecond.toFixed(1)} ops/s errors=${errors.length}\n`,
        );
      }
    }
    for (const instances of storeInstances)
      for (const concurrency of concurrencies)
        for (const recipientCount of [1, 32]) {
          await measure(
            `mailbox-${recipientCount === 1 ? "hot" : "distributed"}`,
            instances,
            concurrency,
            async (i, store, admissions) => {
              const index = i % recipientCount,
                tag = required(recipients[index]),
                credentialId = required(credentials[index]);
              const at = performance.now();
              await store.enqueueTagMessage({
                senderTagId: sender.id,
                recipientTagId: tag.id,
                objectiveId: objective.id,
                type: "progress.updated",
                body: { payload },
                idempotencyKey: randomUUID(),
              });
              admissions.push(performance.now() - at);
              let delivery: Awaited<ReturnType<DrizzleStore["claimTagMessage"]>>;
              for (let attempt = 0; attempt < 100 && !delivery; attempt++)
                delivery = await store.claimTagMessage({
                  tagId: tag.id,
                  credentialId,
                  now: new Date().toISOString(),
                  leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
                });
              if (!delivery) throw new Error("No delivery after successful admission");
              if (
                !(await store.settleTagMessage({
                  tagId: tag.id,
                  credentialId,
                  messageId: delivery.message.id,
                  leaseToken: delivery.leaseToken,
                  now: new Date().toISOString(),
                  status: "processed",
                }))
              )
                throw new Error("Acknowledgement rejected");
            },
          );
        }
    const burstTag = required(recipients[0]),
      burstCredential = required(credentials[0]);
    const burst = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        required(stores[i % 4])
          .enqueueTagMessage({
            senderTagId: sender.id,
            recipientTagId: burstTag.id,
            objectiveId: objective.id,
            type: "progress.updated",
            body: { payload },
            idempotencyKey: randomUUID(),
          })
          .then(
            () => "admitted",
            (error) =>
              (error as { statusCode?: number }).statusCode === 429
                ? "bounded"
                : `unexpected:${String(error)}`,
          ),
      ),
    );
    let drained = 0;
    while (true) {
      const delivery = await primary.claimTagMessage({
        tagId: burstTag.id,
        credentialId: burstCredential,
        now: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      if (!delivery) break;
      if (
        await primary.settleTagMessage({
          tagId: burstTag.id,
          credentialId: burstCredential,
          messageId: delivery.message.id,
          leaseToken: delivery.leaseToken,
          now: new Date().toISOString(),
          status: "processed",
        })
      )
        drained++;
    }
    const boundedBurst = {
      n: 120,
      admitted: burst.filter((x) => x === "admitted").length,
      bounded429: burst.filter((x) => x === "bounded").length,
      drained,
      unexpectedErrors: burst.filter((x) => x.startsWith("unexpected:")).length,
    };
    if (
      boundedBurst.admitted !== 100 ||
      boundedBurst.bounded429 !== 20 ||
      drained !== 100 ||
      boundedBurst.unexpectedErrors
    )
      unexpectedErrors++;
    // Every Team has one channel whose ID is the Team ID; the sender leads, so it may post.
    const sameStreams = await Promise.all(
      Array.from({ length: 32 }, () =>
        primary.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Benchmark",
          leadTagId: sender.id,
          memberTagIds: [],
        }),
      ),
    );
    const separateStreams = await Promise.all(
      Array.from({ length: 32 }, async () => {
        const o = await primary.createObjective({
          id: randomUUID(),
          ownerTagId: sender.id,
          outcome: "Independent",
        });
        return primary.createTeam({
          id: randomUUID(),
          objectiveId: o.id,
          name: "Independent",
          leadTagId: sender.id,
          memberTagIds: [],
        });
      }),
    );
    for (const instances of storeInstances)
      for (const concurrency of concurrencies)
        for (const scope of ["hot-stream", "same-objective", "independent-objectives"] as const)
          await measure(`posts-${scope}`, instances, concurrency, async (i, store) => {
            const stream = required(
              (scope === "independent-objectives" ? separateStreams : sameStreams)[
                scope === "hot-stream" ? 0 : i % 32
              ],
            );
            await store.postWorkstream({
              workstreamId: stream.id,
              authorTagId: sender.id,
              body: payload,
              idempotencyKey: randomUUID(),
            });
          });
    const output = resolve(values.output ?? `.supertag/benchmarks/messaging-${Date.now()}.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          startedAt,
          finishedAt: new Date().toISOString(),
          environment: {
            node: process.version,
            databaseVersion,
            cpu: cpus()[0]?.model,
            availableParallelism: availableParallelism(),
            platform: platform(),
            arch: arch(),
          },
          configuration: {
            iterations,
            repeats,
            warmup,
            concurrencies,
            payloadBytes: 1024,
            storeInstances,
            scenarios,
            boundedBurstAlwaysRuns: true,
          },
          measurement:
            "Mailbox cycle measures one enqueue plus one successful claim/ack; a concurrent cycle may claim another cycle's message. This is store throughput, not Gateway or model throughput. Warmup excluded. No provider calls.",
          boundedBurst,
          unexpectedErrors,
          cases: reports,
        },
        null,
        2,
      ),
    );
    process.stdout.write(`Report: ${output}\n`);
    if (unexpectedErrors) process.exitCode = 1;
  } finally {
    for (const store of stores.reverse()) await store.disconnect();
    try {
      if (created) await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
    }
  }
}
