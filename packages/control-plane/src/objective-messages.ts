import type { CoordinationInboxPage, ObjectiveMailboxMessage, Store } from "@supertag/core";

/** Optional Gateway delivery for messages already durable in the operator mailbox. */
export class ObjectiveMessages {
  private after: { createdAt: string; id: string } | undefined;
  constructor(
    private readonly store: Store,
    private readonly defaultTaskId?: string,
    private readonly deliveryEnabled = true,
  ) {}
  private async anchor(message: ObjectiveMailboxMessage) {
    const objective = await this.store.getObjective(message.objectiveId);
    const origin = objective.notificationTaskId
      ? undefined
      : await this.store.getObjectiveSurfaceTask(objective.id);
    const id = objective.notificationTaskId ?? origin?.id ?? this.defaultTaskId;
    return id ? this.store.getVerifiedSurfaceTask(id) : undefined;
  }
  async reconcile() {
    const messages = await this.store.listObjectiveMessages({
      pendingOnly: true,
      limit: 50,
      ...(this.after ? { after: this.after } : {}),
    });
    const last = messages.at(-1);
    this.after =
      messages.length === 50 && last ? { createdAt: last.createdAt, id: last.id } : undefined;
    if (!this.deliveryEnabled) return;
    for (const message of messages) {
      // A revoked or absent external destination never removes the durable inbox entry.
      const anchor = await this.anchor(message).catch(() => undefined);
      if (!anchor?.inboundEventId) continue;
      await this.store.enqueueOutboundReply({
        inboundEventId: anchor.inboundEventId,
        workerId: "objective-controller",
        presentation: "status",
        deliveryKey: `operator-message:${message.id}`,
        text: String(message.body["message"]),
        createdAt: new Date().toISOString(),
      });
    }
  }
  async enrich(page: CoordinationInboxPage): Promise<CoordinationInboxPage> {
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (item) => {
          if (item.kind !== "operator_message") return item;
          const evidence = item.evidence.find((e) => e.kind === "message");
          const message = evidence ? await this.store.getObjectiveMessage(evidence.id) : undefined;
          if (!message) return item;
          try {
            const anchor = await this.anchor(message);
            if (!anchor?.inboundEventId || !this.deliveryEnabled)
              return {
                ...item,
                notification: {
                  status: "unconfigured" as const,
                  reason:
                    "Message is stored in the operator inbox; external notification delivery is not configured.",
                },
              };
            const reply = await this.store.findOutboundReply(
              anchor.inboundEventId,
              `operator-message:${message.id}`,
            );
            return { ...item, notification: { status: reply?.status ?? ("pending" as const) } };
          } catch {
            return {
              ...item,
              notification: {
                status: "failed" as const,
                reason:
                  "External notification destination is unavailable; the operator message remains durable.",
              },
            };
          }
        }),
      ),
    };
  }
  async mayDeliver(outbound: { deliveryKey: string; inboundEventId: string }): Promise<boolean> {
    const id = outbound.deliveryKey.slice("operator-message:".length);
    const message = await this.store.getObjectiveMessage(id);
    if (message?.status !== "pending") return false;
    try {
      return (await this.anchor(message))?.inboundEventId === outbound.inboundEventId;
    } catch {
      return false;
    }
  }
}
