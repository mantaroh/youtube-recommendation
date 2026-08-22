import { useCallback, useEffect, useState } from 'react'
import { getStoreStatus, runIngestion, type IngestReport } from '../../lib/ingest.js'
import { getEngine, subscribeToEngineStatus, type EngineStatus } from '../../lib/inference/engine.js'
import { resolveSource } from '../../lib/sources/factory.js'
import { readLedger, SEARCH_CALL_BUDGET, UNIT_BUDGET } from '../../lib/sources/youtube/quota.js'
import { useAsync } from '../hooks.js'

/**
 * Store status and manual ingestion.
 *
 * This is the screen that answers "did anything actually get fetched and embedded?", so
 * it shows raw counts rather than a summary.
 */
export function StatusPage() {
  const status = useAsync(getStoreStatus, [])
  const source = useAsync(() => resolveSource(), [])
  const quota = useAsync(() => readLedger(), [])
  const [engine, setEngine] = useState<EngineStatus | undefined>(undefined)
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<IngestReport | undefined>(undefined)

  useEffect(() => subscribeToEngineStatus(setEngine), [])

  const runNow = useCallback(async () => {
    setRunning(true)
    setLog(['Starting'])
    try {
      const inference = await getEngine()
      const result = await runIngestion({
        engine: inference,
        onProgress: (message) => setLog((lines) => [...lines, message]),
      })
      setReport(result)
      setLog((lines) => [...lines, 'Finished'])
    } catch (error) {
      setLog((lines) => [...lines, `Failed: ${error instanceof Error ? error.message : String(error)}`])
    } finally {
      setRunning(false)
      status.reload()
      quota.reload()
    }
  }, [status, quota])

  const counts = status.value

  return (
    <>
      <section className="panel">
        <h2>Source</h2>
        {source.value ? (
          <p>
            <span className={`badge ${source.value.mode}`}>{source.value.mode}</span>{' '}
            {source.value.mode === 'live'
              ? 'Reading your real subscriptions from the YouTube Data API.'
              : `Using the built-in fixture catalog. ${source.value.reason ?? ''}`}
          </p>
        ) : (
          <p className="muted">Checking…</p>
        )}
        <div className="row">
          <button className="action" onClick={runNow} disabled={running}>
            {running ? 'Working…' : 'Fetch and embed now'}
          </button>
          <span className="muted small">
            Last run: {counts?.lastRunAt ? new Date(counts.lastRunAt).toLocaleString() : 'never'}
          </span>
        </div>
      </section>

      <section className="panel">
        <h2>Embedding model</h2>
        {engine ? (
          <>
            <p className="small">
              <code className="inline">{engine.modelId || '—'}</code> · {engine.dimensions || '—'} dimensions
              {engine.progress > 0 && engine.progress < 100 ? ` · loading ${engine.progress}%` : ''}
            </p>
            {engine.fallbackReason ? (
              <div className="notice">
                The sentence encoder could not be loaded, so a lexical fallback is in use. Ratings are
                unaffected: re-running ingestion after the model loads recomputes every vector.
                <br />
                <span className="muted small">{engine.fallbackReason}</span>
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">Not loaded yet. It loads on the first fetch.</p>
        )}
      </section>

      <section className="panel">
        <h2>Local store</h2>
        {counts ? (
          <div className="stat-grid">
            <Stat label="CATALOG ITEMS" value={counts.items} />
            <Stat label="EMBEDDINGS" value={counts.embeddings} />
            <Stat label="EVENTS" value={counts.events} />
            <Stat label="RATINGS" value={counts.ratings} />
            <Stat label="INTERESTS" value={counts.clusters} />
            <Stat label="CHANNELS" value={counts.channels} />
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="panel">
        <h2>Daily API budget</h2>
        {quota.value ? (
          <table className="data">
            <thead>
              <tr>
                <th>Bucket</th>
                <th className="num">Used</th>
                <th className="num">Budget</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>General units</td>
                <td className="num">{quota.value.units}</td>
                <td className="num">{UNIT_BUDGET}</td>
              </tr>
              <tr>
                <td>search.list calls</td>
                <td className="num">{quota.value.search}</td>
                <td className="num">{SEARCH_CALL_BUDGET}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Loading…</p>
        )}
        <p className="muted small">
          Counted against the US Pacific day, which is when the API quota resets.
        </p>
      </section>

      {report ? (
        <section className="panel">
          <h2>Last run</h2>
          <table className="data">
            <tbody>
              <tr>
                <th>Channels read</th>
                <td className="num">{report.channelCount}</td>
              </tr>
              <tr>
                <th>Items fetched</th>
                <td className="num">{report.fetchedItems}</td>
              </tr>
              <tr>
                <th>New items</th>
                <td className="num">{report.newItems}</td>
              </tr>
              <tr>
                <th>Embedded</th>
                <td className="num">{report.embedded}</td>
              </tr>
              <tr>
                <th>Expired items dropped</th>
                <td className="num">{report.purgedItems}</td>
              </tr>
            </tbody>
          </table>
          {report.errors.length > 0 ? (
            <div className="notice">
              {report.errors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {log.length > 0 ? (
        <section className="panel">
          <h2>Log</h2>
          <pre className="log">{log.join('\n')}</pre>
        </section>
      ) : null}
    </>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="value">{value.toLocaleString()}</div>
      <div className="label">{label}</div>
    </div>
  )
}
