-- The shared Store schema from agentic-identity (D1_SCHEMA), plus indexes on
-- the fields that tasks filters by.
CREATE TABLE IF NOT EXISTS store_docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (collection, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS store_docs_board ON store_docs (collection, json_extract(body, '$.boardId'));
CREATE INDEX IF NOT EXISTS store_docs_task ON store_docs (collection, json_extract(body, '$.taskId'));
