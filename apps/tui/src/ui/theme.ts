/**
 * The terminal UI's colours and the syntax style of Markdown and code. OpenTUI's imports stay in
 * `src/ui/`, so an OpenTUI upgrade that changes them touches this directory.
 */
import { type CliRenderer, RGBA, SyntaxStyle } from "@opentui/core";

export const color = {
  text: "#d0d0d0",
  strong: "#ffffff",
  muted: "#8a8a8a",
  faint: "#5f5f5f",
  accent: "#8aa4ff",
  you: "#a6d189",
  border: "#444444",
  focus: "#8aa4ff",
  selected: "#2a2f45",
  warning: "#e5c07b",
  error: "#f07178",
} as const;

/** The style, owned by the renderer's native scene. */
export function syntaxStyle(renderer: CliRenderer): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      keyword: { fg: RGBA.fromHex("#c792ea"), bold: true },
      string: { fg: RGBA.fromHex("#c3e88d") },
      comment: { fg: RGBA.fromHex("#868e96"), italic: true },
      number: { fg: RGBA.fromHex("#f78c6c") },
      function: { fg: RGBA.fromHex("#82aaff") },
      type: { fg: RGBA.fromHex("#ffcb6b") },
      "markup.heading": { fg: RGBA.fromHex("#82aaff"), bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.raw": { fg: RGBA.fromHex("#f78c6c") },
      "markup.link": { fg: RGBA.fromHex("#89ddff"), underline: true },
      "markup.list": { fg: RGBA.fromHex("#8aa4ff") },
      default: { fg: RGBA.fromHex(color.text) },
    },
    // biome-ignore lint/style/noNonNullAssertion: a renderer always has its native scene.
    renderer.nativeScene!,
  );
}
