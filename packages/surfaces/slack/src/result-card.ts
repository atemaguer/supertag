import { cardToBlockKit, type SlackBlock, type SlackCardElement } from "@chat-adapter/slack/blocks";
import { toCard } from "@json-render/chat";
import { isGitHubPullRequestUrl, type SurfaceResultCard } from "@supertag/surface-sdk";
import { escapeSlackText } from "./render.js";

type CardSpec = Parameters<typeof toCard>[0];

/**
 * Renders a work Session result card into Slack Block Kit through a small fixed json-render
 * schema. Returns undefined when there is no delivery data; throws when rendering fails.
 */
export function renderSlackResultCardBlocks(
  data: SurfaceResultCard | undefined,
): SlackBlock[] | undefined {
  if (data === undefined) return undefined;
  const elements: CardSpec["elements"] = {};
  const children: string[] = [];
  if (data.branch !== undefined) {
    elements["branch"] = {
      type: "Field",
      props: { label: "Branch", value: escapeSlackText(data.branch) },
    };
    elements["fields"] = { type: "Fields", props: {}, children: ["branch"] };
    children.push("fields");
  }
  if (isGitHubPullRequestUrl(data.pullRequestUrl)) {
    elements["pr"] = {
      type: "LinkButton",
      props: { label: "Pull request", url: data.pullRequestUrl },
    };
    elements["actions"] = { type: "Actions", props: {}, children: ["pr"] };
    children.push("actions");
  }
  if (children.length === 0) return undefined;
  elements["card"] = { type: "Card", props: { title: "Work Session result" }, children };
  // Both libraries share the Chat SDK card model; their published optional-property types
  // differ only under exactOptionalPropertyTypes.
  return cardToBlockKit(toCard({ root: "card", elements }) as SlackCardElement);
}
