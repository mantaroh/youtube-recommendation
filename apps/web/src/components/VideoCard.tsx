import type { MouseEvent } from 'react'
import type { FeedItem, RatingValue } from '@ypr/domain'
import { RatingControl } from './RatingControl.js'
import { describeReason, formatDuration, formatViews, videoPath } from '../domain/reasons.js'

/**
 * One card in the feed (design section 36).
 *
 * The lane is on the card. Which of the three passes produced a video is the single
 * most useful thing to know about it — "this is here because you subscribe" and "this
 * is here because it is unlike what you usually watch" call for different judgements
 * from the person looking at it.
 *
 * The thumbnail and the title are links, not buttons. That is what lets a middle click
 * open a video in a background tab, which is the natural way to work through a feed:
 * opening one in place and coming back rebuilds the feed, and a rebuilt feed is
 * re-ranked and reordered under you.
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
  const href = videoPath(video.id)

  /**
   * Take over only the plain left click.
   *
   * Everything else — middle click, ctrl or cmd click, shift click, a right click and
   * "open in new tab" — is left to the browser, which already does the right thing
   * with an `href`. Intercepting those is how single-page applications end up unable
   * to do what every other page can.
   */
  const openInPlace = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(video.id)
  }

  return (
    <article className="card">
      <a className="card-thumb" href={href} onClick={openInPlace}>
        {video.thumbnailUrl ? (
          <img src={video.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <span className="card-thumb-placeholder" aria-hidden="true" />
        )}
        <span className={`lane lane-${item.lane}`}>{LANE_LABELS[item.lane]}</span>
        {video.durationSeconds ? (
          <span className="card-duration">{formatDuration(video.durationSeconds)}</span>
        ) : null}
      </a>

      <div className="card-body">
        <h3 className="card-title">
          <a href={href} onClick={openInPlace}>
            {video.title}
          </a>
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
