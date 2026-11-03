import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltInRoles } from "../packages/control-plane/src/roles.js";
import { ORG_ARCHITECT_ROLE_KEY } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Roles`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-roles-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      return store;
    }

    it("directs temporary work to Tasks or native subagents and keeps Workstreams as Team channels", async () => {
      const store = await fixture();
      await ensureBuiltInRoles(store);
      const instructions = (await store.listRoles()).find(
        (role) => role.systemKey === ORG_ARCHITECT_ROLE_KEY,
      )?.instructions;
      expect(instructions).toContain(
        "Prefer a Task or harness-native subagent for temporary work.",
      );
      expect(instructions).toContain("Workstreams are Team channels only.");
      expect(instructions).not.toContain("Prefer a Task, Workstream");
      expect(instructions).toContain(
        "Record the evidence and policy revision behind each decision, then return a correlated mailbox decision to the requesting manager.",
      );
    });

    it("composes reusable configuration and assigns it to a Tag", async () => {
      const store = await fixture();
      const tag = await store.createTag({ name: `reviewer-${randomUUID()}` });
      const context = await store.createTagContextSet({ name: `review-context-${randomUUID()}` });
      const permission = await store.createTagPermissionSet({
        name: `review-permission-${randomUUID()}`,
      });
      await store.addTagPermission({
        permissionSetId: permission.id,
        target: "runtime",
        action: "web:search",
      });

      const role = await store.createRole({
        name: `Security Reviewer ${randomUUID()}`,
        purpose: "Review changes that affect customer data.",
        instructions: "Require evidence for every material security claim.",
        contextSetIds: [context.id],
        permissionSetIds: [permission.id],
        createdBy: "operator:test",
      });
      await expect(
        store.createRole({
          name: role.name,
          purpose: role.purpose,
          instructions: role.instructions,
          contextSetIds: [context.id],
          permissionSetIds: [permission.id],
        }),
      ).resolves.toMatchObject({ id: role.id, revision: 1 });

      const assignment = await store.assignRole({
        roleId: role.id,
        tagId: tag.id,
        createdBy: "operator:test",
      });
      await expect(store.assignRole({ roleId: role.id, tagId: tag.id })).resolves.toEqual(
        assignment,
      );
      await expect(store.listRoleAssignments({ tagId: tag.id, status: "active" })).resolves.toEqual(
        [assignment],
      );

      const updated = await store.updateRole(role.id, {
        expectedRevision: role.revision,
        instructions: "Review the evidence and state unresolved risk explicitly.",
      });
      expect(updated).toMatchObject({ revision: 2, contextSetIds: [context.id] });
      await expect(
        store.updateRole(role.id, { expectedRevision: 1, purpose: "stale" }),
      ).rejects.toThrow(/revision changed/i);

      const retired = await store.updateRole(role.id, {
        expectedRevision: updated.revision,
        status: "retired",
      });
      expect(retired.status).toBe("retired");
      await expect(
        store.listRoleAssignments({ roleId: role.id, status: "active" }),
      ).resolves.toEqual([]);
      await expect(store.assignRole({ roleId: role.id, tagId: tag.id })).rejects.toThrow(
        /Active Role/i,
      );
    });

    it("protects built-in identity while preserving user customization", async () => {
      const store = await fixture();
      const definition = {
        systemKey: ORG_ARCHITECT_ROLE_KEY,
        name: "Org Architect",
        purpose: "Decide whether durable organization structure is warranted.",
        instructions: "Prefer temporary coordination when durable identity is unnecessary.",
      } as const;
      const bootstrapped = await Promise.all(
        Array.from({ length: 8 }, () => store.ensureSystemRole(definition)),
      );
      expect(new Set(bootstrapped.map((role) => role.id))).toHaveProperty("size", 1);
      const initial = bootstrapped[0];
      if (!initial) throw new Error("Built-in Role was not created");
      const customized = await store.updateRole(initial.id, {
        expectedRevision: initial.revision,
        instructions: "Apply the operator's examples before approving a structural change.",
      });
      await expect(
        store.ensureSystemRole({
          systemKey: ORG_ARCHITECT_ROLE_KEY,
          name: "Org Architect",
          purpose: "A newer shipped default must not overwrite operator policy.",
          instructions: "new default",
        }),
      ).resolves.toEqual(customized);
      await expect(
        store.updateRole(customized.id, {
          expectedRevision: customized.revision,
          status: "retired",
        }),
      ).rejects.toThrow(/Built-in Roles cannot be retired/i);
    });
  });
}
