import type { HarnessArtifactSource } from "@supertag/worker-sdk";

/** Generated home-directory content only; sessions, credentials and worktrees stay separate. */
export const codexArtifactSources: readonly HarnessArtifactSource[] = [
  {
    id: "codex-memories",
    directory: ".codex/memories",
    include: ["**"],
    category: "memory",
    submit: true,
    restore: true,
  },
  {
    id: "codex-generated-images",
    directory: ".codex/generated_images",
    include: ["**"],
    category: "media",
    bundleDepth: 1,
    submit: true,
  },
  {
    id: "codex-visualizations",
    directory: ".codex/visualizations",
    include: ["**"],
    category: "visualization",
    bundleDepth: 4,
    submit: true,
  },
  {
    id: "codex-authored-skills",
    directory: ".codex/skills",
    include: ["**"],
    exclude: [".system/**"],
    category: "capability",
    bundleDepth: 1,
  },
];
