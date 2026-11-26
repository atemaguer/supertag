ALTER TABLE supertag_v2_objective_questions ALTER COLUMN objective_id DROP NOT NULL;
ALTER TABLE supertag_v2_objective_questions ADD COLUMN recipient_user TEXT;
ALTER TABLE supertag_v2_objective_questions ADD CONSTRAINT supertag_v2_question_destination CHECK ((objective_id IS NULL) <> (recipient_user IS NULL));
UPDATE supertag_v2_schema SET version=131 WHERE version=130;
