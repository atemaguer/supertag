import { expect, it } from "vitest";
import { validateArtifactPath } from "./artifact-catalog.js";

it.each([0x3164, 0xffa0, 0x115f, 0x1160, 0x2800, 0x034f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef])(
  "rejects invisible artifact path character U+%s",
  (codepoint) => {
    expect(() =>
      validateArtifactPath(`reports/a${String.fromCodePoint(codepoint)}b.txt`),
    ).toThrow();
  },
);

it.each(["reports/my file.txt", "résumé/日本語.txt", "reports/visible.txt", "reports/😀.txt"])(
  "preserves visible artifact path %s",
  (path) => expect(validateArtifactPath(path)).toBe(path),
);

it.each([
  "reports/a\ud800b.txt",
  "reports/a\udfffb.txt",
  "reports/a\u17b4b.txt",
  "reports/a\u0378b.txt",
  "reports/a\ue000b.txt",
  "reports/a\u{f0000}b.txt",
  "re\u0301sume\u0301.txt",
])("rejects ignorable, unassigned, private-use or non-NFC path %s", (path) => {
  expect(() => validateArtifactPath(path)).toThrow();
});
