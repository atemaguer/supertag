-- Pacing: an unprompted post that arrives within 30 minutes of the last one delivered to the same
-- person or thread is held, then delivered with the others at the end of the window, or at once
-- when the person writes. `audience` is "conversation:PRINCIPAL" or "thread:ACCOUNT CONVERSATION
-- THREAD"; `delivered_at_ms` is when the post reached it.
ALTER TABLE supertag_v2_proactive_posts ADD COLUMN audience TEXT;
ALTER TABLE supertag_v2_proactive_posts ADD COLUMN held_until_ms BIGINT;
ALTER TABLE supertag_v2_proactive_posts ADD COLUMN released_at_ms BIGINT;
ALTER TABLE supertag_v2_proactive_posts ADD COLUMN delivered_at_ms BIGINT;
CREATE INDEX supertag_v2_proactive_posts_audience ON supertag_v2_proactive_posts (tag_id, audience, delivered_at_ms);
CREATE INDEX supertag_v2_proactive_posts_held ON supertag_v2_proactive_posts (held_until_ms) WHERE held_until_ms IS NOT NULL AND released_at_ms IS NULL;

UPDATE supertag_v2_schema SET version=99 WHERE version=98;
