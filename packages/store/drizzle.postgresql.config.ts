import { defineConfig } from "drizzle-kit";

const configuredUrl = process.env["SUPERTAG_DATABASE_URL"];
const url =
  configuredUrl?.startsWith("postgresql:") || configuredUrl?.startsWith("postgres:")
    ? configuredUrl
    : (process.env["SUPERTAG_POSTGRES_URL"] ??
      "postgresql://supertag:supertag@localhost:54329/supertag");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/postgresql.ts",
  out: "./drizzle/postgresql",
  dbCredentials: { url },
  strict: true,
});
