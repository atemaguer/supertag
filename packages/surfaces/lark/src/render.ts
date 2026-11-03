import {
  parseSurfaceMarkdown,
  type SurfaceMarkdownDocument,
  type SurfacePresentation,
  serializeSurfaceMarkdown,
} from "@supertag/surface-sdk";

const MAX_LARK_MARKDOWN_CHARACTERS = 24_000;
const MAX_LARK_ELEMENT_CHARACTERS = 4_000;

export interface LarkMarkdownCard {
  readonly config: { readonly wide_screen_mode: true };
  readonly header: {
    readonly template: "blue" | "green" | "grey" | "red";
    readonly title: { readonly tag: "plain_text"; readonly content: string };
  };
  readonly elements: readonly {
    readonly tag: "div";
    readonly text: { readonly tag: "lark_md"; readonly content: string };
  }[];
}

/** Renders canonical Markdown as a Lark/Feishu interactive card using lark_md elements. */
export function renderLarkPresentation(presentation: SurfacePresentation): LarkMarkdownCard {
  const markdown = normalizeLarkMarkdown(presentation.markdown);
  const appearance = larkAppearance(presentation.kind);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: appearance.template,
      title: { tag: "plain_text", content: appearance.title },
    },
    elements: splitLarkMarkdown(markdown).map((content) => ({
      tag: "div",
      text: { tag: "lark_md", content },
    })),
  };
}

function normalizeLarkMarkdown(markdown: string): string {
  const document = parseSurfaceMarkdown(markdown);
  adaptLarkDocument(document);
  const normalized = serializeSurfaceMarkdown(document);
  return truncateUnicode(normalized, MAX_LARK_MARKDOWN_CHARACTERS);
}

function adaptLarkDocument(document: SurfaceMarkdownDocument): void {
  adaptNode(document);
}

function adaptNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) adaptNode(child);
    return;
  }
  if (!isNode(value)) return;

  if (value.type === "heading") {
    const children = Array.isArray(value["children"]) ? value["children"] : [];
    value.type = "paragraph";
    value["children"] = [{ type: "strong", children }];
  } else if (value.type === "table") {
    const table = serializeSurfaceMarkdown({
      type: "root",
      children: [value as SurfaceMarkdownDocument["children"][number]],
    });
    value.type = "code";
    value["value"] = table;
    delete value["children"];
    delete value["align"];
  } else if (value.type === "html") {
    // Harness output cannot synthesize native Lark mention tags.
    value.type = "text";
    value["value"] = escapeNativeSyntax(typeof value["value"] === "string" ? value["value"] : "");
  }

  for (const child of Object.values(value)) adaptNode(child);
}

function isNode(value: unknown): value is Record<string, unknown> & { type: string } {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

function escapeNativeSyntax(value: string): string {
  return value.replaceAll("<", "‹").replaceAll(">", "›");
}

function splitLarkMarkdown(markdown: string): readonly string[] {
  const chunks: string[] = [];
  let remaining = markdown;
  while (Array.from(remaining).length > MAX_LARK_ELEMENT_CHARACTERS) {
    const characters = Array.from(remaining);
    const candidate = characters.slice(0, MAX_LARK_ELEMENT_CHARACTERS).join("");
    const paragraph = candidate.lastIndexOf("\n\n");
    const line = candidate.lastIndexOf("\n");
    const splitAt = paragraph > 0 ? paragraph : line > 0 ? line : candidate.length;
    chunks.push(candidate.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function larkAppearance(kind: SurfacePresentation["kind"]): {
  readonly template: LarkMarkdownCard["header"]["template"];
  readonly title: string;
} {
  if (kind === "acknowledgement") return { template: "grey", title: "SuperTag is working" };
  if (kind === "status") return { template: "blue", title: "SuperTag status" };
  if (kind === "error") return { template: "red", title: "SuperTag could not complete the task" };
  return { template: "green", title: "SuperTag" };
}

function truncateUnicode(text: string, maxCharacters: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  return `${characters
    .slice(0, maxCharacters - 1)
    .join("")
    .trimEnd()}…`;
}
