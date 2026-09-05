import { useCallback, useEffect, useRef, useState } from 'react'
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

/**
 * The last feed built for each tab, and where the reader had scrolled to.
 *
 * Module state rather than component state, because the point is to survive this
 * component being unmounted: opening a video and coming back would otherwise fetch a
 * new feed, and a new feed is re-ranked — the list reorders itself underneath someone
 * who was working down it. Rebuilding is what the Refresh button is for.
 *
 * Deliberately not persisted. A page reload is an unambiguous request for a fresh
 * feed, and honouring it costs one request.
 */
const cache = new Map<Tab, { feed: Feed; scrollY: number }>()

export interface HomePageProps {
  onOpen: (videoId: string) => void
}

export function HomePage({ onOpen }: HomePageProps) {
  const [tab, setTab] = useState<Tab>('all')
  const [feed, setFeed] = useState<Feed | null>(() => cache.get('all')?.feed ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const restoring = useRef<number | null>(cache.get('all')?.scrollY ?? null)
  // Set the moment a card is clicked: this component is about to be replaced, and until
  // it is, every scroll event is the *departure* rather than the reader moving. Without
  // it the saved position is overwritten with zero, because opening a video scrolls the
  // page to the top before React unmounts anything.
  const leaving = useRef(false)

  const load = useCallback(async (which: Tab) => {
    setLoading(true)
    setError(null)
    try {
      const fetched = await api.feed(which === 'all' ? {} : { lane: which })
      cache.set(which, { feed: fetched, scrollY: 0 })
      setFeed(fetched)
      window.scrollTo(0, 0)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch only when this tab has nothing cached. Switching back and forth between
  // tabs, and returning from a video, then cost nothing and change nothing.
  useEffect(() => {
    leaving.current = false
    const cached = cache.get(tab)
    if (cached) {
      setFeed(cached.feed)
      restoring.current = cached.scrollY
      return
    }
    void load(tab)
  }, [load, tab])

  // Put the reader back where they were, once the cards are on the page.
  //
  // Two frames, not one: the first commit has the cards but the browser has not laid
  // them out yet, so a scroll issued then is clamped to a page that is still short.
  useEffect(() => {
    if (restoring.current === null || !feed) return
    const target = restoring.current
    restoring.current = null
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.scrollTo(0, target))
    })
  }, [feed])

  useEffect(() => {
    const remember = () => {
      if (leaving.current) return
      const entry = cache.get(tab)
      if (entry) entry.scrollY = window.scrollY
    }
    window.addEventListener('scroll', remember, { passive: true })
    return () => {
      remember()
      window.removeEventListener('scroll', remember)
    }
  }, [tab])

  /** Fix the scroll position before handing over, then navigate. */
  const open = useCallback(
    (videoId: string) => {
      const entry = cache.get(tab)
      if (entry) entry.scrollY = window.scrollY
      leaving.current = true
      onOpen(videoId)
    },
    [onOpen, tab],
  )

  /**
   * Rating updates the card in place rather than reloading the feed.
   *
   * A reload would re-rank, and a video moving or disappearing the instant it is rated
   * makes rating the next one a game of catch. The new rating reaches the ranking on
   * the next deliberate refresh.
   */
  const rate = useCallback(
    async (videoId: string, rating: RatingValue) => {
      const patch = (current: Feed | null) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.video.id === videoId ? { ...item, rating } : item,
              ),
            }
          : current

      setFeed((current) => {
        const next = patch(current)
        // The cache holds the same feed object, so it has to be updated too or the
        // rating disappears when this component remounts.
        const entry = next ? cache.get(tab) : undefined
        if (entry && next) entry.feed = next
        return next
      })

      try {
        await api.rate(videoId, rating)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [tab],
  )

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

      {loading && !feed && <p className="notice">Building the feed…</p>}

      {!loading && feed?.items.length === 0 && (
        <p className="notice">
          Nothing to show yet. Connect a YouTube account on the Settings page, or run a discovery
          pass, to fill the catalog.
        </p>
      )}

      <div className="grid">
        {feed?.items.map((item) => (
          <VideoCard key={item.video.id} item={item} onOpen={open} onRate={rate} />
        ))}
      </div>
    </section>
  )
}
