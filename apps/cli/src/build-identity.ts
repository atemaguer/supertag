import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A content identity for the code this CLI and its local services run. */
export function digestCode(roots: readonly string[]): string {
  const hash = createHash("sha256");
  const visit = (root: string, directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (["node_modules", "dist", "target", ".git"].includes(entry.name) && directory !== root)
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(root, path);
      else if (
        entry.isFile() &&
        /\.[cm]?[jt]s$/u.test(entry.name) &&
        !/\.(?:test|spec|d)\.[cm]?[jt]s$/u.test(entry.name)
      ) {
        hash.update(relative(root, path));
        hash.update("\0");
        hash.update(readFileSync(path));
      }
    }
  };
  for (const root of roots) if (existsSync(root)) visit(root, root);
  return hash.digest("hex").slice(0, 16);
}

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, "../../..");
/** Built workspace packages can change independently of the CLI output. */
export function builtCheckoutRoots(checkoutRoot: string): string[] {
  const roots = [join(checkoutRoot, "apps/cli/dist")];
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name?.startsWith("@supertag/")) roots.push(join(directory, "dist"));
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") visit(join(directory, entry.name));
    }
  };
  visit(join(checkoutRoot, "packages"));
  return roots;
}
/** Fixed when this process starts, even if files change while it runs. */
export const SUPERTAG_BUILD_IDENTITY =
  resolve(here) === resolve(join(checkout, "apps/cli/src"))
    ? digestCode([join(checkout, "apps"), join(checkout, "packages")])
    : resolve(here) === resolve(join(checkout, "apps/cli/dist"))
      ? digestCode(builtCheckoutRoots(checkout))
      : digestCode([here]);
