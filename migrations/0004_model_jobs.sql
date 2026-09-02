-- Model versions, cached predictions and GPU jobs (design sections 13, 14, 15).

CREATE TABLE IF NOT EXISTS model_versions (
  id                   TEXT    PRIMARY KEY,

  profile_id           TEXT    NOT NULL,

  -- Monotonic per profile. `model-<version>` is the name the GPU side stores under.
  version              INTEGER NOT NULL,

  training_event_count INTEGER,

  -- training | ready | active | failed | superseded
  status               TEXT    NOT NULL,

  created_at           INTEGER NOT NULL,

  activated_at         INTEGER,

  metadata_json        TEXT,

  UNIQUE (profile_id, version),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

-- "Which model is live" is read on every feed build.
CREATE INDEX IF NOT EXISTS idx_model_versions_status ON model_versions (profile_id, status, version DESC);

CREATE TABLE IF NOT EXISTS recommendation_scores (
  profile_id    TEXT    NOT NULL,
  video_id      TEXT    NOT NULL,
  model_version TEXT    NOT NULL,

  -- Anagnorisis scale, 0..10.
  score         REAL    NOT NULL,

  scored_at     INTEGER NOT NULL,

  PRIMARY KEY (profile_id, video_id, model_version),
  FOREIGN KEY (video_id)   REFERENCES videos(id),
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

-- Keying by model version means a new model does not invalidate the old scores, so a
-- training run that turns out badly can be rolled back to without rescoring anything
-- (design section 48).
CREATE INDEX IF NOT EXISTS idx_scores_lookup ON recommendation_scores (profile_id, model_version, score DESC);

CREATE TABLE IF NOT EXISTS gpu_jobs (
  id            TEXT    PRIMARY KEY,

  -- embed_batch | describe_batch | train | score_batch
  type          TEXT    NOT NULL,

  runpod_job_id TEXT,

  -- queued | processing | completed | failed
  status        TEXT    NOT NULL,

  -- SHA-256 over profile, model version and the input ids. Two submissions of the same
  -- work carry the same hash, which is how a retried cron run avoids paying for the
  -- same GPU minutes twice (design section 47).
  payload_hash  TEXT,

  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,

  error         TEXT,

  -- Resubmission count. A job that has failed three times is left alone rather than
  -- retried forever (design section 48).
  attempts      INTEGER NOT NULL DEFAULT 0,

  -- What the completion handler needs in order to apply the result: which profile,
  -- which model version, which video ids.
  context_json  TEXT
);

-- The polling cron asks for unfinished jobs; the idempotency check asks by hash.
CREATE INDEX IF NOT EXISTS idx_gpu_jobs_status ON gpu_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_gpu_jobs_hash   ON gpu_jobs (payload_hash);
