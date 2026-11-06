-- Sessions opened before Session audience existed all became shared. A Lark direct (p2p) chat is
-- private to its one person: make each such Session private to the requester of its first p2p
-- inbound event, using the same key the Control Plane now assigns at open.
UPDATE `Session` SET `audience` = 'private', `audienceActorKey` = (
  SELECT 'lark:' || e.`surfaceAccountId` || ':' || json_extract(e.`event`, '$.actor.id')
  FROM `Task` t JOIN `DurableInboundEvent` e ON e.`id` = t.`inboundEventId`
  WHERE t.`sessionId` = `Session`.`id` AND json_extract(e.`event`, '$.provider') = 'lark'
    AND json_extract(e.`event`, '$.metadata.chatType') = 'p2p'
    AND json_extract(e.`event`, '$.actor.id') IS NOT NULL
  ORDER BY t.`createdAt` ASC, t.`id` ASC
  LIMIT 1
)
WHERE `audience` = 'shared' AND EXISTS (
  SELECT 1 FROM `Task` t JOIN `DurableInboundEvent` e ON e.`id` = t.`inboundEventId`
  WHERE t.`sessionId` = `Session`.`id` AND json_extract(e.`event`, '$.provider') = 'lark'
    AND json_extract(e.`event`, '$.metadata.chatType') = 'p2p'
    AND json_extract(e.`event`, '$.actor.id') IS NOT NULL
);
