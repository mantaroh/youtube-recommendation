import type { FeedItem, RatingValue } from '@ypr/domain'
import { RatingControl } from './RatingControl.js'
import { describeReason, formatDuration, formatViews } from '../domain/reasons.js'

/**
 * One card in the feed (design section 36).
 *
 * The lane is on the card. Which of the three passes produced a video is the single
 * most useful thing to know about it — "this is here because you subscribe" and "this
 * is here because it is unlike what you usually watch" call for different judgements
 * from the person looking at it.
 */
export interface VideoCardProps {
  item: FeedItem
  onOpen: (videoId: string) => void
  onRate: (videoId: string, rating: RatingValue) => void
}

const LANE_LABELS = {
  subscription: 'Subscribed',
  related: 'Near your interests',
  explore: 'Further afield',
} as const

export function VideoCard({ item, onOpen, onRate }: VideoCardProps) {
  const { video, channel } = item
  const channelTitle = channel?.title ?? video.metadata.channelTitle ?? ''

  return (
    <article className="card">
      <button type="button" className="card-thumb" onClick={() => onOpen(video.id)}>
        {video.thumbnailUrl ? (
          <img src={video.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <span className="card-thumb-placeholder" aria-hidden="true" />
        )}
        <span className={`lane lane-${item.lane}`}>{LANE_LABELS[item.lane]}</span>
        {video.durationSeconds ? (
          <span className="card-duration">{formatDuration(video.durationSeconds)}</span>
        ) : null}
      </button>

      <div className="card-body">
        <h3 className="card-title">
          <button type="button" onClick={() => onOpen(video.id)}>
            {video.title}
          </button>
        </h3>
        <p className="card-meta">
          {channelTitle}
          {video.viewCount ? ` · ${formatViews(video.viewCount)}` : ''}
        </p>

        {item.reasons.length > 0 && (
          <ul className="card-reasons">
            {item.reasons.slice(0, 2).map((reason, index) => (
              <li key={`${reason.kind}-${reason.subject ?? index}`}>{describeReason(reason)}</li>
            ))}
          </ul>
        )}

        <RatingControl
          compact
          value={item.rating}
          onRate={(rating) => onRate(video.id, rating)}
        />
      </div>
    </article>
  )
}
