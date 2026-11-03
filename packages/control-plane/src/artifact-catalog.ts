import { randomUUID } from "node:crypto";
import {
  type AnyArtifactTransferGrantClaims,
  ARTIFACT_CONTEXT_TYPE,
  ArtifactCatalogError,
  type ArtifactCatalogStore,
  type ArtifactSelection,
  type ArtifactTransferGrantClaims,
  advertisedWorkerHostLabels,
  artifactUnavailableMessage,
  artifactVolumeKey,
  artifactVolumeLabel,
  type CapturedArtifact,
  type CommitCapturedArtifactInput,
  isLoopbackAddress,
  type OperatorArtifactTransferGrantClaims,
  parseVolumeName,
  type RegisterWorkerArtifactCopiesInput,
  type RegisterWorkerArtifactCopiesResult,
  type ResolvedArtifactTransfer,
  type Store,
  type TagArtifactContextSnapshot,
  TagMessagingError,
  type Task,
  type TaskWorkspaceVolume,
  type Volume,
  validateCapturedArtifactInput,
  volumeCredentialLabel,
  type WorkerHost,
} from "@supertag/core";
import { WORKLET_ARTIFACT_TRANSFER_PATH } from "@supertag/worker-sdk";
import type { CoordinationCaller, ObjectiveController } from "./objective-controller.js";

type CatalogPersistence = ArtifactCatalogStore &
  Pick<
    Store,
    | "findTaskById"
    | "listTaskAttempts"
    | "getArtifactPublication"
    | "getArtifactConsumptionApproval"
    | "findWorkerHostById"
    | "findVolumeByName"
    | "listVolumes"
  >;
type CatalogAuthority = Pick<
  ObjectiveController,
  "authenticateExecution" | "authorizeArtifactSource" | "artifactDiscoveryTaskIds"
>;

/** The catalog owns metadata and access history. It never receives cloud credentials or file bytes. */
export class ArtifactCatalog {
  constructor(
    readonly store: CatalogPersistence,
    readonly authority: CatalogAuthority,
    readonly transferGrants?: {
      readonly sign: (claims: AnyArtifactTransferGrantClaims) => string;
      readonly ttlMs?: number;
      readonly now?: () => Date;
    },
  ) {}

  /** Host-authenticated API layers must derive Host identity and generation before calling. */
  async registerWorkerArtifactCopies(
    input: RegisterWorkerArtifactCopiesInput,
  ): Promise<RegisterWorkerArtifactCopiesResult> {
    return this.store.registerWorkerArtifactCopies(input);
  }

  /** Resolves metadata and capabilities only; artifact bytes never cross this boundary. */
  async resolveTransfer(
    token: string | undefined,
    value: unknown,
  ): Promise<ResolvedArtifactTransfer> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ArtifactCatalogError(400, "Artifact transfer arguments must be an object");
    const input = value as Record<string, unknown>;
    keys(input, ["artifactId", "path"]);
    const transferGrants = this.transferGrants;
    if (!transferGrants)
      throw new ArtifactCatalogError(503, "Direct artifact transfer is not configured");
    const { caller, task, attempt, attemptId } = await this.execution(token);
    const artifact = await this.visibleArtifact(text(input["artifactId"], "artifactId"), caller);
    const path = text(input["path"], "path", 1024);
    const entry = artifact.entries.find((candidate) => candidate.path === path);
    if (!entry) throw new TagMessagingError(404, "Artifact file not found");
    if (!(await this.permitsDownload(token, entry.digest)))
      throw new TagMessagingError(403, "Artifact is not an admitted input to this Attempt");

    const recipientWorkerHostId = attempt.workerSnapshot["workerHostId"];
    const recipientConnectionGeneration = attempt.workerSnapshot["connectionGeneration"];
    if (
      typeof recipientWorkerHostId !== "string" ||
      !recipientWorkerHostId ||
      !Number.isSafeInteger(recipientConnectionGeneration) ||
      Number(recipientConnectionGeneration) < 1
    )
      throw new ArtifactCatalogError(
        409,
        "Task Attempt has no authenticated Worker Host placement",
      );
    const recipient = await this.store.findWorkerHostById(recipientWorkerHostId);
    if (
      recipient?.enrollmentStatus !== "active" ||
      recipient.connectionStatus !== "connected" ||
      recipient.connectionGeneration !== recipientConnectionGeneration
    )
      throw new ArtifactCatalogError(409, "Recipient Worker Host connection is no longer current");

    const ttlMs = transferGrants.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000)
      throw new Error("Artifact transfer grant ttlMs must be 1 through 300000");
    const issuedAt = (transferGrants.now ?? (() => new Date()))();
    const expiresAt = new Date(issuedAt.getTime() + ttlMs).toISOString();
    // A digest is not authority: another artifact's host may hold the same bytes. Grant only from
    // the host whose Attempt captured this artifact, which recorded an upload of each entry.
    const sourceWorkerHostId = await this.producerWorkerHostId(artifact);
    const locations = (
      await this.store.listArtifactStorageLocations({
        digest: entry.digest,
        sizeBytes: entry.sizeBytes,
        status: "available",
      })
    ).filter((location) => location.workerHostId === sourceWorkerHostId);
    // Hosts that cannot reach each other share through a common Volume. The consumer reads a copy
    // there with its own mapping, so only the key the catalog recorded and the Volume's source and
    // credential name leave the catalog, and only to a host that advertises a mapping for that
    // Volume. Like direct transfers, these copies must belong to the producing host.
    const volumeCopies = (
      await this.store.listArtifactVolumeLocations({
        digest: entry.digest,
        sizeBytes: entry.sizeBytes,
        status: "available",
      })
    ).filter(
      (copy) =>
        sourceWorkerHostId !== undefined &&
        copy.workerHostId === sourceWorkerHostId &&
        copy.key === artifactVolumeKey(artifact.attemptId, entry.digest),
    );
    const volumesById = new Map(
      volumeCopies.length
        ? (await this.store.listVolumes()).map((volume) => [volume.id, volume] as const)
        : [],
    );
    const held = volumeCopies.flatMap((copy) => {
      const volume = volumesById.get(copy.volumeId);
      return volume ? [{ copy, volume }] : [];
    });
    const volumes = held
      .filter(({ volume }) => mapsVolume(recipient, volume))
      .map(({ copy, volume }) => ({
        volume: volume.name,
        source: volume.source,
        ...(volume.credential === undefined ? {} : { credential: volume.credential }),
        key: copy.key,
      }));
    const holders = {
      workerHostIds: [
        ...new Set([
          ...(sourceWorkerHostId === undefined ? [] : [sourceWorkerHostId]),
          ...locations.map((location) => location.workerHostId),
        ]),
      ],
      volumes: [...new Set(held.map(({ volume }) => volume.name))].sort(),
    };
    if (!locations.length && !volumes.length)
      throw new ArtifactCatalogError(
        409,
        artifactUnavailableMessage({ artifactId: artifact.id, path, holders }),
      );
    const digest = entry.digest.slice("sha256:".length);
    const resolved: ResolvedArtifactTransfer = {
      artifactId: artifact.id,
      path,
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
      volumes,
      holders,
      locations: locations.map((location) => {
        const claims: ArtifactTransferGrantClaims = {
          version: 1,
          grantId: randomUUID(),
          artifactId: artifact.id,
          path,
          digest: entry.digest,
          sizeBytes: entry.sizeBytes,
          sourceWorkerHostId: location.workerHostId,
          recipientWorkerHostId,
          recipientConnectionGeneration: Number(recipientConnectionGeneration),
          taskId: task.id,
          attemptId,
          issuedAt: issuedAt.toISOString(),
          expiresAt,
        };
        return {
          workerHostId: location.workerHostId,
          transferUrl: `${location.transferBaseUrl.replace(/\/$/u, "")}${WORKLET_ARTIFACT_TRANSFER_PATH}/${digest}`,
          grant: transferGrants.sign(claims),
        };
      }),
      expiresAt,
    };
    // Recheck exact Attempt liveness after every metadata lookup and before returning capabilities.
    await this.execution(token);
    return resolved;
  }

  /**
   * Where an authenticated operator can read one artifact file, for `supertag download artifact`.
   * The API layer must authenticate an administrator and derive `operatorId` before calling.
   * Returns the producing host's transfer endpoints, each with a short-lived grant bound to this
   * file and operator, and the producing host's recorded Volume copies: the operator's machine reads
   * those only with its own mapping for the Volume's credential name. Never bytes, and never a
   * credential value. When nothing holds the file, both lists are empty and `holders` says so.
   */
  async resolveOperatorDownload(
    operatorId: string,
    artifactId: string,
    value: unknown,
    connection?: {
      /** Derived from the API request socket, never a header or request body. */
      readonly operatorAddress: string | undefined;
      /** Configured public Control Plane URL, never the request Host header. */
      readonly publicUrl?: string | undefined;
      /** Checks the live authenticated host connection against the inventory generation. */
      readonly hostConnectionIsLoopback: (workerHostId: string, generation: number) => boolean;
    },
  ): Promise<ResolvedArtifactTransfer> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ArtifactCatalogError(400, "Artifact download arguments must be an object");
    const input = value as Record<string, unknown>;
    keys(input, ["path"]);
    const path = text(input["path"], "path", 1024);
    const artifact = await this.store.findCapturedArtifact(text(artifactId, "artifactId"));
    if (!artifact) throw new TagMessagingError(404, "Artifact does not exist");
    const entry = artifact.entries.find((candidate) => candidate.path === path);
    if (!entry) throw new TagMessagingError(404, "Artifact file not found");
    const query = {
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
      status: "available" as const,
    };
    const sourceWorkerHostId = await this.producerWorkerHostId(artifact);
    // As for a consuming host, only the producing host's copy is granted: a digest is not
    // authority, and another artifact's host may hold the same bytes.
    const locations = (await this.store.listArtifactStorageLocations(query)).filter(
      (location) => location.workerHostId === sourceWorkerHostId,
    );
    const volumeCopies = (await this.store.listArtifactVolumeLocations(query)).filter(
      (copy) =>
        sourceWorkerHostId !== undefined &&
        copy.workerHostId === sourceWorkerHostId &&
        copy.key === artifactVolumeKey(artifact.attemptId, entry.digest),
    );
    const volumesById = new Map(
      volumeCopies.length
        ? (await this.store.listVolumes()).map((volume) => [volume.id, volume] as const)
        : [],
    );
    const volumes = volumeCopies.flatMap((copy) => {
      const volume = volumesById.get(copy.volumeId);
      return volume
        ? [
            {
              volume: volume.name,
              source: volume.source,
              ...(volume.credential === undefined ? {} : { credential: volume.credential }),
              key: copy.key,
            },
          ]
        : [];
    });
    const holders = {
      workerHostIds: [
        ...new Set([
          ...(sourceWorkerHostId === undefined ? [] : [sourceWorkerHostId]),
          ...locations.map((location) => location.workerHostId),
        ]),
      ],
      volumes: [...new Set(volumes.map((copy) => copy.volume))].sort(),
    };
    const transferGrants = this.transferGrants;
    const ttlMs = transferGrants?.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000)
      throw new Error("Artifact transfer grant ttlMs must be 1 through 300000");
    const issuedAt = (transferGrants?.now ?? (() => new Date()))();
    const expiresAt = new Date(issuedAt.getTime() + ttlMs).toISOString();
    const digest = entry.digest.slice("sha256:".length);
    return {
      artifactId: artifact.id,
      path,
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
      volumes,
      holders,
      // Without a signing key no host serves the operator directly; Volume copies still apply.
      locations:
        transferGrants === undefined
          ? []
          : locations
              .filter((location) => {
                if (!operatorLocalEndpoint(location.transferBaseUrl)) return true;
                // A public proxy can make remote clients appear to be loopback peers.
                // Require a local public URL as well as both live socket peers.
                return (
                  eligibleLocalEndpoint(location.transferBaseUrl) &&
                  eligibleLocalEndpoint(connection?.publicUrl) &&
                  isLoopbackAddress(connection?.operatorAddress) &&
                  connection?.hostConnectionIsLoopback(
                    location.workerHostId,
                    location.connectionGeneration,
                  ) === true
                );
              })
              .map((location) => {
                const claims: OperatorArtifactTransferGrantClaims = {
                  version: 1,
                  grantId: randomUUID(),
                  artifactId: artifact.id,
                  path,
                  digest: entry.digest,
                  sizeBytes: entry.sizeBytes,
                  sourceWorkerHostId: location.workerHostId,
                  recipientOperatorId: operatorId,
                  issuedAt: issuedAt.toISOString(),
                  expiresAt,
                };
                return {
                  workerHostId: location.workerHostId,
                  transferUrl: `${location.transferBaseUrl.replace(/\/$/u, "")}${WORKLET_ARTIFACT_TRANSFER_PATH}/${digest}`,
                  grant: transferGrants.sign(claims),
                };
              }),
      expiresAt,
    };
  }

  /** The Worker Host of the Attempt that captured the artifact, from its placement snapshot. */
  private async producerWorkerHostId(artifact: CapturedArtifact): Promise<string | undefined> {
    const attempts = await this.store.listTaskAttempts(artifact.taskId);
    const producer = attempts.find((attempt) => attempt.id === artifact.attemptId);
    const workerHostId = producer?.workerSnapshot["workerHostId"];
    return typeof workerHostId === "string" && workerHostId ? workerHostId : undefined;
  }

  async execution(token: string | undefined) {
    const caller = await this.authority.authenticateExecution(token);
    const task = await this.store.findTaskById(caller.taskId);
    if (!task) throw new TagMessagingError(401, "Artifact Attempt is unavailable");
    const attempts = await this.store.listTaskAttempts(task.id);
    const attempt = attempts.find((candidate) =>
      "kind" in caller
        ? candidate.id === caller.attemptId && candidate.status === "running"
        : candidate.attemptNumber === caller.attemptCount && candidate.status === "running",
    );
    if (!attempt) throw new TagMessagingError(401, "Artifact Attempt is unavailable");
    return { caller, task, attempt, attemptId: attempt.id };
  }

  async command(name: string, value: unknown, token: string | undefined): Promise<unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ArtifactCatalogError(400, "Artifact arguments must be an object");
    const input = value as Record<string, unknown>;
    const context = await this.execution(token);
    const { caller, task, attemptId } = context;
    switch (name) {
      case "find": {
        keys(input, ["query", "kind", "taskId", "limit", "cursor"]);
        const taskIds = await this.authority.artifactDiscoveryTaskIds(caller);
        const page = await this.store.listCapturedArtifacts({
          ...("kind" in caller
            ? { sessionId: task.sessionId }
            : { objectiveId: caller.objectiveId }),
          ...(taskIds === undefined ? {} : { taskIds }),
          includeArtifactIds: [...(await this.admittedSelections(task)).keys()],
          ...(input["query"] === undefined ? {} : { query: text(input["query"], "query", 1000) }),
          ...(input["kind"] === undefined ? {} : { kind: text(input["kind"], "kind") }),
          ...(input["taskId"] === undefined ? {} : { taskId: text(input["taskId"], "taskId") }),
          ...(input["cursor"] === undefined
            ? {}
            : { cursor: text(input["cursor"], "cursor", 2048) }),
          ...(input["limit"] === undefined ? {} : { limit: integer(input["limit"], 1, 50) }),
        });
        const artifacts: CapturedArtifact[] = [];
        for (const artifact of page.artifacts) {
          try {
            artifacts.push(await this.visibleArtifact(artifact.id, caller));
          } catch (error) {
            if (!(error instanceof TagMessagingError) || error.statusCode !== 404) throw error;
          }
        }
        await this.execution(token);
        return {
          ...page,
          artifacts: artifacts.map(
            ({ entries, operationId: _operation, inputs: _inputs, summary, ...artifact }) => ({
              ...artifact,
              ...(summary === undefined ? {} : { summary: summary.slice(0, 512) }),
              entryCount: entries.length,
              sizeBytes: entries.reduce((size, entry) => size + entry.sizeBytes, 0),
            }),
          ),
        };
      }
      case "inspect": {
        keys(input, ["artifactId"]);
        const artifact = await this.visibleArtifact(
          text(input["artifactId"], "artifactId"),
          caller,
        );
        await this.execution(token);
        return { artifact };
      }
      case "capture": {
        keys(input, ["operationId", "title", "summary", "kind", "entries", "harnessSession"]);
        const definition: CommitCapturedArtifactInput = {
          operationId: text(input["operationId"], "operationId"),
          taskId: task.id,
          attemptId,
          tagId: task.tagId,
          sessionId: task.sessionId,
          ...(input["harnessSession"] === undefined
            ? {}
            : {
                harnessSession: input["harnessSession"] as NonNullable<
                  CommitCapturedArtifactInput["harnessSession"]
                >,
              }),
          ...("kind" in caller
            ? task.surfaceObjectiveId
              ? { objectiveId: task.surfaceObjectiveId }
              : {}
            : { objectiveId: caller.objectiveId }),
          title: text(input["title"], "title"),
          ...(input["summary"] === undefined
            ? {}
            : { summary: text(input["summary"], "summary", 16000) }),
          kind: text(input["kind"], "kind"),
          entries: input["entries"] as CommitCapturedArtifactInput["entries"],
          inputs: await this.suppliedInputs(task, attemptId),
        };
        // The Store validates lineage after resolving capture retries, which retain their original inputs.
        validateCapturedArtifactInput({ ...definition, inputs: [] });
        await this.execution(token);
        return { artifact: await this.store.commitCapturedArtifact(definition) };
      }
      case "acquire": {
        keys(input, ["operationId", "artifactId", "paths", "delivery", "destination"]);
        const artifact = await this.visibleArtifact(
          text(input["artifactId"], "artifactId"),
          caller,
        );
        if (input["delivery"] !== "read" && input["delivery"] !== "materialize")
          throw new ArtifactCatalogError(400, "Invalid artifact delivery");
        if (
          !Array.isArray(input["paths"]) ||
          input["paths"].some(
            (path) =>
              typeof path !== "string" || !artifact.entries.some((entry) => entry.path === path),
          )
        )
          throw new TagMessagingError(404, "Artifact file not found");
        await this.execution(token);
        const acquisition = await this.store.acquireCapturedArtifact({
          operationId: text(input["operationId"], "operationId"),
          artifactId: artifact.id,
          taskId: task.id,
          attemptId,
          paths: input["paths"] as readonly string[],
          delivery: input["delivery"],
          ...(input["destination"] === undefined
            ? {}
            : { destination: text(input["destination"], "destination", 1024) }),
        });
        return { artifact, acquisition };
      }
      case "settle": {
        keys(input, ["id", "status"]);
        if (!["delivered", "failed", "uncertain"].includes(String(input["status"])))
          throw new ArtifactCatalogError(400, "Invalid artifact delivery status");
        const acquisition = await this.store.settleArtifactAcquisition({
          id: text(input["id"], "id"),
          attemptId,
          status: input["status"] as "delivered" | "failed" | "uncertain",
        });
        return { acquisition };
      }
      default:
        throw new ArtifactCatalogError(404, "Unknown artifact operation");
    }
  }

  /**
   * Records an Attempt's receipt for bytes its Worker Host stored. `volume`, when given, names the
   * artifact Volume the host wrote them to: the Attempt's host must advertise that Volume as its
   * artifact Volume. The key comes from the authenticated Task Attempt and digest:
   * `attempts/ATTEMPT_ID/sha256/HEX` beneath the Volume's source, never a key the host chose.
   * `volumeSource` binds the receipt to the source used for the write, checked under the copy-insert
   * lock. Without `volume`, the copy is on the host itself, advertised through its inventory.
   */
  async recordUpload(
    token: string | undefined,
    digest: string,
    sizeBytes: number,
    volume?: string,
    volumeSource?: string,
  ): Promise<void> {
    const { task, attempt, attemptId } = await this.execution(token);
    if (
      (volume === undefined) !== (volumeSource === undefined) ||
      (volumeSource !== undefined && (typeof volumeSource !== "string" || !volumeSource))
    )
      throw new ArtifactCatalogError(
        400,
        "Artifact Volume receipts require volume and volumeSource together",
      );
    const onVolume =
      volume === undefined ? undefined : await this.#attemptArtifactVolume(attempt, volume);
    if (onVolume !== undefined)
      await this.store.recordArtifactVolumeCopy({
        volumeId: onVolume.volumeId,
        source: volumeSource as string,
        key: artifactVolumeKey(attemptId, digest),
        digest,
        sizeBytes,
        workerHostId: onVolume.workerHostId,
        observedAt: new Date().toISOString(),
      });
    await this.store.recordArtifactUpload({ taskId: task.id, attemptId, digest, sizeBytes });
  }

  /** The Volume and host an Attempt's receipt names, when its host stores artifacts there. */
  async #attemptArtifactVolume(
    attempt: { readonly workerSnapshot: Readonly<Record<string, unknown>> },
    value: string,
  ): Promise<{ readonly volumeId: string; readonly workerHostId: string }> {
    const volume = parseVolumeName(value, "Artifact Volume name");
    const workerHostId = attempt.workerSnapshot["workerHostId"];
    if (typeof workerHostId !== "string" || !workerHostId)
      throw new ArtifactCatalogError(
        409,
        "Task Attempt has no authenticated Worker Host placement",
      );
    const host = await this.store.findWorkerHostById(workerHostId);
    if (host?.enrollmentStatus !== "active")
      throw new ArtifactCatalogError(409, "Worker Host is not enrolled");
    if (!storesArtifactsOn(host, volume))
      throw new ArtifactCatalogError(
        403,
        `Worker Host ${host.id} does not store artifacts on Volume ${volume}`,
      );
    const found = await this.store.findVolumeByName(volume);
    if (!found) throw new ArtifactCatalogError(404, `Volume ${volume} not found`);
    return { volumeId: found.id, workerHostId: host.id };
  }

  /**
   * The artifact Volume an authenticated Worker Host advertises, as the catalog holds it: its
   * source and the name of its credential, never a value. The host maps the name itself.
   * Host-authenticated API layers must authenticate the host before calling.
   */
  async workerHostArtifactVolume(host: WorkerHost, value: unknown): Promise<TaskWorkspaceVolume> {
    const name = parseVolumeName(value, "Artifact Volume name");
    if (!storesArtifactsOn(host, name))
      throw new ArtifactCatalogError(
        403,
        `Worker Host ${host.id} does not advertise Volume ${name} as its artifact Volume`,
      );
    const volume = await this.store.findVolumeByName(name);
    if (!volume) throw new ArtifactCatalogError(404, `Volume ${name} not found`);
    return {
      name: volume.name,
      source: volume.source,
      ...(volume.credential === undefined ? {} : { credential: volume.credential }),
    };
  }

  /** Each fetch checks both the exact Attempt receipt and current source visibility. */
  async permitsDownload(token: string | undefined, digest: string): Promise<boolean> {
    const { caller, task, attemptId } = await this.execution(token);
    for (const input of originalInputs(task)) {
      if (input["digest"] !== digest || typeof input["artifactId"] !== "string") continue;
      try {
        const artifact = await this.visibleArtifact(input["artifactId"], caller);
        if (
          artifact.entries.some((entry) => entry.path === input["path"] && entry.digest === digest)
        )
          return true;
      } catch (error) {
        if (!(error instanceof TagMessagingError) || error.statusCode !== 404) throw error;
      }
    }
    const acquisitions = await this.store.listArtifactAcquisitions({ attemptId });
    for (const acquisition of acquisitions) {
      if (acquisition.status === "failed") continue;
      let artifact: CapturedArtifact;
      try {
        artifact = await this.visibleArtifact(acquisition.artifactId, caller);
      } catch (error) {
        if (error instanceof TagMessagingError && error.statusCode === 404) continue;
        throw error;
      }
      if (
        artifact.entries.some(
          (entry) => entry.digest === digest && acquisition.paths.includes(entry.path),
        )
      )
        return true;
    }
    return false;
  }

  private async admittedSelections(task: Task): Promise<Map<string, Set<string> | undefined>> {
    const selections = new Map<string, Set<string> | undefined>();
    for (const id of contextArtifactIds(task)) selections.set(id, undefined);
    for (const input of originalInputs(task)) {
      const artifactId = input["artifactId"],
        path = input["path"];
      if (typeof artifactId !== "string" || typeof path !== "string") continue;
      const provenance = record(input["provenance"]);
      const publication = record(provenance?.["publicationApproval"]);
      const consumption = record(provenance?.["consumptionApproval"]);
      if (publication || consumption) {
        if (typeof publication?.["id"] !== "string" || typeof consumption?.["id"] !== "string")
          continue;
        const [published, consumed] = await Promise.all([
          this.store.getArtifactPublication(publication["id"]),
          this.store.getArtifactConsumptionApproval(consumption["id"]),
        ]);
        if (
          !published ||
          !consumed ||
          published.status !== "available" ||
          consumed.status !== "available" ||
          published.artifactId !== artifactId ||
          !published.paths.includes(path) ||
          published.revision !== publication["revision"] ||
          consumed.revision !== consumption["revision"] ||
          consumed.publicationApprovalId !== published.id
        )
          continue;
      }
      if (selections.has(artifactId) && selections.get(artifactId) === undefined) continue;
      const paths = selections.get(artifactId) ?? new Set<string>();
      paths.add(path);
      selections.set(artifactId, paths);
    }
    return selections;
  }

  private async suppliedInputs(
    task: Task,
    attemptId: string,
  ): Promise<readonly ArtifactSelection[]> {
    const inputs = new Map<string, Set<string>>();
    const add = (artifactId: string, paths: readonly string[]) => {
      const selected = inputs.get(artifactId) ?? new Set<string>();
      for (const path of paths) selected.add(path);
      inputs.set(artifactId, selected);
    };
    for (const input of originalInputs(task)) {
      if (typeof input["artifactId"] === "string" && typeof input["path"] === "string")
        add(input["artifactId"], [input["path"]]);
    }
    for (const acquisition of await this.store.listArtifactAcquisitions({ attemptId }))
      if (acquisition.status === "delivered") add(acquisition.artifactId, acquisition.paths);
    return [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([artifactId, paths]) => ({ artifactId, paths: [...paths].sort() }));
  }

  private async visibleInputs(
    inputs: readonly ArtifactSelection[],
    caller: CoordinationCaller,
  ): Promise<readonly ArtifactSelection[]> {
    const task = await this.store.findTaskById(caller.taskId);
    const admitted = task
      ? await this.admittedSelections(task)
      : new Map<string, Set<string> | undefined>();
    const visible: ArtifactSelection[] = [];
    for (const input of inputs) {
      const source = await this.store.findCapturedArtifact(input.artifactId);
      if (!source) continue;
      try {
        await this.authority.authorizeArtifactSource(caller, source.taskId);
        visible.push(input);
      } catch (error) {
        if (!(error instanceof TagMessagingError) || error.statusCode !== 404) throw error;
        if (!admitted.has(input.artifactId)) continue;
        const paths = admitted.get(input.artifactId);
        const selected =
          paths === undefined ? input.paths : input.paths.filter((path) => paths.has(path));
        if (selected.length) visible.push({ artifactId: input.artifactId, paths: selected });
      }
    }
    return visible;
  }

  private async visibleArtifact(id: string, caller: CoordinationCaller): Promise<CapturedArtifact> {
    const artifact = await this.store.findCapturedArtifact(id);
    if (!artifact) throw new TagMessagingError(404, "Artifact not found");
    try {
      await this.authority.authorizeArtifactSource(caller, artifact.taskId);
      return { ...artifact, inputs: await this.visibleInputs(artifact.inputs, caller) };
    } catch (error) {
      if (!(error instanceof TagMessagingError) || error.statusCode !== 404) throw error;
    }
    const task = await this.store.findTaskById(caller.taskId);
    const selections = task
      ? await this.admittedSelections(task)
      : new Map<string, Set<string> | undefined>();
    if (!selections.has(id)) throw new TagMessagingError(404, "Artifact not found");
    const paths = selections.get(id);
    return paths === undefined
      ? { ...artifact, inputs: await this.visibleInputs(artifact.inputs, caller) }
      : {
          ...artifact,
          entries: artifact.entries.filter((entry) => paths.has(entry.path)),
          // A restricted publication does not expose upstream artifacts outside its grant.
          inputs: [],
        };
  }
}

function text(value: unknown, name: string, maximum = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new ArtifactCatalogError(400, `Invalid artifact ${name}`);
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new ArtifactCatalogError(400, "Invalid artifact page limit");
  return value;
}
function keys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new ArtifactCatalogError(400, "Unknown artifact argument");
}

function contextArtifactIds(task: Task): readonly string[] {
  return task.contextPlan.sets.flatMap((set) =>
    set.items.flatMap((item) =>
      item.type === ARTIFACT_CONTEXT_TYPE && item.version === 1
        ? ((item.snapshot as TagArtifactContextSnapshot | undefined)?.artifacts ?? []).map(
            (artifact) => artifact.id,
          )
        : [],
    ),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function originalInputs(task: Task): readonly Record<string, unknown>[] {
  const inputs = task.trigger["inputArtifacts"];
  return Array.isArray(inputs)
    ? inputs.flatMap((input) => {
        const value = record(input);
        return value ? [value] : [];
      })
    : [];
}

/**
 * Whether a host advertises a way to read a Volume: as its artifact Volume, or by mapping the
 * Volume's credential name in `volume-credentials`. Self-reported, so it never grants access; it
 * only keeps a Volume's location from hosts that could not read it anyway.
 */
function mapsVolume(
  host: Pick<WorkerHost, "labels" | "workerSnapshot">,
  volume: Pick<Volume, "name" | "credential">,
): boolean {
  if (storesArtifactsOn(host, volume.name)) return true;
  if (volume.credential === undefined) return false;
  const label = volumeCredentialLabel(volume.credential);
  return (
    host.labels.includes(label) || advertisedWorkerHostLabels(host.workerSnapshot).includes(label)
  );
}

/** Whether a host advertises the named Volume as its artifact Volume. Self-reported. */
function storesArtifactsOn(
  host: Pick<WorkerHost, "labels" | "workerSnapshot">,
  volume: string,
): boolean {
  const label = artifactVolumeLabel(volume);
  return (
    host.labels.includes(label) || advertisedWorkerHostLabels(host.workerSnapshot).includes(label)
  );
}

function operatorLocalEndpoint(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/u, "");
  return (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname === "localhost4" ||
    hostname === "localhost4.localdomain4" ||
    hostname === "localhost6" ||
    hostname === "localhost6.localdomain6" ||
    hostname === "ip6-localhost" ||
    hostname === "ip6-loopback" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.") ||
    hostname === "[::]" ||
    hostname === "[::1]" ||
    /^\[::7f[0-9a-f]{2}:[0-9a-f]+\]$/u.test(hostname) ||
    hostname === "[::ffff:0:0]" ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:|127\.)/u.test(hostname)
  );
}

// Only unambiguous local destinations qualify; OS-specific localhost aliases do not.
function eligibleLocalEndpoint(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const hostname = new URL(value).hostname;
    const address = hostname.replace(/^\[|\]$/gu, "");
    return (
      hostname === "localhost" ||
      isLoopbackAddress(address) ||
      /^\[::7f[0-9a-f]{2}:[0-9a-f]+\]$/u.test(hostname)
    );
  } catch {
    return false;
  }
}
