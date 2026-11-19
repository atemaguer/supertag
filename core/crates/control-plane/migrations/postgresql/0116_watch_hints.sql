-- A transaction that records watch notices notifies the Control Plane replicas once it commits.
-- The payload names only the kind of change: each replica's tail reads the notices itself. The
-- payload is the same for every notice, so PostgreSQL delivers it once per transaction.
CREATE FUNCTION supertag_v2_watch_hint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('supertag_v2_hints', 'watch');
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_hint AFTER INSERT ON supertag_v2_watch_notices
FOR EACH STATEMENT EXECUTE FUNCTION supertag_v2_watch_hint();

UPDATE supertag_v2_schema SET version=116 WHERE version=115;
