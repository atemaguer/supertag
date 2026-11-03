import { describe, expect, it } from "vitest";
import { hostMcpToolServers } from "./src/host-mcp.ts";

describe("GitHub and Slack MCP presets", () => {
  it("uses the official remote endpoints and maps every former built-in tool", () => {
    const servers = hostMcpToolServers({
      github: { url: "https://api.githubcopilot.com/mcp/", preset: "github" },
      slack: { url: "https://mcp.slack.com/mcp", preset: "slack" },
    });
    expect(servers.github?.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(servers.slack?.url).toBe("https://mcp.slack.com/mcp");
    expect(Object.keys(servers.github?.resources?.tools ?? {}).sort()).toEqual([
      "add_issue_comment",
      "create_branch",
      "create_pull_request",
      "get_file_contents",
      "issue_read",
      "merge_pull_request",
      "pull_request_read",
    ]);
    expect(Object.keys(servers.slack?.resources?.tools ?? {}).sort()).toEqual([
      "slack_read_channel",
      "slack_read_thread",
      "slack_send_message",
    ]);
    for (const rules of Object.values(servers.github?.resources?.tools ?? {})) {
      expect(rules).toEqual([
        {
          prefix: "repository:",
          separator: "/",
          components: [{ arguments: ["owner"] }, { arguments: ["repo", "repository"] }],
        },
      ]);
    }
    for (const rules of Object.values(servers.slack?.resources?.tools ?? {})) {
      expect(rules).toEqual([
        { prefix: "channel:", components: [{ arguments: ["channel_id", "channelId", "channel"] }] },
      ]);
    }
  });

  it("does not add a preset mapping to an unrelated server", () => {
    expect(hostMcpToolServers({ custom: { url: "https://mcp.example.com/mcp" } })).toEqual({
      custom: { url: "https://mcp.example.com/mcp" },
    });
  });
});
