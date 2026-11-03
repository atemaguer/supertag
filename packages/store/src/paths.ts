import { homedir } from "node:os";
import { resolve } from "node:path";

export function invocationDirectory(): string {
  const initialDirectory = process.env["INIT_CWD"]?.trim();
  return initialDirectory === undefined || initialDirectory.length === 0
    ? process.cwd()
    : initialDirectory;
}

export function stateDirectory(): string {
  const configured = process.env["SUPERTAG_STATE_DIR"]?.trim();
  return configured === undefined || configured.length === 0
    ? resolve(homedir(), ".supertag")
    : resolve(invocationDirectory(), configured);
}

export function defaultSqliteUrl(): string {
  return `file:${resolve(stateDirectory(), "supertag.db")}`;
}
