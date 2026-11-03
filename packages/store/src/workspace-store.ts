// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID } from "node:crypto";
import {
  type ApplyWorkspaceInput,
  canonicalJson,
  type DatabaseProvider,
  parseWorkspaceName,
  parseWorkspaceSpec,
  type Workspace,
  type WorkspaceDelivery,
  type WorkspacePullRequestTransition,
  type WorkspaceStore,
} from "@supertag/core";
import { asc, eq, lte } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;

export class DrizzleWorkspaceStore implements WorkspaceStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async applyWorkspace(
    input: ApplyWorkspaceInput,
  ): Promise<{ readonly workspace: Workspace; readonly created: boolean }> {
    const name = parseWorkspaceName(input.name);
    const { name: _name, ...rest } = input;
    const spec = parseWorkspaceSpec(rest);
    const table = this.tables.workspaces;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<{
      readonly workspace: Workspace;
      readonly created: boolean;
    }> {
      const at = new Date().toISOString();
      const [existing] = yield tx.select().from(table).where(eq(table.name, name)).limit(1);
      const fields = {
        source: spec.source ?? null,
        ref: spec.ref ?? null,
        setup: spec.setup ?? null,
        mcp: spec.mcp ?? null,
        skills: spec.skills ?? null,
        skillCatalog: spec.skillCatalog ?? null,
        mounts: spec.mounts ?? null,
        delivery: spec.delivery,
      };
      if (existing) {
        const unchanged =
          existing.source === fields.source &&
          existing.ref === fields.ref &&
          existing.setup === fields.setup &&
          JSON.stringify(existing.mcp) === JSON.stringify(fields.mcp) &&
          JSON.stringify(existing.skills) === JSON.stringify(fields.skills) &&
          canonicalJson(existing.skillCatalog) === canonicalJson(fields.skillCatalog) &&
          canonicalJson(existing.mounts) === canonicalJson(fields.mounts) &&
          existing.delivery === fields.delivery;
        if (unchanged) return { workspace: workspaceFromRow(existing), created: false };
        const [row] = yield tx
          .update(table)
          .set({ ...fields, revision: existing.revision + 1, updatedAt: at })
          .where(eq(table.id, existing.id))
          .returning();
        return { workspace: workspaceFromRow(row), created: false };
      }
      const [row] = yield tx
        .insert(table)
        .values({ id: randomUUID(), name, ...fields, revision: 1, createdAt: at, updatedAt: at })
        .returning();
      return { workspace: workspaceFromRow(row), created: true };
    });
  }

  async findWorkspaceByName(name: string): Promise<Workspace | undefined> {
    const table = this.tables.workspaces;
    const [row] = await this.db.select().from(table).where(eq(table.name, name)).limit(1);
    return row ? workspaceFromRow(row) : undefined;
  }

  async deleteWorkspace(name: string): Promise<boolean> {
    const table = this.tables.workspaces;
    const rows = await this.db.delete(table).where(eq(table.name, name)).returning();
    return rows.length > 0;
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    const table = this.tables.workspaces;
    const rows = await this.db.select().from(table).orderBy(asc(table.name));
    return rows.map(workspaceFromRow);
  }

  async saveWorkspacePullRequestTransition(
    transition: Omit<WorkspacePullRequestTransition, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const table = this.tables.workspacePullRequestTransitions;
    const at = new Date().toISOString();
    const fields = {
      url: transition.url,
      action: transition.action,
      attemptCount: transition.attemptCount,
      nextAttemptAt: transition.nextAttemptAt,
      lastError: transition.lastError,
    };
    await this.db
      .insert(table)
      .values({ taskId: transition.taskId, ...fields, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: table.taskId, set: { ...fields, updatedAt: at } });
  }

  async listDueWorkspacePullRequestTransitions(
    now: string,
    limit = 50,
  ): Promise<readonly WorkspacePullRequestTransition[]> {
    const table = this.tables.workspacePullRequestTransitions;
    const rows = await this.db
      .select()
      .from(table)
      .where(lte(table.nextAttemptAt, now))
      .orderBy(asc(table.nextAttemptAt), asc(table.taskId))
      .limit(limit);
    return rows.map(
      (row: any): WorkspacePullRequestTransition => ({
        taskId: row.taskId,
        url: row.url,
        action: row.action === "ready" ? "ready" : "close",
        attemptCount: Number(row.attemptCount),
        nextAttemptAt: row.nextAttemptAt,
        lastError: row.lastError ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    );
  }

  async deleteWorkspacePullRequestTransition(taskId: string): Promise<void> {
    const table = this.tables.workspacePullRequestTransitions;
    await this.db.delete(table).where(eq(table.taskId, taskId));
  }
}

function workspaceFromRow(row: any): Workspace {
  return {
    id: row.id,
    name: row.name,
    ...(row.source == null ? {} : { source: row.source }),
    ...(row.ref == null ? {} : { ref: row.ref }),
    ...(row.setup == null ? {} : { setup: row.setup }),
    ...(row.mcp == null ? {} : { mcp: row.mcp as string[] }),
    ...(row.skills == null ? {} : { skills: row.skills as string[] }),
    ...(row.skillCatalog == null
      ? {}
      : { skillCatalog: row.skillCatalog as NonNullable<Workspace["skillCatalog"]> }),
    ...(row.mounts == null ? {} : { mounts: row.mounts as NonNullable<Workspace["mounts"]> }),
    delivery: row.delivery as WorkspaceDelivery,
    revision: Number(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
