-- Which videos are candidates for which profile.
--
-- The catalog is shared on purpose: the same video should not be stored twice, nor its
-- metadata fetched twice. What was wrong was the step after that — treating everything
-- in the catalog as a candidate for every profile. Two accounts kept apart so that one
-- taste does not colour the other were then offered each other's discoveries: a hundred
-- and thirty videos from the second account's channels turned up in the first's explore
-- lane, and three thousand of the first's turned up in the second's.
--
-- So the row stays shared and the candidacy is recorded per profile, which is the same
-- shape as subscriptions in migration 0008. A video found independently by two profiles
-- is simply a candidate for both.

CREATE TABLE IF NOT EXISTS profile_candidates (
  profile_id    TEXT    NOT NULL,
  video_id      TEXT    NOT NULL,
  discovered_at INTEGER NOT NULL,

  PRIMARY KEY (profile_id, video_id),
  FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE
);

-- The feed asks for one profile's candidates ordered by recency, and the ordering
-- column lives on `videos`, so this index carries the profile and the join key.
CREATE INDEX IF NOT EXISTS idx_profile_candidates_video
  ON profile_candidates (video_id);

-- Backfill, in two steps, because two different things are knowable about the videos
-- already stored.
--
-- First: anything on a channel a profile follows was found by that profile's upload
-- walk, and the subscription says so exactly.
INSERT OR IGNORE INTO profile_candidates (profile_id, video_id, discovered_at)
SELECT s.profile_id, v.id, v.discovered_at
  FROM videos v
  JOIN profile_subscriptions s ON s.channel_id = v.channel_id;

-- Second: everything else came from a search or a popularity chart, and only the
-- default profile has ever run one — the second account was connected today and has
-- discovered nothing of its own yet. Attributing these to `default` is a statement of
-- fact rather than a guess.
INSERT OR IGNORE INTO profile_candidates (profile_id, video_id, discovered_at)
SELECT 'default', v.id, v.discovered_at
  FROM videos v
 WHERE NOT EXISTS (
   SELECT 1 FROM profile_subscriptions s WHERE s.channel_id = v.channel_id
 );
