import type { Gateway, Tag, TaskFilesPlace } from "@supertag/client/model";
import { harnessLabel } from "@supertag/client/model";
import { useEffect, useState } from "react";
import { onMac } from "./sidebar";

/**
 * Where a Tag's work runs, as the parts of one line: the Worker Host of its latest turn, its
 * Workspace with the branch it follows, and its harness. A part the window does not know is left
 * out, so the line is at least the harness.
 */
export function whereItRuns(
  tag: Pick<Tag, "harnessKind" | "workspace">,
  place: Pick<TaskFilesPlace, "local" | "hostId"> | undefined,
  mac: boolean,
): string[] {
  const parts: string[] = [];
  if (place?.local) parts.push(mac ? "This Mac" : "This computer");
  else if (place?.hostId) parts.push(place.hostId);
  if (tag.workspace?.id)
    parts.push(tag.workspace.ref ? `${tag.workspace.id} (${tag.workspace.ref})` : tag.workspace.id);
  const harness = harnessLabel(tag.harnessKind) ?? tag.harnessKind;
  if (harness) parts.push(harness);
  return parts;
}

/**
 * The read-only line under the composer that says where the Tag's work runs. `taskId` is the
 * conversation's latest turn, whose Worker Host it names; before the first turn it names none.
 */
export function WhereItRuns({
  gateway,
  tag,
  taskId,
}: {
  gateway: Gateway;
  tag: Tag;
  taskId?: string;
}) {
  const [place, setPlace] = useState<TaskFilesPlace>();
  useEffect(() => {
    if (!taskId || !gateway.locateTaskFiles) return;
    let current = true;
    // The host of the turn before stays on the line until this one's is known.
    gateway.locateTaskFiles(taskId).then(
      (found) => current && setPlace(found),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [gateway, taskId]);
  const parts = whereItRuns(tag, place, onMac());
  if (parts.length === 0) return null;
  return (
    <p className="composer-where" title="Where this Tag's work runs">
      <span className="visually-hidden">Runs on </span>
      {parts.join(" · ")}
    </p>
  );
}
