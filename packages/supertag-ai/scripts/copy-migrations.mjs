import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../store/drizzle", import.meta.url));
const destination = fileURLToPath(new URL("../drizzle", import.meta.url));
const specificationSource = fileURLToPath(new URL("../../../spec", import.meta.url));
const specificationDestination = fileURLToPath(new URL("../dist/spec", import.meta.url));

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await rm(specificationDestination, { recursive: true, force: true });
await cp(specificationSource, specificationDestination, { recursive: true });

// Ship user documentation with the matching binary. Deliberately ignored internal
// architecture/product briefs are not release artifacts.
const docsSource = fileURLToPath(new URL("../../../docs", import.meta.url));
const docsDestination = fileURLToPath(new URL("../dist/docs", import.meta.url));
await rm(docsDestination, { recursive: true, force: true });
await cp(docsSource, docsDestination, {
  recursive: true,
  filter: (path) => !/(?:architecture|product-brief).*\.md$/u.test(path),
});
