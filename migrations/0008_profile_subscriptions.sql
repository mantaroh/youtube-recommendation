-- Subscriptions belong to a YouTube account, not to the catalog.
--
-- `channels.subscribed` was a single flag on a shared row, which was correct while
-- there was one profile and wrong the moment there were two: the subscription lane on
-- one account was built from the other account's channels, and `setSubscribed` clears
-- every row before writing its own, so connecting the second account would have erased
-- the first one's list entirely.
--
-- The channel itself stays shared. Its title and thumbnail are catalog facts, and
-- copying them per profile would mean two rows that have to be kept in step for no
-- gain. Only the relation moves.

CREATE TABLE IF NOT EXISTS profile_subscriptions (
  profile_id    TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  subscribed_at INTEGER NOT NULL,

  PRIMARY KEY (profile_id, channel_id),
  FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE
);

-- The upload walk asks which channels anyone follows, so it reads by channel across
-- profiles rather than by profile.
CREATE INDEX IF NOT EXISTS idx_profile_subscriptions_channel
  ON profile_subscriptions (channel_id);

-- Everything subscribed until now came from the one account that existed, which is the
-- default profile. `last_fetched_at` is when this system first saw the channel, which
-- is the closest thing on hand to when it was subscribed; it is only ever used for
-- ordering, so an approximation is honest enough.
INSERT OR IGNORE INTO profile_subscriptions (profile_id, channel_id, subscribed_at)
SELECT 'default', id, COALESCE(last_fetched_at, 0)
  FROM channels
 WHERE subscribed = 1;

-- The flag is removed rather than left in place. A column that still holds a plausible
-- value nothing updates is how this kind of bug comes back: the next query written
-- against `channels` would read it and be wrong without failing.
DROP INDEX IF EXISTS idx_channels_subscribed;
ALTER TABLE channels DROP COLUMN subscribed;

-- The refresh cron still orders by staleness, and now reaches channels through the
-- relation, so the useful index is on the column it orders by.
CREATE INDEX IF NOT EXISTS idx_channels_last_fetched ON channels (last_fetched_at);
