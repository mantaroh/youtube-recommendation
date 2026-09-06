-- A lease on a claimed job.
--
-- In the push model the Worker asks the engine what became of a job, so a runner that
-- died was discoverable by asking. When the runner comes and takes work instead, there
-- is nobody to ask: a machine that is switched off mid-training leaves the row sitting
-- in `processing` forever.
--
-- The lease is the answer. A claim sets an expiry; the reconciliation pass returns
-- anything past it to `queued`, and the work is offered again.

ALTER TABLE gpu_jobs ADD COLUMN lease_expires_at INTEGER;

-- The reconciliation pass asks for processing rows whose lease has run out.
CREATE INDEX IF NOT EXISTS idx_gpu_jobs_lease ON gpu_jobs (status, lease_expires_at);
