import type { RatingValue } from '@ypr/domain'

/**
 * The rating control (design section 37).
 *
 * The question is not "was this good" but "how much do you want to see videos like
 * this from now on". A video can be excellent and still be something you want less of,
 * and only this axis can say so — which is why the label is written out rather than
 * left to the stars to imply.
 *
 * Zero is a rating, not the absence of one. "No more of this" and "not rated yet" are
 * different states and stay visibly different: zero is a filled control, unrated is an
 * empty one.
 */

const LABELS: Record<RatingValue, string> = {
  0: 'No more of this',
  1: 'Much less',
  2: 'A little less',
  3: 'About the same',
  4: 'A little more',
  5: 'Much more',
}

export interface RatingControlProps {
  value: RatingValue | null
  onRate: (rating: RatingValue) => void
  disabled?: boolean
  compact?: boolean
}

export function RatingControl({ value, onRate, disabled, compact }: RatingControlProps) {
  const values: RatingValue[] = [0, 1, 2, 3, 4, 5]

  return (
    <div className={compact ? 'rating rating-compact' : 'rating'}>
      <div className="rating-stars" role="radiogroup" aria-label="How much do you want to see videos like this?">
        {values.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={value === candidate}
            aria-label={LABELS[candidate]}
            title={LABELS[candidate]}
            className={ratingClass(candidate, value)}
            disabled={disabled}
            onClick={() => onRate(candidate)}
          >
            {candidate === 0 ? '✕' : '★'}
          </button>
        ))}
      </div>
      {!compact && (
        <p className="rating-caption">
          {value === null ? 'Not rated' : LABELS[value]}
        </p>
      )}
    </div>
  )
}

function ratingClass(candidate: RatingValue, value: RatingValue | null): string {
  const classes = ['rating-star']
  if (candidate === 0) classes.push('rating-zero')
  // Stars fill up to the chosen value, so four stars reads as four rather than as "the
  // fourth". Zero is its own mark and never participates in the fill.
  if (value !== null && candidate !== 0 && candidate <= value) classes.push('is-filled')
  if (value === candidate) classes.push('is-selected')
  return classes.join(' ')
}
