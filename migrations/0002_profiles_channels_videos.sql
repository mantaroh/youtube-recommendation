-- Profiles, channels and videos (design sections 9.1, 9.2, 9.3).
--
-- This migration also retires `catalog_item` from 0001. That table held the same
-- videos under a schema that had no owner and no ratings, because the previous design
-- kept preference data off this database entirely. The rows themselves are still good
-- metadata and were expensive in quota to collect, so they are moved rather than
-- dropped.

CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Single-user systems still get a profile row, so that nothing has to special-case its
-- absence and so that a second profile needs no migration (design section 9.1).
INSERT OR IGNORE INTO profiles (id, name, created_at)
VALUES ('default', 'default', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS channels (
  -- `source:external_id`. A generated id would need a lookup on every ingest just to
  -- discover whether the channel is already known.
  id              TEXT    PRIMARY KEY,
  source          TEXT    NOT NULL,
  external_id     TEXT    NOT NULL,
  title           TEXT,
  thumbnail_url   TEXT,
  subscribed      INTEGER NOT NULL DEFAULT 0,
  last_fetched_at INTEGER,

  UNIQUE (source, external_id)
);

-- The subscription lane reads this on every feed build and the refresh cron orders by
-- staleness, so both predicates are indexed.
CREATE INDEX IF NOT EXISTS idx_channels_subscribed ON channels (subscribed, last_fetched_at);

CREATE TABLE IF NOT EXISTS videos (
  id               TEXT    PRIMARY KEY,

  source           TEXT    NOT NULL,
  external_id      TEXT    NOT NULL,

  -- Channel row id, not the platform's channel id. Nullable because a video can be
  -- discovered before its channel has been fetched.
  channel_id       TEXT,

  title            TEXT    NOT NULL,
  description      TEXT,

  thumbnail_url    TEXT,
  published_at     INTEGER,
  duration_seconds INTEGER,

  view_count       INTEGER,

  -- Source-specific fields with no column of their own, as JSON.
  metadata_json    TEXT,

  discovered_at    INTEGER NOT NULL,
  refreshed_at     INTEGER,

  UNIQUE (source, external_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

-- The three ways candidates are selected: by channel, by recency, and by staleness.
CREATE INDEX IF NOT EXISTS idx_videos_channel    ON videos (channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_published  ON videos (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_refreshed  ON videos (refreshed_at);

-- Carry the crawled catalog across. `published_at` was an ISO string and is now epoch
-- milliseconds, which is what every timestamp column in this schema uses.
INSERT OR IGNORE INTO channels (id, source, external_id, title, subscribed, last_fetched_at)
SELECT DISTINCT
  'youtube:' || channel_id,
  'youtube',
  channel_id,
  channel_title,
  0,
  NULL
FROM catalog_item
WHERE channel_id IS NOT NULL AND channel_id <> '';

INSERT OR IGNORE INTO videos (
  id, source, external_id, channel_id, title, description,
  thumbnail_url, published_at, duration_seconds, view_count,
  metadata_json, discovered_at, refreshed_at
)
SELECT
  source || ':' || external_id,
  source,
  external_id,
  CASE WHEN channel_id IS NULL OR channel_id = '' THEN NULL ELSE 'youtube:' || channel_id END,
  title,
  description,
  NULL,
  CAST(strftime('%s', published_at) AS INTEGER) * 1000,
  duration_seconds,
  view_count,
  json_object(
    'tags', json(tags),
    'channelTitle', channel_title,
    'officialCategoryId', official_category_id,
    'provenance', provenance
  ),
  CAST(strftime('%s', metadata_fetched_at) AS INTEGER) * 1000,
  CAST(strftime('%s', metadata_fetched_at) AS INTEGER) * 1000
FROM catalog_item;

DROP INDEX IF EXISTS idx_catalog_updated;
DROP INDEX IF EXISTS idx_catalog_expires;
DROP TABLE IF EXISTS catalog_item;
