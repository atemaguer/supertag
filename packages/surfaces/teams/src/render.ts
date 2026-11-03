import {
  parseSurfaceMarkdown,
  type SurfaceMarkdownDocument,
  type SurfacePresentation,
  serializeSurfaceMarkdown,
} from "@supertag/surface-sdk";

export interface TeamsMarkdownActivity {
  readonly type: "message";
  readonly text: string;
  readonly textFormat: "markdown";
}

/** Adapts canonical Markdown to the subset supported by Teams text activities. */
export function renderTeamsPresentation(presentation: SurfacePresentation): TeamsMarkdownActivity {
  const document = parseSurfaceMarkdown(presentation.markdown);
  adaptTeamsDocument(document);
  return {
    type: "message",
    text: serializeSurfaceMarkdown(document),
    textFormat: "markdown",
  };
}

function adaptTeamsDocument(document: SurfaceMarkdownDocument): void {
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
