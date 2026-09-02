-- YouTube OAuth tokens and the search quota ledger (design sections 16 and 42).
--
-- The design fixes the handling of the token — encrypted with AES-GCM, key in a Worker
-- secret, never sent to the browser and never sent to Runpod — but names no table for
-- it. This is that table.

CREATE TABLE IF NOT EXISTS oauth_tokens (
  profile_id     TEXT    NOT NULL,
  source         TEXT    NOT NULL,

  -- AES-GCM ciphertext, base64. The key lives in the OAUTH_ENCRYPTION_KEY secret, so
  -- a copy of this database on its own does not grant access to the account.
  access_token   TEXT    NOT NULL,
  refresh_token  TEXT,

  -- Fresh for each encryption, base64. Reusing one with the same key would be the one
  -- mistake AES-GCM does not survive.
  access_iv      TEXT    NOT NULL,
  refresh_iv     TEXT,

  scope          TEXT,
  expires_at     INTEGER,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  PRIMARY KEY (profile_id, source),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

-- Short-lived state for the OAuth redirect. Rows are deleted on use and swept by cron.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT    PRIMARY KEY,
  profile_id  TEXT    NOT NULL,
  redirect_to TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states (expires_at);

-- `search.list` has its own allowance of 100 calls a day, separate from the main
-- quota. Spending it is easy and finding out afterwards is not, so every call is
-- counted against a JST day before it is made (design section 42).
CREATE TABLE IF NOT EXISTS api_quota_usage (
  -- JST calendar day, `YYYY-MM-DD`. The quota resets on Pacific midnight, but the
  -- person watching this system lives in JST; the budget is set low enough that the
  -- difference cannot overspend the real allowance.
  day        TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  -- `search` | `list` | `subscriptions`
  operation  TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (day, source, operation)
);
