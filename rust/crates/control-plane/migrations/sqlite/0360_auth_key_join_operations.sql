-- A reusable Auth Key's join is found again by the operation that requested it, because the host
-- it enrolled may carry a NAME-2 suffix when the requested Worker Host ID was taken.
ALTER TABLE supertag_v2_auth_key_enrollments ADD COLUMN operation_digest TEXT;
CREATE UNIQUE INDEX supertag_v2_auth_key_enrollment_operations ON supertag_v2_auth_key_enrollments(key_digest, operation_digest);
UPDATE supertag_v2_schema SET version=69 WHERE version=68;
