import { useState } from 'react'
import type { RatingValue } from '@ypr/shared'

/**
 * The rating control (design section 5.1).
 *
 * The question is "how much do you want to see videos like this from now on?", not "was
 * this video good". That is the whole point of the axis: a video can be excellent and
 * still be something you want less of.
 *
 * Unrated and 0 are different states and are drawn differently. 0 is an explicit "no more
 * of this"; unrated means the question has not been answered.
 */

export const RATING_LABELS: Record<RatingValue, string> = {
  0: 'No more of this',
  1: 'Much less',
  2: 'Less',
  3: 'Neutral',
  4: 'More',
  5: 'Much more',
}

export interface RatingControlProps {
  value: RatingValue | undefined
  onChange: (rating: RatingValue) => void
  disabled?: boolean
}

export function RatingControl({ value, onChange, disabled }: RatingControlProps) {
  const [hovered, setHovered] = useState<number | undefined>(undefined)
  const shown = hovered ?? value
  const isRated = value !== undefined

  return (
    <div className="rating">
      <div className="rating-question">How much do you want to see videos like this from now on?</div>
      <div className="rating-row" onMouseLeave={() => setHovered(undefined)}>
        <button
          type="button"
          className={`rating-none ${value === 0 ? 'chosen' : ''}`}
          onClick={() => onChange(0)}
          onMouseEnter={() => setHovered(0)}
          disabled={disabled}
          aria-pressed={value === 0}
          title={RATING_LABELS[0]}
        >
          No more
        </button>

        <div className="stars" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={value === star}
              aria-label={`${star} — ${RATING_LABELS[star as RatingValue]}`}
              className={`star ${shown !== undefined && shown >= star ? 'filled' : ''}`}
              onClick={() => onChange(star as RatingValue)}
              onMouseEnter={() => setHovered(star)}
              disabled={disabled}
            >
              {shown !== undefined && shown >= star ? '★' : '☆'}
            </button>
          ))}
        </div>

        <span className={`rating-label ${isRated ? '' : 'muted'}`}>
          {shown !== undefined ? RATING_LABELS[shown as RatingValue] : 'Not rated'}
        </span>
      </div>
    </div>
  )
}
