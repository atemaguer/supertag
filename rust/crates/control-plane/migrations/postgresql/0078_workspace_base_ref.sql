-- The local Workspace branch a Tag follows instead of a pinned base commit. A Task copies it at
-- admission with an empty base commit, which the Session's first Attempt resolves on its Worker
-- Host and every Task of the Session then keeps.
ALTER TABLE supertag_v2_tags ADD COLUMN workspace_base_ref TEXT;
ALTER TABLE supertag_v2_tasks ADD COLUMN workspace_base_ref TEXT;
UPDATE supertag_v2_schema SET version=78 WHERE version=77;
