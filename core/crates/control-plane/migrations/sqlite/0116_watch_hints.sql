-- PostgreSQL notifies replicas of committed watch notices from this migration on. SQLite runs in
-- one process, whose in-process hints and tail poll need no schema change.
UPDATE supertag_v2_schema SET version=116 WHERE version=115;
