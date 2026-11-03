import {
  parseSurfaceMarkdown,
  type SurfacePresentation,
  serializeSurfaceMarkdown,
} from "@supertag/surface-sdk";

/** Linear comments natively consume Markdown, so rendering is normalization-only. */
export function renderLinearPresentation(presentation: SurfacePresentation): string {
  return serializeSurfaceMarkdown(parseSurfaceMarkdown(presentation.markdown));
}
