import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const directory = process.argv[2];
const stage = process.argv[3];
if (!directory || !stage) throw new Error("Journal crash fixture requires directory and stage");
async function pause(at: string) {
  if (stage !== at) return;
  process.send?.({ stage: at });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const originalLink = fs.link;
fs.link = async (...args) => {
  if (basename(String(args[1])) === "acquiring.lock") await pause("before-guard");
  await originalLink(...args);
  if (basename(String(args[1])) === "acquiring.lock") await pause("guard-linked");
};
const originalRename = fs.rename;
fs.rename = async (...args) => {
  if (basename(String(args[1])) === "owner.lock") await pause("before-owner-publish");
  await originalRename(...args);
  if (basename(String(args[1])) === "owner.lock") await pause("owner-published");
};
const originalRm = fs.rm;
fs.rm = async (...args) => {
  await originalRm(...args);
  if (basename(String(args[0])) === "acquiring.lock") await pause("guard-removed");
};
syncBuiltinESMExports();
const { FileAttemptJournal } = await import("../../packages/runtime/sdk/src/durable-worklet.js");
const journal = new FileAttemptJournal(directory);
await journal.initialize();
throw new Error("Crash fixture did not reach its requested stage");
