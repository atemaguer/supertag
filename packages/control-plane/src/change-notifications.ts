import { randomBytes } from "node:crypto";

/** What kind of thing a change notice names. */
export type ChangeKind =
  | "tag"
  | "session"
  | "task"
  | "objective"
  | "inbox_item"
  | "approval"
  | "conversation_message";

/** A notice that one thing changed. It names the thing and carries none of its state. */
export interface ChangeNotice {
  readonly kind: ChangeKind;
  readonly id: string;
  /** The name of the Tag it belongs to. */
  readonly tag?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly objectiveId?: string;
  /** The CLI conversation it belongs to, by name, for its owner. */
  readonly conversation?: string;
  /**
   * The operator whose CLI conversation this is, such as `admin` or `token:NAME`: only that
   * operator may see the notice. `*` is a message every operator may read.
   */
  readonly conversationOwner?: string;
  /** A few words for logs and people, such as `created` or `status completed`. */
  readonly reason: string;
  readonly changedAt: string;
}

/** A recorded notice and its position in this process's sequence of notices. */
export interface PositionedChangeNotice extends ChangeNotice {
  readonly position: number;
}

/** Where a watcher resumes: after `position`, or from now when the notices since it are lost. */
export type ChangeResumePoint =
  | { readonly status: "replay"; readonly notices: readonly PositionedChangeNotice[] }
  | { readonly status: "resync" }
  | { readonly status: "invalid" };

/** How many notices a Control Plane keeps for watchers that resume. */
const CHANGE_NOTICE_CAPACITY = 10_000;
const RESUME_TOKEN = /^v1\.([A-Za-z0-9_-]{16})\.(0|[1-9][0-9]{0,15})$/u;

/**
 * The Control Plane's change notices, in one process. Each notice gets the next position; the
 * latest notices stay in a bounded ring so a watcher resumes from a token without missing one.
 * A token names this process instance, so after a restart, or once its position left the ring,
 * a watcher resynchronizes. Several Control Plane processes would each see only their own
 * changes: a shared log is the follow-up for running more than one.
 */
export class ChangeNotifications {
  readonly #instance = randomBytes(12).toString("base64url");
  readonly #ring: (PositionedChangeNotice | undefined)[] = [];
  readonly #capacity: number;
  readonly #listeners = new Set<(notice: PositionedChangeNotice) => void>();
  #position = 0;

  constructor(options: { readonly capacity?: number } = {}) {
    this.#capacity = options.capacity ?? CHANGE_NOTICE_CAPACITY;
  }

  /** The position of the latest notice; 0 before the first. */
  get position(): number {
    return this.#position;
  }

  publish(notice: ChangeNotice): void {
    this.#position += 1;
    const positioned: PositionedChangeNotice = { ...notice, position: this.#position };
    this.#ring[this.#position % this.#capacity] = positioned;
    for (const listener of this.#listeners) {
      try {
        listener(positioned);
      } catch {
        // A failing watcher must not stop the others or the change that published.
      }
    }
  }

  /** Calls `listener` with every notice from now on, until the returned function is called. */
  subscribe(listener: (notice: PositionedChangeNotice) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The opaque token that resumes after `position`. */
  resumeToken(position: number = this.#position): string {
    return `v1.${this.#instance}.${position}`;
  }

  /** The notices after a resume token, or why a watcher cannot replay from it. */
  resume(token: string): ChangeResumePoint {
    const match = RESUME_TOKEN.exec(token);
    if (match === null) return { status: "invalid" };
    if (match[1] !== this.#instance) return { status: "resync" };
    const after = Number(match[2]);
    if (after > this.#position) return { status: "invalid" };
    if (this.#position - after > this.#capacity) return { status: "resync" };
    const notices: PositionedChangeNotice[] = [];
    for (let position = after + 1; position <= this.#position; position += 1) {
      const notice = this.#ring[position % this.#capacity];
      if (notice?.position !== position) return { status: "resync" };
      notices.push(notice);
    }
    return { status: "replay", notices };
  }
}
