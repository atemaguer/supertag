import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidGitRef, type TaskNamedWorkspacePlan } from "@supertag/core";
import type { WorkspaceHost, WorkspaceRepository } from "./workspace-environment.js";

type Ownership = { branch: string; head?: string };

/** A Workspace setup failure the Task Attempt reports as it is. */
function refusal(message: string): Error {
  const error = new Error(message);
  error.name = "WorkspaceSetupError";
  return error;
}

/**
 * Host-private branch ownership, keyed by owner: a Task's Session, so every Task of the Session
 * continues one branch, or the Task itself when it names no Session. Ownership survives worktree
 * removal. Call allocation under the repository lock.
 */
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

  async recorded(repository: WorkspaceRepository, owner: string): Promise<string | undefined> {
    const records = await this.#read(repository);
    return Object.hasOwn(records, owner) ? records[owner]?.branch : undefined;
  }

  /**
   * The plan's branch for `owner`. The branch it recorded is continued, pinned, from the newer of
   * its local and origin copies while that copy still holds the head it recorded: a commit a
   * reviewer pushed, or a local commit whose push failed, stays on it. A recorded branch rewritten
   * without that head, or whose copies diverged, is refused rather than replaced. Without a
   * record, a branch the Control Plane pinned at a head another host recorded is adopted when this
   * repository holds that head on it, and refused when the branch is not here at all. Otherwise
   * the owner gets a name no other branch or owner holds, starting afresh: a branch of the same
   * name that `owner` did not record, such as a person's or another Session's, is never taken.
   */
  async allocate(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    owner: string,
  ): Promise<TaskNamedWorkspacePlan> {
    const records = await this.#read(repository);
    const recorded = Object.hasOwn(records, owner) ? records[owner] : undefined;
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
          ([id, other]) =>
            id !== owner && other.branch.toLowerCase() === recorded.branch.toLowerCase(),
        )
      )
        throw new Error("Recorded Task branch conflicts with another branch");
      // A deleted name is free again only while no branch, local or on origin, has taken it.
      if (recorded.head === "deleted" && !refs.includes(recorded.branch)) {
        const unpinned = { ...plan, branch: recorded.branch };
        delete unpinned.branchPin;
        return unpinned;
      }
      if (recorded.head && recorded.head !== "deleted") {
        const copies = await this.#copies(repository, recorded.branch);
        if (copies.length === 0) {
          await this.host.run(repository.path, [
            "update-ref",
            `refs/heads/${recorded.branch}`,
            recorded.head,
            "0".repeat(recorded.head.length),
          ]);
          return { ...plan, branch: recorded.branch, branchPin: recorded.branch };
        }
        if (await this.#continues(repository, copies, recorded.head))
          return { ...plan, branch: recorded.branch, branchPin: recorded.branch };
        throw refusal(
          `Branch ${recorded.branch} no longer holds commit ${recorded.head.slice(0, 12)}, the last one this Worker Host recorded on it, or its local and origin copies diverged; restore the branch so it contains that commit, then retry`,
        );
      }
    }
    // A new Worker Host has no local record. The Control Plane pins the branch a Worker recorded
    // for this Task, or for its Session's earlier Tasks. The recorded head must remain in the
    // branch's history here; a reused name or replaced ref is not ownership evidence.
    if (
      recorded === undefined &&
      plan.branchPin === plan.branch &&
      typeof plan.branchPinHead === "string" &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(plan.branchPinHead)
    ) {
      const named = refs.filter((ref) => ref.toLowerCase() === plan.branch.toLowerCase());
      if (named.length === 0)
        throw refusal(
          `Branch ${plan.branch} holds commit ${plan.branchPinHead.slice(0, 12)} on another Worker Host and was not pushed to this Workspace's source; run this Task on that Worker Host, or deliver the Workspace by pull request so its branch is pushed`,
        );
      const copies =
        named.every((ref) => ref === plan.branch) &&
        !Object.values(records).some(
          (other) => other.branch.toLowerCase() === plan.branch.toLowerCase(),
        )
          ? await this.#copies(repository, plan.branch)
          : [];
      if (copies.length > 0 && (await this.#continues(repository, copies, plan.branchPinHead)))
        return plan;
    }
    const occupied = new Set(
      [...refs, ...Object.values(records).map((owner) => owner.branch)].map((branch) =>
        branch.toLowerCase(),
      ),
    );
    let branch = plan.branch;
    const suffix = createHash("sha256")
      .update(`${plan.branch}\n${owner}`)
      .digest("hex")
      .slice(0, 8);
    for (let index = 0; occupied.has(branch.toLowerCase()); index += 1)
      branch = `${plan.branch}-${suffix}${index ? `-${(index + 1).toString(36)}` : ""}`;
    const unpinned = { ...plan, branch };
    delete unpinned.branchPin;
    return unpinned;
  }

  /**
   * The heads of a branch's local copy and, in a managed clone, its origin copy. A declared
   * checkout's origin copies are whatever its owner last fetched, so they are not read.
   */
  async #copies(repository: WorkspaceRepository, branch: string): Promise<readonly string[]> {
    const copies: string[] = [];
    for (const ref of [
      `refs/heads/${branch}`,
      ...(repository.managed ? [`refs/remotes/origin/${branch}`] : []),
    ])
      if (await this.host.hasRef(repository.path, ref))
        copies.push(await this.host.commit(repository.path, ref, `Branch ${ref} is unreadable`));
    return copies;
  }

  /** Whether the newer of a branch's copies holds `head`, when one copy holds the other. */
  async #continues(
    repository: WorkspaceRepository,
    copies: readonly string[],
    head: string,
  ): Promise<boolean> {
    const contains = (ancestor: string, commit: string) =>
      ancestor === commit
        ? Promise.resolve(true)
        : this.host.run(repository.path, ["merge-base", "--is-ancestor", ancestor, commit]).then(
            () => true,
            () => false,
          );
    let newest = copies[0] as string;
    for (const copy of copies.slice(1)) {
      if (await contains(newest, copy)) newest = copy;
      else if (!(await contains(copy, newest))) return false;
    }
    return contains(head, newest);
  }

  /** Create the ref before releasing allocation's lock, so another host root also sees it. */
  async record(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    owner: string,
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
      JSON.stringify({ ...records, [owner]: { branch: plan.branch, head } }),
      {
        mode: 0o600,
      },
    );
    await rename(`${file}.tmp`, file);
  }

  async advance(
    repository: WorkspaceRepository,
    owner: string,
    branch: string,
    head: string,
    allowMissing = false,
  ): Promise<void> {
    const records = await this.#read(repository);
    if (records[owner]?.branch !== branch) throw new Error("Task branch ownership changed");
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
      JSON.stringify({ ...records, [owner]: { branch, head: present ? head : "deleted" } }),
      {
        mode: 0o600,
      },
    );
    await rename(`${file}.tmp`, file);
  }
}
