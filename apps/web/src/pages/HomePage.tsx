import { useCallback, useEffect, useState } from 'react'
import type { Feed, Lane, RatingValue } from '@ypr/domain'
import { api } from '../api/client.js'
import { VideoCard } from '../components/VideoCard.js'

/**
 * The feed (design section 36).
 *
 * Three tabs, matching the three lanes. "For You" is the mixed feed; the other two are
 * the same ranking restricted to one lane, so that "show me only what I subscribe to"
 * is a filter over the same scores rather than a different ranker.
 */

type Tab = 'all' | Lane

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'For You' },
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'related', label: 'Discover' },
  { id: 'explore', label: 'Further afield' },
]

export interface HomePageProps {
  onOpen: (videoId: string) => void
}

export function HomePage({ onOpen }: HomePageProps) {
  const [tab, setTab] = useState<Tab>('all')
  const [feed, setFeed] = useState<Feed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (which: Tab) => {
    setLoading(true)
    setError(null)
    try {
      setFeed(await api.feed(which === 'all' ? {} : { lane: which }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(tab)
  }, [load, tab])

  /**
   * Rating updates the card in place rather than reloading the feed.
   *
   * A reload would re-rank, and a video moving or disappearing the instant it is rated
   * makes rating the next one a game of catch. The new rating reaches the ranking on
   * the next deliberate refresh.
   */
  const rate = useCallback(async (videoId: string, rating: RatingValue) => {
    setFeed((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.video.id === videoId ? { ...item, rating } : item,
            ),
          }
        : current,
    )
    try {
      await api.rate(videoId, rating)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  return (
    <section className="page">
      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === tab ? 'tab is-active' : 'tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <button type="button" className="tab tab-action" onClick={() => void load(tab)}>
          Refresh
        </button>
      </nav>

      {error && <p className="notice notice-error">{error}</p>}

      {feed && (
        <p className="feed-meta">
          {feed.items.length} videos ·{' '}
          {feed.modelVersion ? `scored by ${feed.modelVersion}` : 'no model trained yet'} ·{' '}
          {feed.laneCounts.subscription} subscribed / {feed.laneCounts.related} near /{' '}
          {feed.laneCounts.explore} further afield
        </p>
      )}

      {loading && <p className="notice">Building the feed…</p>}

      {!loading && feed?.items.length === 0 && (
        <p className="notice">
          Nothing to show yet. Connect a YouTube account on the Settings page, or run a discovery
          pass, to fill the catalog.
        </p>
      )}

      <div className="grid">
        {feed?.items.map((item) => (
          <VideoCard key={item.video.id} item={item} onOpen={onOpen} onRate={rate} />
        ))}
      </div>
    </section>
  )
}
