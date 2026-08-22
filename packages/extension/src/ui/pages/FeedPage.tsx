import { useCallback, useState } from 'react'
import type { CatalogItem, RatingValue } from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import { getDb } from '../../lib/db.js'
import { rateItem, ratingsByKey } from '../../lib/events.js'
import { useAsync } from '../hooks.js'
import { VideoCard } from '../components/VideoCard.js'

/**
 * The feed.
 *
 * At this stage it simply lists what has been ingested, most recent first, so that rating
 * has something to act on. The ranker replaces the ordering once interests exist.
 */
export function FeedPage() {
  const data = useAsync(loadRecent, [])
  const [ratings, setRatings] = useState<Map<string, RatingValue> | undefined>(undefined)

  const effectiveRatings = ratings ?? data.value?.ratings

  const rate = useCallback(
    async (item: CatalogItem, rating: RatingValue) => {
      await rateItem(item, rating, new Date().toISOString())
      const next = new Map(effectiveRatings ?? new Map())
      next.set(itemKey(item), rating)
      setRatings(next)
    },
    [effectiveRatings],
  )

  if (data.loading) return <section className="panel"><p className="muted">Loading…</p></section>
  if (data.error) return <section className="panel"><p>{data.error}</p></section>

  const items = data.value?.items ?? []
  if (items.length === 0) {
    return (
      <section className="panel">
        <h2>Nothing here yet</h2>
        <p className="muted">
          Open the <strong>Status</strong> tab and run a fetch. Ratings you give here are what the
          preference model is built from.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="panel">
        <h2>Recently published</h2>
        <p className="muted small">
          {items.length} items. Rating one records an event; nothing is ever overwritten, so you can
          rebuild the model at any past point later.
        </p>
      </section>
      <div className="cards">
        {items.map((item) => (
          <VideoCard
            key={itemKey(item)}
            item={item}
            rating={effectiveRatings?.get(itemKey(item))}
            onRate={(rating) => void rate(item, rating)}
          />
        ))}
      </div>
    </>
  )
}

async function loadRecent(): Promise<{ items: CatalogItem[]; ratings: Map<string, RatingValue> }> {
  const items = await getDb().items.orderBy('publishedAt').reverse().limit(60).toArray()
  return { items, ratings: await ratingsByKey() }
}
