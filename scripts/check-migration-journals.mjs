import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function checkMigrationJournal(directory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", directory), "utf8"));
  const tags = journal.entries.map((entry) => entry.tag);
  const expected = new Set(tags.map((tag) => `${tag}.sql`));
  const unexpected = files.filter((file) => !expected.has(file));
  const missing = [...expected].filter((file) => !files.includes(file));
  const duplicate = tags.filter((tag, index) => tags.indexOf(tag) !== index);
  if (unexpected.length || missing.length || duplicate.length) {
    throw new Error(
      `${fileURLToPath(directory)}: migration journal mismatch; unlisted: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}; duplicate tags: ${duplicate.join(", ") || "none"}`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const dialect of ["sqlite", "postgresql"])
    await checkMigrationJournal(new URL(`../packages/store/drizzle/${dialect}/`, import.meta.url));
}
