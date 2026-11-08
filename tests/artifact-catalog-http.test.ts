import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleArtifactRequest } from "../apps/cli/src/artifact-http.js";
import { ArtifactCatalog, ObjectiveController } from "../packages/control-plane/src/index.js";
import {
  ArtifactCatalogError,
  type JsonRecord,
  type TagContextPlan,
  TagMessagingError,
} from "../packages/core/src/index.js";
import type { ArtifactStore } from "../packages/runtime/sdk/src/artifact-store.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { openTestTask } from "./support/artifact-producer.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

/** A verified Attempt of a Task, as the Control Plane hands it to the catalog. */
interface Caller {
  readonly kind: "surface";
  readonly taskId: string;
  readonly attemptId: string;
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
    `${dialect} artifact catalog HTTP`,
    () => {
      const cleanup: (() => Promise<void>)[] = [];
      afterEach(async () => {
        for (const close of cleanup.splice(0).reverse()) await close();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "artifact-catalog-http-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
        const pg =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(process.env["SUPERTAG_POSTGRES_URL"] as string)
            : undefined;
        if (pg) cleanup.push(pg.cleanup);
        const url = pg?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanup.push(() => store.disconnect());
        const owner = await store.createTag({ name: "owner" });
        const researcher = await store.createTag({ name: "researcher" });
        const engineer = await store.createTag({ name: "engineer" });
        const team = await store.createTeam({
          id: randomUUID(),
          name: "product",
          memberTagIds: [owner.id, researcher.id, engineer.id],
          maxConcurrency: 10,
        });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          teamId: team.id,
          outcome: "Reuse previous work",
        });
        const callers = new Map<string, Caller>();
        const attempts = new Map<string, string>();
        /**
         * One work Session turn of a Tag with a running Attempt. Artifact visibility follows the
         * Session boundary: a Task of an Objective reads every Session of that Objective, so an
         * Attempt without that Objective sees nothing of it.
         */
        async function worker(
          token: string,
          tag = engineer,
          options: {
            contextPlan?: TagContextPlan;
            inputArtifacts?: readonly JsonRecord[];
            objectiveId?: string | null;
          } = {},
        ) {
          const objectiveId =
            options.objectiveId === undefined ? objective.id : options.objectiveId;
          const { task } = await openTestTask(store, {
            tagId: tag.id,
            tagName: tag.name,
            ...(objectiveId === null ? {} : { objectiveId }),
            ...(options.contextPlan ? { contextPlan: options.contextPlan } : {}),
            ...(options.inputArtifacts
              ? { trigger: { inputArtifacts: options.inputArtifacts } }
              : {}),
            requestText: "Use recorded work",
          });
          const attempt = await store.createTaskAttempt({
            taskId: task.id,
            attemptNumber: 1,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          callers.set(token, { kind: "surface", taskId: task.id, attemptId: attempt.id });
          attempts.set(token, attempt.id);
          return task;
        }
        const source = await worker("writer", researcher);
        const consumer = await worker("reader");
        const coordinator = new ObjectiveController(store, undefined);
        const authority = {
          async authenticateExecution(token: string | undefined) {
            const caller = callers.get(token ?? "");
            if (!caller) throw new TagMessagingError(401, "Expired Attempt");
            return caller;
          },
          authorizeArtifactSource: coordinator.authorizeArtifactSource.bind(coordinator),
        };
        /** Completes the producing Task with the artifact in its result, as its report does. */
        async function completeSource(artifactId: string, paths: readonly string[]) {
          await store.closeTaskAttempt({
            attemptId: attempts.get("writer") as string,
            status: "completed",
            endedAt: new Date().toISOString(),
          });
          await store.closeTask({
            taskId: source.id,
            status: "completed",
            result: {
              summary: "Accepted",
              decisions: [],
              changes: [],
              unresolved: [],
              findings: [],
              references: [],
              artifacts: [{ artifactId, paths: [...paths] }],
            },
            endedAt: new Date().toISOString(),
          });
        }
        // The producing Worker Host's copies: bytes stay here and never reach the Control Plane,
        // which records only metadata. Byte backends are exercised separately; this test covers
        // HTTP authority and persistence together.
        const hostCopies = new Map<string, Uint8Array>();
        let catalog = new ArtifactCatalog(store, authority);
        const server = createServer(
          (request, response) =>
            void handleArtifactRequest(
              request,
              response,
              new URL(request.url ?? "/", "http://localhost"),
              catalog,
            ),
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanup.push(async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No server address");
        const controlPlaneUrl = `http://127.0.0.1:${address.port}`;
        const command = async (name: string, input: unknown, token = "reader") => {
          const response = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/catalog/${name}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(input),
          });
          return { status: response.status, body: await response.json() };
        };
        /**
         * One Attempt's view of the Worker Host's copies. `put` keeps bytes on the host and
         * records only the upload receipt with the Attempt token; `get` models the serving host's
         * check before it hands bytes over: the catalog must permit this Attempt the digest.
         */
        const host = (token: string): ArtifactStore => ({
          async put({ bytes }) {
            const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            hostCopies.set(digest, Buffer.from(bytes));
            const response = await fetch(
              `${controlPlaneUrl}/internal/v1/artifacts/catalog/upload`,
              {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ digest, sizeBytes: bytes.byteLength }),
              },
            );
            await response.body?.cancel();
            if (!response.ok)
              throw new Error(`Artifact upload receipt failed (${response.status})`);
            return { uri: `supertag-artifact:${digest}`, digest };
          },
          async get(ref) {
            const digest = ref.digest ?? "";
            let permitted: boolean;
            try {
              permitted = await catalog.permitsDownload(token, digest);
            } catch (error) {
              if (error instanceof TagMessagingError || error instanceof ArtifactCatalogError)
                throw new Error(`Artifact download refused (${error.statusCode})`);
              throw error;
            }
            if (!permitted) throw new Error("Artifact download refused (403)");
            const bytes = hostCopies.get(digest);
            if (!bytes) throw new Error("Artifact copy is missing on this Worker Host");
            return Buffer.from(bytes);
          },
        });
        const writer = host("writer");
        const reader = host("reader");
        async function capture(harnessSession?: { harnessId: string; id: string }) {
          const contents = Buffer.from("Original research evidence");
          const first = await writer.put({ bytes: contents });
          const second = await writer.put({ bytes: Buffer.from("Private raw interview") });
          const definition = {
            operationId: "research-v1",
            title: "PT practice research",
            kind: "research",
            ...(harnessSession ? { harnessSession } : {}),
            entries: [
              {
                path: "findings.md",
                ...first,
                sizeBytes: contents.length,
                mediaType: "text/markdown",
              },
              {
                path: "raw.txt",
                ...second,
                sizeBytes: Buffer.byteLength("Private raw interview"),
                mediaType: "text/plain",
              },
            ],
          };
          // Blob ref id/name are not part of manifest entries.
          const result = await command("capture", definition, "writer");
          expect(result.status).toBe(200);
          return { artifact: result.body.artifact, first, second, contents, definition };
        }
        return {
          store,
          source,
          consumer,
          callers,
          attempts,
          writer,
          reader,
          command,
          capture,
          restart: () => {
            catalog = new ArtifactCatalog(store, authority);
          },
          worker,
          owner,
          objective,
          team,
          completeSource,
          coordinator,
          host,
          hostCopies,
          controlPlaneUrl,
        };
      }

      it("serves no artifact bytes and records no receipts through Control Plane byte routes", async () => {
        const f = await fixture();
        const { first, contents } = await f.capture();
        const attemptId = f.attempts.get("writer") as string;
        const bytes = Buffer.from("Bytes sent to the Control Plane");
        const hex = createHash("sha256").update(bytes).digest("hex");
        const receipt = { attemptId, digest: `sha256:${hex}`, sizeBytes: bytes.length };
        const captured = { attemptId, digest: first.digest as string, sizeBytes: contents.length };
        expect(await f.store.hasArtifactUpload(captured)).toBe(true);
        expect(await f.store.hasArtifactUpload(receipt)).toBe(false);
        const route = (digest: string) => `${f.controlPlaneUrl}/internal/v1/artifacts/${digest}`;
        const put = await fetch(route(hex), {
          method: "PUT",
          headers: {
            authorization: "Bearer writer",
            "content-type": "application/octet-stream",
          },
          body: bytes,
        });
        expect(put.status).toBe(404);
        expect(await put.json()).toEqual({ error: "Artifact not found" });
        const get = await fetch(route((first.digest as string).slice("sha256:".length)), {
          headers: { authorization: "Bearer writer" },
        });
        expect(get.status).toBe(404);
        expect(await get.json()).toEqual({ error: "Artifact not found" });
        expect(await f.store.hasArtifactUpload(receipt)).toBe(false);
        expect(await f.store.hasArtifactUpload(captured)).toBe(true);
        expect(f.hostCopies.has(`sha256:${hex}`)).toBe(false);
      });

      it.each(["codex", "claude-code"])(
        "preserves %s native conversation metadata across capture, restart, discovery and inspect",
        async (harnessId) => {
          const f = await fixture();
          const harnessSession = { harnessId, id: "native-conversation-123" };
          const { artifact, definition } = await f.capture(harnessSession);
          expect(artifact.harnessSession).toEqual(harnessSession);
          expect(artifact.sessionId).not.toBe(harnessSession.id);
          expect((await f.command("capture", definition, "writer")).body.artifact).toEqual(
            artifact,
          );
          expect(
            (
              await f.command(
                "capture",
                {
                  ...definition,
                  harnessSession: { ...harnessSession, id: "another-native-conversation" },
                },
                "writer",
              )
            ).status,
          ).toBe(409);
          f.restart();
          const found = await f.command("find", { query: "PT practice" });
          expect(found.status).toBe(200);
          expect(found.body.artifacts[0].harnessSession).toEqual(harnessSession);
          const inspected = await f.command("inspect", { artifactId: artifact.id });
          expect(inspected.status).toBe(200);
          expect(inspected.body.artifact.harnessSession).toEqual(harnessSession);
          expect(
            (await f.command("inspect", { artifactId: artifact.id }, "invalid-token")).status,
          ).toBe(401);
        },
      );

      it("rejects malformed native conversation metadata while preserving optional metadata", async () => {
        const f = await fixture();
        const { artifact, definition } = await f.capture();
        expect(artifact).not.toHaveProperty("harnessSession");
        for (const harnessSession of [
          null,
          {},
          { harnessId: "codex" },
          { id: "native" },
          { harnessId: "codex", id: "" },
          { harnessId: "codex", id: 123 },
          { harnessId: "codex", id: "x".repeat(1025) },
        ]) {
          const captured = await f.command(
            "capture",
            { ...definition, operationId: randomUUID(), harnessSession },
            "writer",
          );
          expect(captured.status).toBe(400);
        }
      });

      it("withdraws publication access for already admitted files and acquisitions", async () => {
        const f = await fixture();
        const { artifact, first, second, contents } = await f.capture();
        await f.completeSource(artifact.id, ["findings.md"]);
        const outsider = await f.store.createTag({ name: "published-consumer" });
        const objective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Use approved evidence",
        });
        const actor = { kind: "tag" as const, tagId: f.owner.id };
        const publication = await f.store.approveArtifactPublication(
          {
            id: randomUUID(),
            artifactId: artifact.id,
            paths: ["findings.md"],
            audienceObjectiveIds: [objective.id],
          },
          actor,
        );
        const consumption = await f.store.approveArtifactConsumption(
          { id: randomUUID(), publicationApprovalId: publication.id, objectiveId: objective.id },
          actor,
        );
        await f.worker("published", outsider, {
          objectiveId: objective.id,
          inputArtifacts: [
            {
              artifactId: artifact.id,
              path: "findings.md",
              digest: first.digest as string,
              provenance: {
                taskId: f.source.id,
                attemptId: f.attempts.get("writer") as string,
                publicationApproval: { id: publication.id, revision: publication.revision },
                consumptionApproval: { id: consumption.id, revision: consumption.revision },
              },
            },
          ],
        });
        const client = f.host("published");
        expect(await client.get(first)).toEqual(contents);
        await expect(client.get(second)).rejects.toThrow("403");
        expect(
          (
            await f.command(
              "acquire",
              {
                operationId: "read-approved",
                artifactId: artifact.id,
                paths: ["findings.md"],
                delivery: "read",
              },
              "published",
            )
          ).status,
        ).toBe(200);
        await f.store.withdrawArtifactPublication(
          { id: publication.id, expectedRevision: publication.revision },
          actor,
        );
        expect((await f.command("find", {}, "published")).body.artifacts).toEqual([]);
        expect((await f.command("inspect", { artifactId: artifact.id }, "published")).status).toBe(
          404,
        );
        await expect(client.get(first)).rejects.toThrow("403");
      });

      it("does not substitute content when a pinned blob is missing", async () => {
        const f = await fixture();
        const { artifact, first } = await f.capture();
        expect(
          (
            await f.command("acquire", {
              operationId: "missing",
              artifactId: artifact.id,
              paths: ["findings.md"],
              delivery: "read",
            })
          ).status,
        ).toBe(200);
        f.hostCopies.delete(first.digest as string);
        await expect(f.reader.get(first)).rejects.toThrow("missing on this Worker Host");
        expect(
          (await f.command("inspect", { artifactId: artifact.id })).body.artifact.entries[0].digest,
        ).toBe(first.digest);
        expect(
          (
            await f.store.listArtifactAcquisitions({
              attemptId: f.attempts.get("reader") as string,
            })
          )[0]?.status,
        ).toBe("authorized");
      });

      it("admits only the files a turn's pinned inputs name, and records them as capture inputs", async () => {
        const f = await fixture();
        const { artifact, first, second, contents } = await f.capture();
        await f.completeSource(artifact.id, ["findings.md"]);
        const outsider = await f.store.createTag({ name: "artifact-consumer" });
        // An outsider Tag on another Objective sees the artifact only through the pinned input its
        // turn carries, and only the one file that input names.
        const consumer = await f.worker("pinned", outsider, {
          objectiveId: null,
          inputArtifacts: [
            {
              artifactId: artifact.id,
              path: "findings.md",
              digest: first.digest as string,
              provenance: {
                taskId: f.source.id,
                attemptId: f.attempts.get("writer") as string,
              },
            },
          ],
        });
        expect((await f.store.findTaskById(consumer.id))?.objectiveId).toBeUndefined();
        const inspected = await f.command("inspect", { artifactId: artifact.id }, "pinned");
        expect(inspected.status).toBe(200);
        expect(inspected.body.artifact.entries.map((e: { path: string }) => e.path)).toEqual([
          "findings.md",
        ]);
        expect(
          (
            await f.command(
              "acquire",
              {
                operationId: "hidden",
                artifactId: artifact.id,
                paths: ["raw.txt"],
                delivery: "read",
              },
              "pinned",
            )
          ).status,
        ).toBe(404);
        const client = f.host("pinned");
        expect(await client.get(first)).toEqual(contents);
        await expect(client.get(second)).rejects.toThrow("403");
        const output = Buffer.from("Implementation based on supplied findings");
        const saved = await client.put({ bytes: output });
        const definition = {
          operationId: "implementation",
          title: "Implementation",
          kind: "code",
          entries: [{ path: "implementation.txt", ...saved, sizeBytes: output.length }],
        };
        const captured = await f.command("capture", definition, "pinned");
        expect(captured.status).toBe(200);
        expect(captured.body.artifact.inputs).toEqual([
          { artifactId: artifact.id, paths: ["findings.md"] },
        ]);
        expect(
          (await f.command("find", { query: "Implementation" }, "pinned")).body.artifacts[0],
        ).not.toHaveProperty("inputs");
        expect((await f.command("capture", { ...definition, inputs: [] }, "pinned")).status).toBe(
          400,
        );
        expect((await f.command("capture", definition, "pinned")).body.artifact.id).toBe(
          captured.body.artifact.id,
        );
      });

      it("grants only exact admitted artifacts across normal visibility boundaries", async () => {
        const f = await fixture();
        const { artifact, first, definition, contents } = await f.capture();
        const sibling = await f.command(
          "capture",
          { ...definition, operationId: "sibling", title: "Unselected work" },
          "writer",
        );
        const outsider = await f.store.createTag({ name: "outsider" });
        const { entries, operationId: _operation, ...metadata } = artifact;
        await f.worker("admitted", outsider, {
          objectiveId: null,
          contextPlan: {
            version: 7,
            capturedAt: new Date().toISOString(),
            sets: [
              {
                id: "shared",
                name: "shared",
                items: [
                  {
                    id: "source",
                    itemKey: "research",
                    type: "supertag/artifacts",
                    version: 1,
                    required: true,
                    config: {},
                    snapshot: {
                      source: {
                        tagRouteId: "source",
                        surfaceAccountId: "account",
                        provider: "slack",
                        scope: "channel:C123",
                      },
                      artifacts: [
                        {
                          ...metadata,
                          entryCount: entries.length,
                          sizeBytes: entries.reduce(
                            (n: number, e: { sizeBytes: number }) => n + e.sizeBytes,
                            0,
                          ),
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        });
        const found = await f.command("find", { limit: 1 }, "admitted");
        expect(found.status).toBe(200);
        expect(found.body.artifacts.map((a: { id: string }) => a.id)).toEqual([artifact.id]);
        expect((await f.command("inspect", { artifactId: artifact.id }, "admitted")).status).toBe(
          200,
        );
        expect(
          (await f.command("inspect", { artifactId: sibling.body.artifact.id }, "admitted")).status,
        ).toBe(404);
        expect(
          (await f.command("find", { query: "Unselected" }, "admitted")).body.artifacts,
        ).toEqual([]);
        expect(
          (await f.command("find", { taskId: f.consumer.id }, "admitted")).body.artifacts,
        ).toEqual([]);
        const reader = f.host("admitted");
        await expect(reader.get(first)).rejects.toThrow("403");
        expect(
          (
            await f.command(
              "acquire",
              {
                operationId: "selected",
                artifactId: artifact.id,
                paths: ["findings.md"],
                delivery: "read",
              },
              "admitted",
            )
          ).status,
        ).toBe(200);
        expect(await reader.get(first)).toEqual(contents);
        f.callers.delete("admitted");
        await expect(reader.get(first)).rejects.toThrow("401");
      });

      it("captures immutable evidence and permits only selected files after durable acquisition", async () => {
        const f = await fixture();
        const { artifact, first, second, contents, definition } = await f.capture();
        expect((await f.command("capture", definition, "writer")).body.artifact.id).toBe(
          artifact.id,
        );
        expect(
          (await f.command("capture", { ...definition, title: "Changed" }, "writer")).status,
        ).toBe(409);
        expect((await f.command("capture", definition, "reader")).status).toBe(409);
        expect(
          (await f.command("capture", { ...definition, taskId: f.source.id }, "writer")).status,
        ).toBe(400);
        await expect(f.reader.get(first)).rejects.toThrow("403");
        f.callers.delete("writer");
        await f.store.closeTaskAttempt({
          attemptId: f.attempts.get("writer") as string,
          status: "completed",
          endedAt: new Date().toISOString(),
        });
        f.restart();
        const found = await f.command("find", { query: "PT practice" });
        expect(found.body.artifacts.map((a: { id: string }) => a.id)).toEqual([artifact.id]);
        expect(found.body.artifacts[0]).toMatchObject({ entryCount: 2 });
        expect(found.body.artifacts[0]).not.toHaveProperty("entries");
        const selection = {
          operationId: "use-research",
          artifactId: artifact.id,
          paths: ["findings.md"],
          delivery: "read",
        };
        const acquired = await f.command("acquire", selection);
        expect(acquired.status).toBe(200);
        expect((await f.command("acquire", selection)).body.acquisition.id).toBe(
          acquired.body.acquisition.id,
        );
        expect(await f.reader.get(first)).toEqual(contents);
        await expect(f.reader.get(second)).rejects.toThrow("403");
        expect(
          (await f.command("settle", { id: acquired.body.acquisition.id, status: "delivered" }))
            .status,
        ).toBe(200);
        expect(
          (await f.store.findTaskById(f.consumer.id))?.trigger["inputArtifacts"],
        ).toBeUndefined();
        f.callers.delete("reader");
        await expect(f.reader.get(first)).rejects.toThrow("401");
      });

      it("hides another Objective's results before pagination and revokes withdrawn byte access", async () => {
        const f = await fixture();
        const { artifact, first, contents } = await f.capture();
        await f.completeSource(artifact.id, ["findings.md"]);
        const outsider = await f.store.createTag({ name: "outsider" });
        const separate = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Work apart from the research",
        });
        // A Session of another Objective shares no artifacts, even by paging through them.
        await f.worker("outsider", outsider, { objectiveId: separate.id });
        expect((await f.command("find", { limit: 1 }, "outsider")).body).toEqual({ artifacts: [] });
        expect((await f.command("inspect", { artifactId: artifact.id }, "outsider")).status).toBe(
          404,
        );
        expect((await f.command("inspect", { artifactId: artifact.id }, "outsider")).body).toEqual(
          (await f.command("inspect", { artifactId: "absent" }, "outsider")).body,
        );
        // It reads the artifact only through an approved publication, and loses the bytes as soon
        // as the consumption approval is withdrawn, acquisition receipt or not.
        const actor = { kind: "tag" as const, tagId: f.owner.id };
        const publication = await f.store.approveArtifactPublication(
          {
            id: randomUUID(),
            artifactId: artifact.id,
            paths: ["findings.md"],
            audienceObjectiveIds: [separate.id],
          },
          actor,
        );
        const consumption = await f.store.approveArtifactConsumption(
          { id: randomUUID(), publicationApprovalId: publication.id, objectiveId: separate.id },
          actor,
        );
        await f.worker("approved", outsider, {
          objectiveId: separate.id,
          inputArtifacts: [
            {
              artifactId: artifact.id,
              path: "findings.md",
              digest: first.digest as string,
              provenance: {
                taskId: f.source.id,
                attemptId: f.attempts.get("writer") as string,
                publicationApproval: { id: publication.id, revision: publication.revision },
                consumptionApproval: { id: consumption.id, revision: consumption.revision },
              },
            },
          ],
        });
        const client = f.host("approved");
        expect(await client.get(first)).toEqual(contents);
        const acquired = await f.command(
          "acquire",
          {
            operationId: "read",
            artifactId: artifact.id,
            paths: ["findings.md"],
            delivery: "read",
          },
          "approved",
        );
        expect(acquired.status).toBe(200);
        await f.store.withdrawArtifactConsumption(
          { id: consumption.id, expectedRevision: consumption.revision },
          actor,
        );
        await expect(client.get(first)).rejects.toThrow("403");
      });

      it("distributes pinned research to 100 independent Attempts without rewriting Task inputs", async () => {
        const f = await fixture();
        const { artifact, first, contents } = await f.capture();
        const tokens = Array.from({ length: 100 }, (_, index) => `consumer-${index}`);
        for (const token of tokens) await f.worker(token);
        f.callers.delete("writer");
        for (let offset = 0; offset < tokens.length; offset += 10) {
          await Promise.all(
            tokens.slice(offset, offset + 10).map(async (token) => {
              const selected = await f.command(
                "acquire",
                {
                  operationId: "research",
                  artifactId: artifact.id,
                  paths: ["findings.md"],
                  delivery: "read",
                },
                token,
              );
              expect(selected.status).toBe(200);
              const bytes = await f.host(token).get(first);
              expect(bytes).toEqual(contents);
              expect(
                (
                  await f.command(
                    "settle",
                    { id: selected.body.acquisition.id, status: "delivered" },
                    token,
                  )
                ).status,
              ).toBe(200);
            }),
          );
        }
        for (const token of tokens) {
          const receipts = await f.store.listArtifactAcquisitions({
            attemptId: f.attempts.get(token) as string,
          });
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            status: "delivered",
            artifactId: artifact.id,
            paths: ["findings.md"],
          });
        }
      }, 60_000);
    },
  );
}
