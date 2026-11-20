-- Workstream posts wake nobody (operator decision, 2026-11-19): every inbox turn of a Team member
-- opens with its Team's digest instead. A pending wake for a channel would deliver its posts a
-- second time, so it is dropped, and the member's delivery position moves back before its first
-- post so the digest shows them. Bound wakes stay as delivery records.
UPDATE supertag_v2_conversation_members
SET delivered_seq = (
    SELECT MIN(w.first_seq) - 1 FROM supertag_v2_wakes w
    WHERE w.task_id IS NULL AND w.tag_id = supertag_v2_conversation_members.member_id
      AND w.conversation_id = supertag_v2_conversation_members.conversation_id)
WHERE member_kind = 1
  AND conversation_id IN (SELECT conversation_id FROM supertag_v2_conversations WHERE kind = 2)
  AND EXISTS (
    SELECT 1 FROM supertag_v2_wakes w
    WHERE w.task_id IS NULL AND w.tag_id = supertag_v2_conversation_members.member_id
      AND w.conversation_id = supertag_v2_conversation_members.conversation_id
      AND w.first_seq - 1 < supertag_v2_conversation_members.delivered_seq);

DELETE FROM supertag_v2_wakes
WHERE task_id IS NULL
  AND conversation_id IN (SELECT conversation_id FROM supertag_v2_conversations WHERE kind = 2);

UPDATE supertag_v2_schema SET version=119 WHERE version=118;
