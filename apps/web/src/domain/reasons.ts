import type { RecommendationReason, ScoreBreakdown } from '@ypr/domain'

/**
 * Turning a reason into a sentence (design section 39).
 *
 * The wording lives here rather than in the Worker so that the API returns facts and
 * the UI decides how to say them. No model is involved on either side: every line
 * below corresponds to a term of the scoring function that actually fired.
 */
export function describeReason(reason: RecommendationReason): string {
  switch (reason.kind) {
    case 'subscribed_channel':
      return reason.subject ? `Subscribed: ${reason.subject}` : 'From a channel you subscribe to'
    case 'predicted_high':
      return 'Close to things you rated highly'
    case 'interest_boost':
      return `You asked for more ${reason.subject ?? 'of this'}`
    case 'recently_published':
      return 'Published recently'
    case 'exploring':
      return 'Outside your usual subjects'
    case 'unrated_channel':
      return 'A channel you have not rated yet'
  }
}

/**
 * The score, term by term.
 *
 * Shown in full on the video page rather than summarised, because a recommender the
 * user is supposed to own has to be able to account for its own arithmetic.
 */
export function breakdownRows(breakdown: ScoreBreakdown): Array<{ label: string; value: number }> {
  return [
    { label: 'Predicted rating', value: breakdown.preference },
    { label: 'Subscribed channel', value: breakdown.subscriptionBonus },
    { label: 'Recently published', value: breakdown.freshnessBonus },
    { label: 'Interests you set', value: breakdown.explicitInterestBonus },
    { label: 'Exploration', value: breakdown.explorationBonus },
    { label: 'Already shown', value: -breakdown.seenPenalty },
    { label: 'Muted interest', value: -breakdown.mutedInterestPenalty },
  ].filter((row) => Math.abs(row.value) > 0.001)
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return ''
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

/** JST, as everything user-facing in this system is. */
export function formatDate(epoch: number | null): string {
  if (epoch === null) return ''
  return new Date(epoch).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

export function formatViews(count: number | null): string {
  if (count === null) return ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K views`
  return `${count} views`
}
