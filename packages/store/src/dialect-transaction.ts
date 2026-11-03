import type { DatabaseProvider } from "@supertag/core";

/** A yielded Drizzle query, never an arbitrary asynchronous side effect. */
type TransactionQuery = { all(): unknown } | PromiseLike<unknown>;

// The dialect-specific Drizzle transaction types differ; keep their adaptation here.
// biome-ignore lint/suspicious/noExplicitAny: Existing stores use both Drizzle dialects.
type Transaction = any;
// biome-ignore lint/suspicious/noExplicitAny: Each query supplies its own result to the generator.
type TransactionFlow<T> = Generator<TransactionQuery, T, any>;
interface SqliteTransactionDatabase {
  transaction<T>(work: (tx: Transaction) => T, options?: { behavior: "immediate" }): T;
}

interface PostgresTransactionDatabase {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
type TransactionDatabase = SqliteTransactionDatabase | PostgresTransactionDatabase;

/**
 * Runs one domain transaction in either dialect. SQLite must consume every query
 * synchronously before its callback returns; PostgreSQL awaits each query before
 * advancing. Write flows use an immediate SQLite transaction to serialize reads
 * that decide subsequent writes. Callers must yield queries, not perform I/O.
 */
export async function runDialectTransaction<T>(
  db: TransactionDatabase,
  provider: DatabaseProvider,
  work: (tx: Transaction) => TransactionFlow<T>,
): Promise<T> {
  if (provider === "sqlite") {
    return (db as SqliteTransactionDatabase).transaction(
      (tx) => {
        const flow = work(tx);
        let step = flow.next();
        while (!step.done) {
          if (!("all" in step.value)) {
            throw new Error("SQLite transactions must yield synchronous Drizzle queries");
          }
          step = flow.next(step.value.all());
        }
        return step.value;
      },
      { behavior: "immediate" },
    );
  }
  return (db as PostgresTransactionDatabase).transaction(async (tx) => {
    const flow = work(tx);
    let step = flow.next();
    while (!step.done) step = flow.next(await step.value);
    return step.value;
  });
}
