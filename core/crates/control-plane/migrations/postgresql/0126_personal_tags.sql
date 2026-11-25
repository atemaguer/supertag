-- Personal Tags: a Tag a User owns, created with the User and named after them. A Worker Host
-- enrolled with a User's invite key belongs to them and runs only their Tags, through a binding
-- per owned Tag. A host enrolled for every Tag runs shared Tags only: a personal Tag runs on its
-- owner's hosts, or on a shared host an operator binds to it by name.
ALTER TABLE supertag_v2_tags ADD COLUMN owner_user TEXT REFERENCES supertag_v2_users(name);
ALTER TABLE supertag_v2_hosts ADD COLUMN owner_user TEXT REFERENCES supertag_v2_users(name);
CREATE INDEX supertag_v2_tags_owner ON supertag_v2_tags(owner_user) WHERE owner_user IS NOT NULL;

UPDATE supertag_v2_schema SET version=126 WHERE version=125;
