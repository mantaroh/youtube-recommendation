-- Rating events and interest controls (design sections 10 and 12).
--
-- This is the table the whole system exists to protect. Everything else here —
-- catalog rows, predicted scores, trained models — can be rebuilt from a network
-- request or a GPU run. These rows cannot be rebuilt from anything (design section 61).

CREATE TABLE IF NOT EXISTS rating_events (
  id         TEXT    PRIMARY KEY,

  profile_id TEXT    NOT NULL,
  video_id   TEXT    NOT NULL,

  -- 0..5 as the user chose it. The doubling to Anagnorisis's 0..10 happens when the
  -- training payload is assembled, so that a change of engine cannot silently
  -- reinterpret what is stored here.
  rating     REAL    NOT NULL,

  created_at INTEGER NOT NULL,

  -- Retracting a misclick sets this. Rows are never deleted and never updated in
  -- place, so the history of an opinion survives changing it (design section 11).
  disabled_at INTEGER,

  FOREIGN KEY (video_id)   REFERENCES videos(id),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

-- "The current rating for this video" is the newest non-disabled row, and the training
-- set is every non-disabled row in order. Both read through this index.
CREATE INDEX IF NOT EXISTS idx_rating_events_video
  ON rating_events (profile_id, video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rating_events_created
  ON rating_events (profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interest_controls (
  id         TEXT    PRIMARY KEY,

  profile_id TEXT    NOT NULL,

  keyword    TEXT    NOT NULL,

  -- 1.0 is neutral, 0 mutes, above 1 boosts. Applied at ranking time, so an edit
  -- shows up in the next feed rather than after the next training run.
  weight     REAL    NOT NULL DEFAULT 1.0,

  -- A timed mute. Past this instant the row falls back to `weight`.
  mute_until INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE (profile_id, keyword),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_interest_controls_profile ON interest_controls (profile_id);

-- What the feed has already put in front of the user.
--
-- The design subtracts a `seen_penalty` (section 33) but names no table for it. It
-- cannot come from `rating_events`, because being shown something and having an
-- opinion about it are different facts, and conflating them would make an unrated
-- impression look like a rating of zero.
CREATE TABLE IF NOT EXISTS impressions (
  profile_id TEXT    NOT NULL,
  video_id   TEXT    NOT NULL,
  lane       TEXT    NOT NULL,
  shown_at   INTEGER NOT NULL,
  shown_count INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (profile_id, video_id),
  FOREIGN KEY (video_id)   REFERENCES videos(id),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_impressions_shown ON impressions (profile_id, shown_at DESC);
