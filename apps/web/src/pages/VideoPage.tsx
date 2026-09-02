import { useCallback, useEffect, useState } from 'react'
import type { RatingValue } from '@ypr/domain'
import { fromEngineRating } from '@ypr/domain'
import { api, type VideoResponse } from '../api/client.js'
import { RatingControl } from '../components/RatingControl.js'
import { formatDate, formatViews } from '../domain/reasons.js'

/**
 * One video (design section 37).
 *
 * The player is a YouTube iframe. Nothing is downloaded, cached or re-hosted: playback
 * happens on YouTube's own player, which is both a design constraint (section 3) and a
 * condition of the API terms.
 */
export interface VideoPageProps {
  videoId: string
  onBack: () => void
}

export function VideoPage({ videoId, onBack }: VideoPageProps) {
  const [data, setData] = useState<VideoResponse | null>(null)
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

      <div className="player">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${video.externalId}`}
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
    </section>
  )
}
