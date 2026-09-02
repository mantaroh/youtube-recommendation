-- Per-profile settings.
--
-- The design lists `settings.json` among the things a user must be able to export
-- (section 45) and describes a discovery slider and a lane mix the user controls
-- (sections 34 and 38), but gives no table. A key/value table rather than a column per
-- setting, because the ranking weights are expected to be tuned and every tuning knob
-- should not be a migration.

CREATE TABLE IF NOT EXISTS settings (
  profile_id TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (profile_id, key),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);
