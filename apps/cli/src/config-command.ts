import { parseArgs } from "node:util";
import { loadServicesFile, renderServicesFile, SUPERTAG_YAML } from "./supertag-yaml.js";

export async function runConfigCommand(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(configHelp());
    return 0;
  }
  const { values } = parseArgs({
    args,
    options: {
      file: { type: "string", short: "f", multiple: true },
      services: { type: "boolean" },
    },
    strict: true,
  });
  const resolved = await loadServicesFile({ files: values.file ?? [] });
  if (values.services === true) {
    for (const service of resolved.services) process.stdout.write(`${service.name}\n`);
    return 0;
  }
  process.stdout.write(renderServicesFile(resolved));
  return 0;
}

export function configHelp(): string {
  return `Usage:
  supertag config [-f PATH...] [--services]

Prints the resolved ${SUPERTAG_YAML}: every -f file merged in order, variables interpolated,
defaults filled in, and environment overrides applied. Values that came from the environment
are marked with a comment. Secrets appear as <secret: NAME>; their values are never read or
printed. Exits non-zero, listing every problem with its file:line:column, when the file is
invalid.

Without -f, config reads ~/.supertag/${SUPERTAG_YAML} (or $SUPERTAG_STATE_DIR/${SUPERTAG_YAML}); without
that file it prints the defaults: one control-plane service.

  -f, --file PATH   A ${SUPERTAG_YAML}, or a directory holding one; repeat to merge files
  --services        List the service names only
`;
}
