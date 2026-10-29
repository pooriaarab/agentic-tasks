-- The shared Store schema from agentic-identity (D1_SCHEMA).
CREATE TABLE IF NOT EXISTS store_docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (collection, id)) WITHOUT ROWID;
