import { useCallback, useState } from 'react'
import type { RatingValue } from '@ypr/shared'
import { itemKey, parseItemKey } from '@ypr/shared'
import { buildEvaluationReport, jstDay, recordTrial } from '../../lib/evaluation.js'
import { buildFeed } from '../../lib/feed.js'
import { rateItem } from '../../lib/events.js'
import { storeItems } from '../../lib/ingest.js'
import { resolveSource } from '../../lib/sources/factory.js'
import { useAsync } from '../hooks.js'
import { VideoCard } from '../components/VideoCard.js'

/**
 * The comparison experiment (design section 9).
 *
 * Both lists are rated here without any marker of which recommender produced them.
 * Knowing the source while rating would measure the expectation instead of the
 * recommendation, which would make the whole comparison worthless.
 */
export function EvaluationPage() {
  const report = useAsync(buildEvaluationReport, [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const recordOwn = useCallback(async () => {
    setBusy(true)
    try {
      const feed = await buildFeed({ feedSize: 10 })
      const row = await recordTrial('own', feed.items.map((entry) => itemKey(entry.item)))
      setMessage(
        row
          ? `Recorded ${row.itemKeys.length} items for ${row.date}.`
          : 'Nothing to record: the feed is empty.',
      )
      report.reload()
    } finally {
      setBusy(false)
    }
  }, [report])

  const fillMetadata = useCallback(async () => {
    setBusy(true)
    try {
      const missing = report.value?.missingKeys ?? []
      if (missing.length === 0) {
        setMessage('Nothing missing.')
        return
      }
      const { adapter, mode } = await resolveSource()
      if (mode !== 'live') {
        setMessage('Connect a YouTube account first: fixture mode cannot look these up.')
        return
      }
      const items = await adapter.hydrate(missing.map((key) => parseItemKey(key).externalId))
      await storeItems(items)
      setMessage(`Filled in ${items.length} of ${missing.length}.`)
      report.reload()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [report])

  const rate = useCallback(
    async (externalId: string, rating: RatingValue) => {
      await rateItem({ source: 'youtube', externalId }, rating, new Date().toISOString())
      report.reload()
    },
    [report],
  )

  const download = useCallback(() => {
    const csv = report.value?.csv ?? ''
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `evaluation-${jstDay()}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [report.value])

  if (report.loading) return <section className="panel"><p className="muted">Loading…</p></section>
  if (report.error) return <section className="panel"><p>{report.error}</p></section>
  const data = report.value!

  return (
    <>
      <section className="panel">
        <h2>Daily comparison</h2>
        <p className="muted small">
          Record this feed's top ten each day. YouTube's own top ten is recorded when you visit its
          home page. Rate both below without being told which is which, then compare.
        </p>
        <div className="row">
          <button className="action" onClick={recordOwn} disabled={busy}>
            Record today's feed
          </button>
          <button className="secondary" onClick={fillMetadata} disabled={busy}>
            Fill in missing metadata ({data.missingKeys.length})
          </button>
          <button className="secondary" onClick={download} disabled={data.metrics.length === 0}>
            Export CSV
          </button>
        </div>
        {message ? <div className="notice">{message}</div> : null}
      </section>

      <section className="panel">
        <h2>Results</h2>
        {data.metrics.every((metrics) => metrics.shown === 0) ? (
          <p className="muted">No trials recorded yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">This feed</th>
                <th className="num">YouTube</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {data.comparison.map((row) => (
                <tr key={row.metric}>
                  <td>{row.metric}</td>
                  <td className="num">{format(row.own)}</td>
                  <td className="num">{format(row.baseline)}</td>
                  <td className="num">{format(row.delta, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Satisfaction alone means little: a feed can raise it by narrowing. Read it next to
          category entropy and the share of unfamiliar channels.
        </p>
      </section>

      <section className="panel">
        <h2>Trials</h2>
        {data.trials.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Day</th>
                <th>Arm</th>
                <th className="num">Items</th>
              </tr>
            </thead>
            <tbody>
              {data.trials.map((trial) => (
                <tr key={trial.id}>
                  <td>{trial.date}</td>
                  <td>{trial.arm === 'own' ? 'This feed' : 'YouTube'}</td>
                  <td className="num">{trial.itemKeys.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data.pending.length > 0 ? (
        <>
          <section className="panel">
            <h2>Rate these ({data.pending.length})</h2>
            <p className="muted small">
              Shuffled, with no indication of which recommender suggested each one.
            </p>
          </section>
          <div className="cards">
            {data.pending.map((item) => (
              <VideoCard
                key={itemKey(item)}
                item={item}
                rating={undefined}
                onRate={(rating) => void rate(item.externalId, rating)}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}

function format(value: number | null, signed = false): string {
  if (value === null) return '—'
  const rendered = Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(3)
  return signed && value > 0 ? `+${rendered}` : rendered
}
