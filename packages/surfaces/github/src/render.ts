import {
  parseSurfaceMarkdown,
  type SurfacePresentation,
  serializeSurfaceMarkdown,
} from "@supertag/surface-sdk";

/** GitHub issue comments natively consume Markdown, so rendering is normalization-only. */
export function renderGitHubPresentation(presentation: SurfacePresentation): string {
  return serializeSurfaceMarkdown(parseSurfaceMarkdown(presentation.markdown));
}
