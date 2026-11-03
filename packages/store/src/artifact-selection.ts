// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transaction generators.
import type { ArtifactSelection, CapturedArtifact, CapturedArtifactEntry } from "@supertag/core";
import { ArtifactCatalogError, parseArtifactSelection } from "@supertag/core";
import { and, eq } from "drizzle-orm";

type Flow<T> = Generator<any, T, any>;

export function selectedEntries(
  artifact: CapturedArtifact,
  value: unknown,
): readonly CapturedArtifactEntry[] {
  const selection = parseArtifactSelection(value);
  if (selection.artifactId !== artifact.id)
    throw new ArtifactCatalogError(400, "Artifact identity mismatch");
  return selection.paths.map((path) => {
    const entry = artifact.entries.find((entry) => entry.path === path);
    if (!entry) throw new ArtifactCatalogError(400, "Selected artifact path does not exist");
    return entry;
  });
}
export function includesSelection(selections: unknown, value: ArtifactSelection): boolean {
  return (
    Array.isArray(selections) &&
    selections.some(
      (candidate) =>
        candidate?.artifactId === value.artifactId &&
        Array.isArray(candidate.paths) &&
        value.paths.every((path) => candidate.paths.includes(path)),
    )
  );
}
export function* validateSubmittedArtifacts(
  tx: any,
  tables: any,
  taskId: string,
  attemptNumber: number,
  result: any,
): Flow<ArtifactSelection[]> {
  const outputs = result?.taskResult?.artifacts ?? [];
  if (!Array.isArray(outputs) || outputs.length > 100)
    throw new ArtifactCatalogError(400, "Invalid submitted artifact selections");
  if (!outputs.length) return [];
  const [attempt] = yield tx
    .select()
    .from(tables.taskAttempts)
    .where(
      and(
        eq(tables.taskAttempts.taskId, taskId),
        eq(tables.taskAttempts.attemptNumber, attemptNumber),
      ),
    );
  if (!attempt)
    throw new ArtifactCatalogError(409, "Artifact submission requires its producing Attempt");
  const selections: ArtifactSelection[] = [];
  for (const value of outputs) {
    const selection = parseArtifactSelection(value);
    const [artifact] = yield tx
      .select()
      .from(tables.capturedArtifacts)
      .where(eq(tables.capturedArtifacts.id, selection.artifactId));
    if (!artifact || artifact.taskId !== taskId || artifact.attemptId !== attempt.id)
      throw new ArtifactCatalogError(
        409,
        "Submitted artifact must belong to this Task and Attempt",
      );
    selectedEntries(artifact, selection);
    if (selections.some((existing) => existing.artifactId === selection.artifactId))
      throw new ArtifactCatalogError(400, "Duplicate submitted artifact");
    selections.push(selection);
  }
  return selections;
}
