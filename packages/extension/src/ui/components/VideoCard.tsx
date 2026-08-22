import { useState } from 'react'
import type { CatalogItem, RankedItem, RatingValue } from '@ypr/shared'
import { RatingControl } from './RatingControl.js'

/**
 * One video in the feed.
 *
 * Playback uses the official embedded player and nothing else is fetched: the developer
 * policies forbid downloading or caching audiovisual content, and thumbnails are only
 * ever referenced by URL (design section 6.2).
 */

export interface VideoCardProps {
  item: CatalogItem
  rating: RatingValue | undefined
  onRate: (rating: RatingValue) => void
  ranked?: RankedItem
}

export function VideoCard({ item, rating, onRate, ranked }: VideoCardProps) {
  const [playing, setPlaying] = useState(false)
  const isFixture = item.provenance === 'fixture'

  return (
    <article className="card">
      <div className="card-head">
        <h3>{item.title}</h3>
        <div className="card-meta muted small">
          {item.channelTitle} · {formatDate(item.publishedAt)} · {formatDuration(item.durationSeconds)} ·{' '}
          {item.viewCount.toLocaleString()} views
        </div>
      </div>

      {ranked ? <Explanation ranked={ranked} /> : null}

      {playing && !isFixture ? (
        <div className="player">
          <iframe
            title={item.title}
            src={`https://www.youtube-nocookie.com/embed/${item.externalId}`}
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="row">
          <button className="secondary" onClick={() => setPlaying(true)} disabled={isFixture}>
            {isFixture ? 'Fixture item — nothing to play' : 'Play here'}
          </button>
          {!isFixture ? (
            <a
              className="muted small"
              href={`https://www.youtube.com/watch?v=${item.externalId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open on YouTube
            </a>
          ) : null}
        </div>
      )}

      <RatingControl value={rating} onChange={onRate} />
    </article>
  )
}

/**
 * Why this video is here. The score is a formula, so it can always be spelled out.
 *
 * The figure shown is the calibrated one — how close this video is to the interest
 * *compared with the other candidates* — not the raw cosine. Raw similarities from a
 * sentence encoder sit in a narrow high band, so an unrelated video reads as "82%", which
 * states something far stronger than the model believes.
 */
function Explanation({ ranked }: { ranked: RankedItem }) {
  const { breakdown, lane } = ranked
  const reasons: string[] = []
  if (lane === 'subscription') reasons.push('from a channel you follow')
  if (breakdown.topClusterLabel && breakdown.topClusterRelative > 0) {
    reasons.push(
      // 0 means "as close as a typical candidate", 1 means "two standard deviations
      // closer". Not a percentile, so it is not written as one.
      `nearer “${breakdown.topClusterLabel}” than average (${breakdown.topClusterRelative.toFixed(2)})`,
    )
  }
  if (lane === 'explore') reasons.push('further from your usual interests')
  if (breakdown.freshness > 0.6) reasons.push('recent')
  // Only worth saying when it is not the default: these are the reserved slots that stop
  // the feed filling up with whatever is already popular.
  if (ranked.tier === 'emerging') reasons.push('less watched than most candidates')
  if (ranked.tier === 'wildcard') reasons.push('little watched and not new')

  return (
    <div className="explain small muted">
      <span className={`lane-tag ${lane}`}>{lane}</span>
      {reasons.length > 0 ? ` ${reasons.join(' · ')}` : null}
      <span className="score"> score {ranked.score.toFixed(2)}</span>
    </div>
  )
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatDate(timestamp: string): string {
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleDateString()
}
