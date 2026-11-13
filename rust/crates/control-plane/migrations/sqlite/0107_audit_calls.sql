-- An audited call writes its entries in the transaction that makes its change. Each entry names
-- the call, so a later transaction of the same call, or the call's settlement after it answers,
-- neither repeats an entry nor loses one.
ALTER TABLE supertag_v2_audit_entries ADD COLUMN call_id TEXT;
CREATE UNIQUE INDEX supertag_v2_audit_entries_call ON supertag_v2_audit_entries(call_id, action, target);

UPDATE supertag_v2_schema SET version=65 WHERE version=64;
