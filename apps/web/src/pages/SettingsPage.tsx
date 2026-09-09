import { useCallback, useEffect, useState } from 'react'
import type { GpuJob } from '@ypr/domain'
import { api, type ModelResponse, type StatusResponse, type YouTubeStatus } from '../api/client.js'
import { formatDate } from '../domain/reasons.js'

/**
 * Status, the YouTube connection, and the GPU jobs.
 *
 * The GPU job list is on screen rather than in a log, because "the model has not
 * updated yet" and "the model failed to update" look identical from the feed and only
 * one of them is worth doing something about (design sections 15 and 29).
 */
export function SettingsPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [model, setModel] = useState<ModelResponse | null>(null)
  const [youtube, setYouTube] = useState<YouTubeStatus | null>(null)
  const [jobs, setJobs] = useState<GpuJob[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [statusResult, modelResult, youtubeResult, jobsResult] = await Promise.all([
        api.status(),
        api.model(),
        api.youtubeStatus(),
        api.jobs(),
      ])
      setStatus(statusResult)
      setModel(modelResult)
      setYouTube(youtubeResult)
      setJobs(jobsResult.jobs)
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setBusy(true)
      setMessage(null)
      try {
        const result = await action()
        setMessage(`${label}: ${JSON.stringify(result)}`)
        await load()
      } catch (caught) {
        setMessage(`${label} failed: ${caught instanceof Error ? caught.message : String(caught)}`)
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  if (!status) return <p className="notice">Loading…</p>

  return (
    <section className="page">
      <h1>Settings</h1>
      {message && <p className="notice">{message}</p>}

      <div className="panel">
        <h2>State</h2>
        <dl className="facts">
          {/*
            Two identities, kept apart on purpose. The first is who Cloudflare Access
            let through, which is the same person on every hostname and says nothing
            about which account is being learned. The second is the one that differs.
          */}
          <div><dt>Access identity</dt><dd>{status.identity ?? 'Access not configured'}</dd></div>
          <div>
            <dt>YouTube account</dt>
            <dd>{status.youtubeAccount ?? (status.configured.oauth ? 'not connected' : 'OAuth not configured')}</dd>
          </div>
          <div><dt>Preference profile</dt><dd>{status.profileId}</dd></div>
          <div><dt>Videos in the catalog</dt><dd>{status.videos}</dd></div>
          <div><dt>Subscribed channels</dt><dd>{status.subscribedChannels}</dd></div>
          <div><dt>Ratings recorded</dt><dd>{status.ratings}</dd></div>
          <div><dt>Active model</dt><dd>{status.activeModel ? `model-${status.activeModel.version}` : 'none yet'}</dd></div>
          <div><dt>Search calls used today</dt><dd>{status.searchCallsUsedToday} of 100</dd></div>
        </dl>
        <p className="panel-note">
          Configured: {Object.entries(status.configured)
            .map(([key, value]) => `${key} ${value ? 'yes' : 'no'}`)
            .join(' · ')}
        </p>
      </div>

      <div className="panel">
        <h2>YouTube account</h2>
        {!youtube?.configured ? (
          <p className="notice">
            OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI
            and OAUTH_ENCRYPTION_KEY as Worker secrets.
          </p>
        ) : youtube.connected ? (
          <>
            <p>Connected. The token is encrypted at rest and never reaches this page.</p>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void run('subscriptions', api.syncSubscriptions)}>
                Refresh subscriptions
              </button>
              <button type="button" disabled={busy} onClick={() => void run('disconnect', api.disconnectYouTube)}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <p>Not connected. Connecting reads your subscription list, and nothing else.</p>
            <a className="button" href="/api/auth/youtube?redirectTo=/settings">
              Connect YouTube
            </a>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Model</h2>
        {model && (
          <p>
            {model.active ? `model-${model.active.version} is live` : 'Nothing trained yet'} ·{' '}
            {model.ratingsSinceLastTraining} ratings since the last run · needs at least{' '}
            {model.minimumRatings}
            {model.engine ? ` · engine: ${model.engine}` : ' · no engine configured'}
          </p>
        )}
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void run('train', api.train)}>
            Retrain now
          </button>
          <button type="button" disabled={busy} onClick={() => void run('score', api.score)}>
            Score the backlog
          </button>
          <button type="button" disabled={busy} onClick={() => void run('poll', api.pollJobs)}>
            Check GPU jobs
          </button>
        </div>
        <p className="panel-note">
          Training runs on a GPU that is asleep the rest of the time, so a run takes minutes. The
          feed keeps working from the scores it already has while it happens.
        </p>
        <p className="panel-note">
          The engine trains against a large set of synthetic negatives, so a run that is cut
          short settles on predicting the same number for everything — and still reports
          success. If every video is suddenly predicted alike, the training run was too short
          rather than your ratings too few.
        </p>
      </div>

      <div className="panel">
        <h2>Discovery</h2>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void run('subscription pass', () => api.runDiscovery({ lanes: ['subscription'] }))}>
            Fetch new uploads
          </button>
          <button type="button" disabled={busy} onClick={() => void run('search pass', () => api.runDiscovery({ lanes: ['related', 'explore'] }))}>
            Search for candidates
          </button>
          <button type="button" disabled={busy} onClick={() => void run('thumbnails', api.backfillThumbnails)}>
            Fetch missing thumbnails
          </button>
        </div>
        <p className="panel-note">
          The catalog carried over from the first version without thumbnails, and nothing
          re-reads a video it already has. A pass fills in two hundred of them for four of
          the ten thousand daily quota units; the schedule does one a day on its own.
        </p>
        <p className="panel-note">
          Searching costs one of a hundred daily calls per query, so a run spends at most thirty and
          leaves the rest for manual searching.
        </p>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p className="panel-note">
          The ratings are the part that cannot be rebuilt. A model can be retrained from them; they
          cannot be recovered from a model.
        </p>
        <div className="actions">
          <a className="button" href="/api/export/ratings.jsonl">ratings.jsonl</a>
          <a className="button" href="/api/export/preferences.json">preferences.json</a>
          <a className="button" href="/api/export/subscriptions.json">subscriptions.json</a>
          <a className="button" href="/api/export/settings.json">settings.json</a>
          <button type="button" disabled={busy} onClick={() => void run('backup', api.backup)}>
            Back up to R2
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>GPU jobs</h2>
        {jobs.length === 0 ? (
          <p className="notice">No jobs yet.</p>
        ) : (
          <table className="jobs">
            <thead>
              <tr><th>Type</th><th>Status</th><th>Created</th><th>Attempts</th><th>Error</th></tr>
            </thead>
            <tbody>
              {jobs.slice(0, 20).map((job) => (
                <tr key={job.id}>
                  <td>{job.type}</td>
                  <td className={`job-${job.status}`}>{job.status}</td>
                  <td>{formatDate(job.createdAt)}</td>
                  <td>{job.attempts}</td>
                  <td>{job.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
