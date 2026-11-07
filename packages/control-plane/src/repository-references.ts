/**
 * `owner/repo` references in a request. The owner follows GitHub's owner rules (letters, digits,
 * and single inner hyphens), so paths such as `__pycache__/` or `./src` are not references.
 */
export function repositoryReferences(text: string): readonly string[] {
  return [
    ...text.matchAll(
      /(?:^|[\s(`])([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/[a-z0-9_.-]*[a-z0-9_-][a-z0-9_.-]*)(?=$|[\s),.:;!?`])/gi,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1].toLowerCase()]));
}

/**
 * A reference that must name a GitHub repository rather than a file: its repository part has no
 * dot, so `atemaguer/supertag` qualifies and `src/index.ts` does not. Only these refuse a request
 * from a Tag that may use no GitHub repository.
 */
export function unambiguousRepositoryReference(reference: string): boolean {
  return !reference.slice(reference.indexOf("/") + 1).includes(".");
}
