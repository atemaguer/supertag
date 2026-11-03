import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidGitRef, type TaskNamedWorkspacePlan } from "@supertag/core";
import type { WorkspaceHost, WorkspaceRepository } from "./workspace-environment.js";

type Ownership = { branch: string; head?: string };

/** Host-private ownership survives worktree removal. Call allocation under the repository lock. */
export class WorkspaceBranches {
  constructor(private readonly host: WorkspaceHost) {}

  async #file(repository: WorkspaceRepository): Promise<string> {
    const common = await realpath(
      (
        await this.host.run(repository.path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    );
    return join(
      this.host.root,
      "branches",
      createHash("sha256").update(common).digest("hex"),
      "owners.json",
    );
  }

  async #read(repository: WorkspaceRepository): Promise<Record<string, Ownership>> {
    const contents = await readFile(await this.#file(repository), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      },
    );
    const records: unknown = JSON.parse(contents);
    if (
      typeof records !== "object" ||
      records === null ||
      Array.isArray(records) ||
      Object.values(records).some(
        (value) =>
          !(
            (typeof value === "string" && isValidGitRef(value)) ||
            (typeof value === "object" &&
              value !== null &&
              !Array.isArray(value) &&
              "branch" in value &&
              typeof value.branch === "string" &&
              isValidGitRef(value.branch) &&
              "head" in value &&
              typeof value.head === "string" &&
              (value.head === "deleted" || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value.head)))
          ),
      )
    )
      throw new Error("Invalid Task branch ownership record");
    return Object.fromEntries(
      Object.entries(records).map(([id, value]) => [
        id,
        typeof value === "string" ? { branch: value } : value,
      ]),
    ) as Record<string, Ownership>;
  }

  async recorded(repository: WorkspaceRepository, taskId: string): Promise<string | undefined> {
    const records = await this.#read(repository);
    return Object.hasOwn(records, taskId) ? records[taskId]?.branch : undefined;
  }

  async allocate(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    taskId: string,
  ): Promise<TaskNamedWorkspacePlan> {
    const records = await this.#read(repository);
    const recorded = Object.hasOwn(records, taskId) ? records[taskId] : undefined;
    const refs = (
      await this.host.run(repository.path, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
        "refs/remotes/origin/",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/(?:heads|remotes\/origin)\//u, ""));
    if (recorded) {
      if (
        Object.entries(records).some(
          ([id, owner]) =>
            id !== taskId && owner.branch.toLowerCase() === recorded.branch.toLowerCase(),
        )
      )
        throw new Error("Recorded Task branch conflicts with another branch");
      const local = `refs/heads/${recorded.branch}`;
      const remote = `refs/remotes/origin/${recorded.branch}`;
      const localHead = (await this.host.hasRef(repository.path, local))
        ? await this.host.commit(repository.path, local, "Recorded Task branch is unreadable")
        : undefined;
      const remoteHead = (await this.host.hasRef(repository.path, remote))
        ? await this.host.commit(
            repository.path,
            remote,
            "Recorded remote Task branch is unreadable",
          )
        : undefined;
      if (recorded.head === "deleted" && localHead === undefined && remoteHead === undefined) {
        const unpinned = { ...plan, branch: recorded.branch };
        delete unpinned.branchPin;
        return unpinned;
      }
      if (
        recorded.head &&
        recorded.head !== "deleted" &&
        (localHead === undefined || localHead === recorded.head) &&
        (remoteHead === undefined || remoteHead === recorded.head)
      ) {
        if (localHead === undefined)
          await this.host.run(repository.path, [
            "update-ref",
            local,
            recorded.head,
            "0".repeat(recorded.head.length),
          ]);
        return { ...plan, branch: recorded.branch, branchPin: recorded.branch };
      }
    }
    // A new Worker Host has no local record. The Control Plane pins the branch from this Task's
    // stored workspace input. The Worker's recorded head must remain in the fetched branch's
    // history; a reused name or replaced remote ref is not ownership evidence.
    if (
      recorded === undefined &&
      repository.managed &&
      plan.branchPin === plan.branch &&
      typeof plan.branchPinHead === "string" &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(plan.branchPinHead) &&
      refs.filter((ref) => ref.toLowerCase() === plan.branch.toLowerCase()).length === 1 &&
      !(await this.host.hasRef(repository.path, `refs/heads/${plan.branch}`)) &&
      (await this.host.hasRef(repository.path, `refs/remotes/origin/${plan.branch}`)) &&
      (await this.host
        .run(repository.path, [
          "merge-base",
          "--is-ancestor",
          plan.branchPinHead,
          `refs/remotes/origin/${plan.branch}`,
        ])
        .then(
          () => true,
          () => false,
        ))
    )
      return plan;
    const occupied = new Set(
      [...refs, ...Object.values(records).map((owner) => owner.branch)].map((branch) =>
        branch.toLowerCase(),
      ),
    );
    let branch = plan.branch;
    const suffix = createHash("sha256")
      .update(`${plan.branch}\n${taskId}`)
      .digest("hex")
      .slice(0, 8);
    for (let index = 0; occupied.has(branch.toLowerCase()); index += 1)
      branch = `${plan.branch}-${suffix}${index ? `-${(index + 1).toString(36)}` : ""}`;
    const unpinned = { ...plan, branch };
    delete unpinned.branchPin;
    return unpinned;
  }

  /** Create the ref before releasing allocation's lock, so another host root also sees it. */
  async record(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    taskId: string,
    head: string,
  ): Promise<void> {
    const ref = `refs/heads/${plan.branch}`;
    if (!(await this.host.hasRef(repository.path, ref)))
      await this.host.run(repository.path, ["update-ref", ref, head, "0".repeat(head.length)]);
    else if ((await this.host.commit(repository.path, ref, "Task branch is unreadable")) !== head)
      throw new Error("Task branch changed before ownership was recorded");
    const records = await this.#read(repository);
    const file = await this.#file(repository);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ ...records, [taskId]: { branch: plan.branch, head } }),
      {
        mode: 0o600,
      },
    );
    await rename(`${file}.tmp`, file);
  }

  async advance(
    repository: WorkspaceRepository,
    taskId: string,
    branch: string,
    head: string,
    allowMissing = false,
  ): Promise<void> {
    const records = await this.#read(repository);
    if (records[taskId]?.branch !== branch) throw new Error("Task branch ownership changed");
    const ref = `refs/heads/${branch}`;
    const present = await this.host.hasRef(repository.path, ref);
    if (!present && !allowMissing)
      throw new Error("Task branch disappeared before ownership was updated");
    if (
      present &&
      (await this.host.commit(repository.path, ref, "Task branch is unreadable")) !== head
    )
      throw new Error("Task branch changed before ownership was updated");
    const file = await this.#file(repository);
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ ...records, [taskId]: { branch, head: present ? head : "deleted" } }),
      {
        mode: 0o600,
      },
    );
    await rename(`${file}.tmp`, file);
  }
}
