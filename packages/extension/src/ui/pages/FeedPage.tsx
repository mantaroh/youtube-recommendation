import { useCallback, useEffect, useState } from 'react'
import type { CatalogItem, Lane, RatingValue } from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import { buildFeed, type FeedResult } from '../../lib/feed.js'
import { rateItem, ratingsByKey, recordImpressions } from '../../lib/events.js'
import { getAppSettings, updateAppSettings } from '../../lib/settings.js'
import { useAsync } from '../hooks.js'
import { VideoCard } from '../components/VideoCard.js'

/**
 * The feed (design section 4.2).
 *
 * The slider is the point of this screen as much as the list is: whether today is for
 * going deeper or for finding something unfamiliar is the user's decision, not something
 * the system infers on their behalf.
 */

/** Impressions already written, so a re-render cannot log the same feed twice. */
const recordedSignatures = new Set<string>()

export function FeedPage() {
  const data = useAsync(async () => {
    const [feed, ratings, settings] = await Promise.all([buildFeed(), ratingsByKey(), getAppSettings()])
    return { feed, ratings, settings }
  }, [])

  const [ratings, setRatings] = useState<Map<string, RatingValue> | undefined>(undefined)
  const [discovery, setDiscovery] = useState<number | undefined>(undefined)

  const feed = data.value?.feed
  const effectiveRatings = ratings ?? data.value?.ratings
  const effectiveDiscovery = discovery ?? data.value?.settings.discovery ?? 0.3

  useEffect(() => {
    if (!feed || feed.items.length === 0 || feed.asOf) return
    const signature = feed.items.map((entry) => itemKey(entry.item)).join('|')
    if (recordedSignatures.has(signature)) return
    recordedSignatures.add(signature)
    void recordImpressions(
      feed.items.map((entry, position) => ({ ref: entry.item, lane: entry.lane, position })),
      new Date().toISOString(),
    )
  }, [feed])

  const rate = useCallback(
    async (item: CatalogItem, rating: RatingValue) => {
      await rateItem(item, rating, new Date().toISOString())
      const next = new Map(effectiveRatings ?? new Map())
      next.set(itemKey(item), rating)
      setRatings(next)
    },
    [effectiveRatings],
  )

  const applyDiscovery = useCallback(
    async (value: number) => {
      setDiscovery(value)
      await updateAppSettings({ discovery: value })
      data.reload()
    },
    [data],
  )

  if (data.loading) return <section className="panel"><p className="muted">Ranking…</p></section>
  if (data.error) return <section className="panel"><p>{data.error}</p></section>
  if (!feed) return null

  const laneCounts = countLanes(feed)

  return (
    <>
      <section className="panel">
        <h2>Today</h2>
        <div className="slider-row">
          <span className="small">Stable</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(effectiveDiscovery * 100)}
            onChange={(event) => setDiscovery(Number(event.target.value) / 100)}
            onMouseUp={(event) => void applyDiscovery(Number((event.target as HTMLInputElement).value) / 100)}
            onKeyUp={(event) => void applyDiscovery(Number((event.target as HTMLInputElement).value) / 100)}
            aria-label="Stable to discovery"
          />
          <span className="small">Discovery</span>
        </div>
        <p className="muted small">
          Subscriptions {laneCounts.subscription} · related {laneCounts.related} · explore{' '}
          {laneCounts.explore} · {feed.state.clusters.filter((c) => c.activity > 0).length} active
          interests
        </p>
        <div className="row">
          <button className="secondary" onClick={() => data.reload()}>
            Rebuild feed
          </button>
        </div>
        {feed.asOf ? (
          <div className="notice">
            This feed is ranked as of {new Date(feed.asOf).toLocaleDateString()}. Clear the date on the
            Interests tab to come back to now.
          </div>
        ) : null}
      </section>

      {feed.items.length === 0 ? (
        <section className="panel">
          <h2>Nothing to rank yet</h2>
          <p className="muted">
            {feed.emptyReason ?? 'Rate a few videos so the model has something to work from.'} Start on
            the <strong>Status</strong> tab and run a fetch.
          </p>
        </section>
      ) : (
        <div className="cards">
          {feed.items.map((ranked) => (
            <VideoCard
              key={itemKey(ranked.item)}
              item={ranked.item}
              ranked={ranked}
              rating={effectiveRatings?.get(itemKey(ranked.item))}
              onRate={(rating) => void rate(ranked.item, rating)}
            />
          ))}
        </div>
      )}
    </>
  )
}

function countLanes(feed: FeedResult): Record<Lane, number> {
  const counts: Record<Lane, number> = { subscription: 0, related: 0, explore: 0 }
  for (const entry of feed.items) counts[entry.lane] += 1
  return counts
}
