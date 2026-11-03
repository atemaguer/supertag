import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkMigrationJournal } from "./check-migration-journals.mjs";

test("migration journal and SQL files agree in both directions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supertag-migration-check-"));
  const url = pathToFileURL(`${dir}/`);
  try {
    await mkdir(`${dir}/meta`);
    await writeFile(
      `${dir}/meta/_journal.json`,
      JSON.stringify({ entries: [{ tag: "0000_base" }] }),
    );
    await assert.rejects(checkMigrationJournal(url), /missing: 0000_base.sql/);
    await writeFile(`${dir}/0000_base.sql`, "select 1;");
    await checkMigrationJournal(url);
    await writeFile(`${dir}/0001_orphan.sql`, "select 2;");
    await assert.rejects(checkMigrationJournal(url), /unlisted: 0001_orphan.sql/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
