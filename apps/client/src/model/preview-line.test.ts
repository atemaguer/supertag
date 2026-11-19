import { expect, it } from "vitest";
import { previewLine } from "./preview-line";

it("previews a message's first line as plain text", () => {
  expect(
    previewLine(
      "The repository contains [README.md](README.md), with the heading “demo.”\nMore below.",
    ),
  ).toBe("The repository contains README.md, with the heading “demo.”");
  expect(previewLine("## **Done**: tests pass in `cargo test`")).toBe(
    "Done: tests pass in cargo test",
  );
  expect(previewLine("- [x] Ran *the* checks")).toBe("Ran the checks");
  expect(previewLine("\n```bash\nnpm test\n```")).toBe("npm test");
  expect(previewLine("snake_case_name stays")).toBe("snake_case_name stays");
  expect(previewLine("Created [hello.txt](/private/tmp/home/.supertag/hosts/slots/out")).toBe(
    "Created hello.txt",
  );
  expect(previewLine("")).toBe("");
});
