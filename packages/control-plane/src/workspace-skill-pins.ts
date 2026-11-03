import type { TaskEvent } from "@supertag/core";

export interface WorkspaceSkillPin {
  readonly name: string;
  readonly source: string;
  readonly digest: string;
}

/** First reported package identities stay binding across Task Attempts and Worker Hosts. */
export function workspaceSkillPins(
  events: readonly TaskEvent[],
): readonly WorkspaceSkillPin[] | undefined {
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.type !== "runtime-inputs.resolved") continue;
    const manifest = event.payload?.["manifest"];
    if (!isRecord(manifest) || !Array.isArray(manifest["inputs"])) continue;
    const pins = manifest["inputs"].flatMap((entry): WorkspaceSkillPin[] => {
      if (!isRecord(entry) || entry["kind"] !== "skill" || !isRecord(entry["resource"])) return [];
      const resource = entry["resource"];
      const provenance = resource["provenance"];
      if (!isRecord(provenance) || provenance["provider"] !== "supertag-workspace") return [];
      if (
        typeof entry["id"] !== "string" ||
        !entry["id"].startsWith("skill:") ||
        typeof provenance["source"] !== "string" ||
        typeof resource["digest"] !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(resource["digest"])
      )
        return [];
      return [
        { name: entry["id"].slice(6), source: provenance["source"], digest: resource["digest"] },
      ];
    });
    if (pins.length > 0) return pins;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
