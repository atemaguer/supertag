import {
  parseSurfaceMarkdown,
  type SurfaceMarkdownDocument,
  type SurfaceMarkdownNode,
  type SurfacePresentation,
} from "@supertag/surface-sdk";

const MAX_SLACK_TEXT_CHARACTERS = 39_000;
const MAX_SLACK_TABLE_CELL_CHARACTERS = 36;

export interface SlackRenderedPresentation {
  readonly text: string;
  readonly mrkdwn: true;
  readonly unfurl_links: false;
  readonly unfurl_media: false;
}

interface SlackRenderContext {
  readonly definitions: ReadonlyMap<string, { readonly url: string }>;
}

/** Parses canonical Markdown once, then renders its AST into Slack's mrkdwn dialect. */
export function renderSlackMarkdown(markdown: string): string {
  const normalized = requiredMarkdown(markdown);
  const rendered = renderSlackDocument(parseSurfaceMarkdown(normalized));
  if (Array.from(rendered).length <= MAX_SLACK_TEXT_CHARACTERS) return rendered;

  const characters = Array.from(normalized);
  let low = 0;
  let high = characters.length;
  let best = "…";
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidateSource = `${characters.slice(0, midpoint).join("").trimEnd()}…`;
    const candidate = renderSlackDocument(parseSurfaceMarkdown(candidateSource));
    if (Array.from(candidate).length <= MAX_SLACK_TEXT_CHARACTERS) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function renderSlackPresentation(
  presentation: SurfacePresentation,
): SlackRenderedPresentation {
  return {
    text: renderSlackMarkdown(presentation.markdown),
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };
}

export function renderSlackDocument(document: SurfaceMarkdownDocument): string {
  const definitions = new Map<string, { readonly url: string }>();
  for (const node of document.children) {
    if (node.type === "definition") definitions.set(node.identifier, { url: node.url });
  }
  return renderBlocks(document.children, { definitions }).trim();
}

export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function renderBlocks(nodes: readonly SurfaceMarkdownNode[], context: SlackRenderContext): string {
  return nodes
    .map((node) => renderSlackNode(node, context))
    .filter(Boolean)
    .join("\n\n");
}

function renderSlackNode(node: SurfaceMarkdownNode, context: SlackRenderContext): string {
  switch (node.type) {
    case "root":
      return renderBlocks(node.children, context);
    case "text":
      return escapeSlackText(node.value);
    case "paragraph":
      return renderInlines(node.children, context);
    case "heading":
      return `*${renderInlines(node.children, context)}*`;
    case "strong":
      return `*${renderInlines(node.children, context)}*`;
    case "emphasis":
      return `_${renderInlines(node.children, context)}_`;
    case "delete":
      return `~${renderInlines(node.children, context)}~`;
    case "inlineCode":
      return `\`${escapeSlackText(node.value).replace(/`/gu, "ˋ")}\``;
    case "code":
      // Slack has no syntax-highlighting fence qualifier; including it renders
      // the language identifier as the first line of the code block.
      return `\`\`\`\n${escapeSlackText(node.value)}\n\`\`\``;
    case "break":
      return "\n";
    case "thematicBreak":
      return "────────";
    case "blockquote":
      return prefixLines(renderBlocks(node.children, context), "> ");
    case "list":
      return renderSlackList(node, context);
    case "listItem":
      return renderBlocks(node.children, context);
    case "link":
      return renderSlackLink(node.url, plainText(node.children));
    case "image":
      return renderSlackLink(node.url, `Image: ${node.alt || "image"}`);
    case "linkReference": {
      const definition = context.definitions.get(node.identifier);
      const label = plainText(node.children);
      return definition === undefined
        ? escapeSlackText(label)
        : renderSlackLink(definition.url, label);
    }
    case "imageReference": {
      const definition = context.definitions.get(node.identifier);
      const label = `Image: ${node.alt || "image"}`;
      return definition === undefined
        ? escapeSlackText(label)
        : renderSlackLink(definition.url, label);
    }
    case "table":
      return renderSlackTable(node);
    case "tableRow":
      return node.children.map((cell) => renderSlackNode(cell, context)).join(" | ");
    case "tableCell":
      return renderInlines(node.children, context);
    case "html":
      return escapeSlackText(node.value);
    case "definition":
    case "footnoteDefinition":
      return "";
    case "footnoteReference":
      return `[^${escapeSlackText(node.identifier)}]`;
    default:
      return fallbackNodeText(node, context);
  }
}

function renderSlackTable(node: Extract<SurfaceMarkdownNode, { readonly type: "table" }>): string {
  const rows = node.children.map((row) =>
    row.children.map((cell) => truncateTableCell(normalizeTableCell(plainText(cell.children)))),
  );
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(3, ...rows.map((row) => unicodeLength(row[column] ?? ""))),
  );
  const renderRow = (row: readonly string[]) =>
    widths
      .map((width, column) => padUnicode(row[column] ?? "", width))
      .join("  ")
      .trimEnd();
  const [header, ...body] = rows;
  const lines = [
    ...(header === undefined
      ? []
      : [renderRow(header), widths.map((width) => "-".repeat(width)).join("  ")]),
    ...body.map(renderRow),
  ];
  return `\`\`\`\n${escapeSlackText(lines.join("\n"))}\n\`\`\``;
}

function normalizeTableCell(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateTableCell(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_SLACK_TABLE_CELL_CHARACTERS) return value;
  return `${characters.slice(0, MAX_SLACK_TABLE_CELL_CHARACTERS - 1).join("")}…`;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function padUnicode(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - unicodeLength(value)))}`;
}

function renderInlines(nodes: readonly SurfaceMarkdownNode[], context: SlackRenderContext): string {
  return nodes.map((node) => renderSlackNode(node, context)).join("");
}

function renderSlackList(
  node: Extract<SurfaceMarkdownNode, { readonly type: "list" }>,
  context: SlackRenderContext,
): string {
  const start = node.start ?? 1;
  return node.children
    .map((item, index) => {
      const marker = node.ordered ? `${start + index}.` : "•";
      const checked = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
      const content = renderBlocks(item.children, context);
      return `${marker} ${checked}${indentContinuation(content)}`;
    })
    .join("\n");
}

function renderSlackLink(url: string, label: string): string {
  if (!safeSlackLink(url)) {
    return `${escapeSlackText(label)} (${escapeSlackText(url)})`;
  }
  return `<${url}|${escapeSlackText(label)}>`;
}

function safeSlackLink(value: string): boolean {
  if (/[|<>\r\n]/u.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function plainText(nodes: readonly SurfaceMarkdownNode[]): string {
  return nodes.map(plainNodeText).join("");
}

function plainNodeText(node: SurfaceMarkdownNode): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("children" in node && Array.isArray(node.children)) {
    return plainText(node.children as readonly SurfaceMarkdownNode[]);
  }
  return "";
}

function fallbackNodeText(node: SurfaceMarkdownNode, context: SlackRenderContext): string {
  if ("value" in node && typeof node.value === "string") return escapeSlackText(node.value);
  if ("children" in node && Array.isArray(node.children)) {
    return renderInlines(node.children as readonly SurfaceMarkdownNode[], context);
  }
  return "";
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function indentContinuation(text: string): string {
  const [first = "", ...rest] = text.split("\n");
  return [first, ...rest.map((line) => `  ${line}`)].join("\n");
}

function requiredMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) throw new Error("A Slack presentation cannot be empty");
  return normalized;
}
