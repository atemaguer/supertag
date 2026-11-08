import { describe, expect, it } from "vitest";
import {
  fieldOwners,
  flattenSpec,
  mergeFields,
  recordFields,
  unflattenSpec,
} from "../apps/cli/src/field-management.ts";

const location = (channelId: string, permissionSets?: string[]) => ({
  provider: "slack",
  account: "T1",
  channelId,
  ...(permissionSets ? { permissionSets } : {}),
});

describe("field management", () => {
  it("flattens list fields to entries keyed by identity and restores the spec", () => {
    const spec = {
      roles: ["Engineer"],
      workerHosts: [],
      runsOn: ["gpu"],
      locations: [location("C1", ["deploy"])],
      acceptsMessagesFrom: ["reviewer"],
    };
    const fields = flattenSpec("Tag", spec);
    expect([...fields.keys()]).toEqual([
      "spec.roles[Engineer]",
      "spec.runsOn[gpu]",
      "spec.acceptsMessagesFrom[reviewer]",
      "spec.locations[slack:C1]",
    ]);
    expect(unflattenSpec("Tag", fields)).toEqual(spec);
    expect(flattenSpec("Workspace", { ref: "main", delivery: "branch" })).toEqual(
      new Map<string, unknown>([
        ["spec.ref", "main"],
        ["spec.delivery", "branch"],
      ]),
    );
  });

  it("treats every field as cli's without a record, and changed fields as cli's with one", () => {
    const current = flattenSpec("Role", { purpose: "Ship.", permissionSets: ["a", "b"] });
    expect([...fieldOwners(current, undefined).values()]).toEqual(["cli", "cli", "cli"]);
    const owners = fieldOwners(current, {
      "spec.purpose": { manager: "apply", value: "Ship." },
      "spec.permissionSets[a]": { manager: "apply", value: true },
    });
    expect(Object.fromEntries(owners)).toEqual({
      "spec.purpose": "apply",
      "spec.permissionSets[a]": "apply",
      "spec.permissionSets[b]": "cli",
    });
    // A recorded value that no longer matches was changed outside a managed write.
    expect(
      fieldOwners(current, { "spec.purpose": { manager: "apply", value: "Old." } }).get(
        "spec.purpose",
      ),
    ).toBe("cli");
  });

  it("removes its own omitted fields, keeps others', and conflicts on others' values", () => {
    const current = flattenSpec("Tag", {
      locations: [location("C1"), location("C2"), location("C3", ["deploy"])],
    });
    const owners = new Map<string, string | undefined>([
      ["spec.locations[slack:C1]", "apply"],
      ["spec.locations[slack:C2]", "cli"],
      ["spec.locations[slack:C3]", "cli"],
    ]);
    const desired = flattenSpec("Tag", { locations: [location("C3"), location("C4")] });
    const merge = mergeFields({ current, owners, desired, manager: "apply", force: false });
    expect(merge.conflicts).toEqual([{ path: "spec.locations[slack:C3]", manager: "cli" }]);
    expect(merge.changes.map((change) => [change.action, change.path])).toEqual([
      ["add", "spec.locations[slack:C4]"],
      ["remove", "spec.locations[slack:C1]"],
    ]);
    expect([...merge.fields.keys()]).toEqual([
      "spec.locations[slack:C2]",
      "spec.locations[slack:C3]",
      "spec.locations[slack:C4]",
    ]);

    const forced = mergeFields({ current, owners, desired, manager: "apply", force: true });
    expect(forced.conflicts).toEqual([]);
    expect(forced.owners.get("spec.locations[slack:C3]")).toBe("apply");
    expect(forced.fields.get("spec.locations[slack:C3]")).toEqual(location("C3"));
  });

  it("takes ownership without a conflict when the value is already the same", () => {
    const current = flattenSpec("Role", { purpose: "Ship." });
    const merge = mergeFields({
      current,
      owners: new Map([["spec.purpose", "cli"]]),
      desired: flattenSpec("Role", { purpose: "Ship." }),
      manager: "team-a",
      force: false,
    });
    expect(merge.conflicts).toEqual([]);
    expect(merge.changes).toEqual([]);
    expect(merge.owners.get("spec.purpose")).toBe("team-a");
  });

  it("records fields the store filled in as unowned", () => {
    const planned = new Map<string, unknown>([["spec.ref", "main"]]);
    const stored = new Map<string, unknown>([
      ["spec.ref", "main"],
      ["spec.delivery", "branch"],
    ]);
    expect(recordFields(stored, planned, new Map([["spec.ref", "apply"]]))).toEqual({
      "spec.ref": { manager: "apply", value: "main" },
      "spec.delivery": { value: "branch" },
    });
  });
});
