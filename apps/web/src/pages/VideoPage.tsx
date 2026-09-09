import { useCallback, useEffect, useState } from 'react'
import type { FeedItem, RatingValue } from '@ypr/domain'
import { fromEngineRating } from '@ypr/domain'
import { api, type VideoResponse } from '../api/client.js'
import { RatingControl } from '../components/RatingControl.js'
import { formatDate, formatViews, videoPath } from '../domain/reasons.js'

/**
 * One video (design section 37).
 *
 * The player is a YouTube iframe. Nothing is downloaded, cached or re-hosted: playback
 * happens on YouTube's own player, which is both a design constraint (section 3) and a
 * condition of the API terms.
 *
 * `youtube.com` rather than `youtube-nocookie.com`. The privacy-enhanced domain sends
 * no cookies, so the viewer is signed out as far as the player is concerned, and a video
 * that requires an account — a channel membership, an age check — cannot play at all.
 * The trade is real: this sends the viewer's YouTube session, and their watch history
 * records the play. It is their own account and their own video, and the alternative is
 * a player that refuses part of their subscriptions.
 *
 * Members-only videos do play here, checked against a real one after the change. They
 * did not on the nocookie domain, which is what prompted it.
 *
 * The link out stays regardless. Something will eventually refuse to embed — an
 * uploader who disallows it, a region block — and an iframe that refuses tells the page
 * around it nothing at all, so there is no failure to show a fallback on. A page that
 * cannot play something should still be able to take you where it plays.
 */
export interface VideoPageProps {
  videoId: string
  onBack: () => void
  /** Opening one from the sidebar, without a round trip through the feed. */
  onOpen: (videoId: string) => void
}

/** Enough to fill the column beside a player without scrolling far past it. */
const UP_NEXT_SIZE = 12

export function VideoPage({ videoId, onBack, onOpen }: VideoPageProps) {
  const [data, setData] = useState<VideoResponse | null>(null)
  const [upNext, setUpNext] = useState<FeedItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await api.video(videoId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [videoId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    setUpNext(null)
    // A failure here leaves the column empty rather than the page broken: the video is
    // what was asked for, and what to watch afterwards is not worth an error for.
    void api
      .feed({ limit: UP_NEXT_SIZE + 1 })
      .then((feed) => {
        if (cancelled) return
        setUpNext(feed.items.filter((item) => item.video.id !== videoId).slice(0, UP_NEXT_SIZE))
      })
      .catch(() => {
        if (!cancelled) setUpNext([])
      })
    return () => {
      cancelled = true
    }
  }, [videoId])

  /**
   * Ratings given from the sidebar, over what the feed reported.
   *
   * The list is not refetched after a rating, so the stars have to remember what was
   * pressed or they would spring back to the value the feed was loaded with.
   */
  const [ratings, setRatings] = useState<Record<string, RatingValue>>({})

  const rateUpNext = useCallback(async (id: string, rating: RatingValue) => {
    setRatings((current) => ({ ...current, [id]: rating }))
    try {
      await api.rate(id, rating)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      // Put the control back where it was: leaving it filled would report a rating that
      // was never recorded.
      setRatings((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }, [])

  const rate = useCallback(
    async (rating: RatingValue) => {
      setData((current) => (current ? { ...current, rating } : current))
      try {
        await api.rate(videoId, rating)
        // Reloaded so the history list shows the new event. The design keeps every
        // rating rather than overwriting, and this page is where that is visible.
        await load()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [load, videoId],
  )

  if (error) {
    return (
      <section className="page">
        <button type="button" className="link" onClick={onBack}>
          ← Back
        </button>
        <p className="notice notice-error">{error}</p>
      </section>
    )
  }

  if (!data) return <p className="notice">Loading…</p>

  const { video, channel } = data

  return (
    <section className="page page-video">
      <button type="button" className="link" onClick={onBack}>
        ← Back to the feed
      </button>

      <div className="video-layout">
        <div className="video-main">
          <div className="player">
            <iframe
              src={`https://www.youtube.com/embed/${video.externalId}`}
              title={video.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>

          <h1 className="video-title">{video.title}</h1>
          <p className="card-meta">
            {channel?.title ?? video.metadata.channelTitle ?? ''}
            {video.viewCount ? ` · ${formatViews(video.viewCount)}` : ''}
            {video.publishedAt ? ` · ${formatDate(video.publishedAt)}` : ''}
          </p>
          <p className="video-actions">
            {/*
              Always here, not only when the embed fails — there is no way to be told that
              it did. An iframe that refuses to play reports nothing to the page around it.
            */}
            <a
              className="button"
              href={`https://www.youtube.com/watch?v=${video.externalId}`}
              target="_blank"
              rel="noreferrer"
            >
              Watch on YouTube
            </a>
          </p>

          <div className="panel">
            <h2>How much do you want to see videos like this from now on?</h2>
            <p className="panel-note">
              Not "was this good". A video can be excellent and still be something you want less of.
            </p>
            <RatingControl value={data.rating} onRate={rate} />
          </div>

          <div className="panel">
            <h2>Why this was recommended</h2>
            <ul className="reasons">
              {data.predictedScore !== null ? (
                <li>
                  Predicted rating {fromEngineRating(data.predictedScore).toFixed(1)} of 5
                  {data.modelVersion ? ` (${data.modelVersion})` : ''}
                </li>
              ) : (
                <li>The model has not scored this one yet</li>
              )}
              {channel?.subscribed && <li>You subscribe to {channel.title}</li>}
              {(video.metadata.tags ?? []).slice(0, 6).map((tag) => (
                <li key={tag}>Tagged {tag}</li>
              ))}
            </ul>
          </div>

          {data.history.length > 1 && (
            <div className="panel">
              <h2>What you have thought of it</h2>
              <ul className="history">
                {data.history.map((event) => (
                  <li key={event.id} className={event.disabledAt ? 'is-disabled' : ''}>
                    {formatDate(event.createdAt)} — rated {event.rating}
                    {event.disabledAt ? ' (retracted)' : ''}
                  </li>
                ))}
              </ul>
              <p className="panel-note">
                Nothing here is overwritten. Changing your mind adds a line rather than replacing one.
              </p>
            </div>
          )}

          {video.description && (
            <div className="panel">
              <h2>Description</h2>
              <p className="description">{video.description}</p>
            </div>
          )}
            </div>

        <aside className="video-aside">
          <h2 className="aside-title">Up next</h2>
          {/*
            "Up next", not "Related". YouTube answers "what is like this video"; this
            answers "what do you want to watch next", which is the question the whole
            system exists to answer. Naming it Related would promise the other one.

            It is the feed, minus what is already on screen. `search.list`'s
            relatedToVideoId — the obvious way to get the real thing — was withdrawn in
            2023, and picking more from the same channel would just concentrate the
            feed on one uploader.
          */}
          {upNext === null ? (
            <p className="panel-note">Loading…</p>
          ) : upNext.length === 0 ? (
            <p className="panel-note">Nothing else in the feed right now.</p>
          ) : (
            <ul className="up-next">
              {upNext.map((item) => (
                <li key={item.video.id}>
                  <a
                    className="up-next-item"
                    href={videoPath(item.video.id)}
                    onClick={(event) => {
                      if (event.defaultPrevented) return
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
                      event.preventDefault()
                      onOpen(item.video.id)
                    }}
                  >
                    {item.video.thumbnailUrl ? (
                      <img src={item.video.thumbnailUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="up-next-blank" aria-hidden="true" />
                    )}
                    <span className="up-next-text">
                      <span className="up-next-title">{item.video.title}</span>
                      <span className="card-meta">
                        {item.channel?.title ?? item.video.metadata.channelTitle ?? ''}
                      </span>
                    </span>
                  </a>
                  {/*
                    Outside the anchor, not inside it: a rating button within a link
                    opens the video on every press.

                    Rating does not remove the item or reorder the list. Removing it
                    would make a mis-press unrecoverable, and reordering would move the
                    next thing you were about to press out from under the cursor — which
                    is the whole appeal of rating from here, that several can be dealt
                    with in a row without leaving the video that is playing.
                  */}
                  <RatingControl
                    compact
                    value={ratings[item.video.id] ?? item.rating ?? null}
                    onRate={(rating) => void rateUpNext(item.video.id, rating)}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </section>
  )
}
