-- Public content catalog.
--
-- Metadata only, and only the fields the developer policies allow (design section 6.2).
-- No user, no rating, no preference vector: nothing here identifies anyone, which is the
-- property that lets this table live outside the user's machine at all.

CREATE TABLE IF NOT EXISTS catalog_item (
  source               TEXT    NOT NULL,
  external_id          TEXT    NOT NULL,
  title                TEXT    NOT NULL,
  description          TEXT    NOT NULL,
  -- JSON array; D1 has no array type.
  tags                 TEXT    NOT NULL,
  channel_id           TEXT    NOT NULL,
  channel_title        TEXT    NOT NULL,
  official_category_id TEXT    NOT NULL,
  duration_seconds     INTEGER NOT NULL,
  published_at         TEXT    NOT NULL,
  view_count           INTEGER NOT NULL,
  metadata_fetched_at  TEXT    NOT NULL,
  -- metadata_fetched_at + 30 days. Rows past this are deleted by the scheduled sweep.
  expires_at           TEXT    NOT NULL,
  provenance           TEXT    NOT NULL,
  -- Advances on every write; clients page through the catalog by this.
  updated_at           TEXT    NOT NULL,
  PRIMARY KEY (source, external_id)
);

-- Incremental sync pages by (updated_at, external_id), so the index has to cover both.
CREATE INDEX IF NOT EXISTS idx_catalog_updated ON catalog_item (updated_at, external_id);
CREATE INDEX IF NOT EXISTS idx_catalog_expires ON catalog_item (expires_at);
