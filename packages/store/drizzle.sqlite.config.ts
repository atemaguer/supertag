import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const configuredUrl = process.env["SUPERTAG_DATABASE_URL"];
const url = configuredUrl?.startsWith("file:")
  ? configuredUrl.slice("file:".length)
  : resolve(homedir(), ".supertag", "supertag.db");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/sqlite.ts",
  out: "./drizzle/sqlite",
  dbCredentials: { url },
  strict: true,
});
