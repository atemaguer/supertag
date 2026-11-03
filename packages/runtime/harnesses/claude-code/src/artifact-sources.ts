import type { HarnessArtifactSource } from "@supertag/worker-sdk";

/** Paths are relative to the isolated runtime, whose CLAUDE_CONFIG_DIR is .claude-config. */
export const claudeCodeArtifactSources: readonly HarnessArtifactSource[] = [
  {
    id: "claude-project-memories",
    directory: ".claude-config/projects",
    include: ["*/memory/**"],
    category: "memory",
    bundleDepth: 2,
    submit: true,
    restore: true,
  },
  {
    id: "claude-agent-memories",
    directory: ".claude-config/agent-memory",
    include: ["**"],
    category: "memory",
    bundleDepth: 1,
    submit: true,
    restore: true,
  },
  {
    id: "claude-plans",
    directory: ".claude-config/plans",
    include: ["**"],
    category: "plan",
    bundleDepth: 1,
    submit: true,
  },
  ...["skills", "commands", "agents", "workflows"].map((directory) => ({
    id: `claude-authored-${directory}`,
    directory: `.claude-config/${directory}`,
    include: ["**"],
    category: "capability",
    bundleDepth: 1,
  })),
  {
    id: "claude-insights-reports",
    directory: ".claude-config/usage-data",
    include: ["report*.html"],
    category: "report",
    bundleDepth: 1,
    submit: true,
  },
];
