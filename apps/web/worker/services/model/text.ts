import type { Channel, Video } from '@ypr/domain'

/**
 * The text a video is represented by on the GPU side.
 *
 * This is the only thing about a video that leaves Cloudflare (design section 44), and
 * it is assembled here rather than on the GPU so that what is sent is decided in one
 * readable place instead of inside a Python handler.
 *
 * Only metadata: title, channel name, tags and the description the uploader wrote. No
 * audiovisual content is downloaded, which is both a design constraint (section 3) and
 * a condition of the API terms.
 */

/**
 * Descriptions run to thousands of characters and are mostly links, timestamps and
 * sponsor copy. Anagnorisis summarises anything past its own threshold by running a
 * descriptor model, which is the expensive path; truncating first keeps a batch of two
 * thousand videos from turning into two thousand generation runs, and the first part
 * of a description is where the uploader says what the video is.
 */
const DESCRIPTION_LIMIT = 1200

export function videoText(video: Video, channel: Channel | null): string {
  const channelName = channel?.title ?? video.metadata.channelTitle ?? ''
  const tags = (video.metadata.tags ?? []).slice(0, 12)

  const lines = [video.title]
  if (channelName) lines.push(`Channel: ${channelName}`)
  if (tags.length > 0) lines.push(`Tags: ${tags.join(', ')}`)
  // Length, which was missing and turned out to matter more than anything else here:
  // ratings below three minutes averaged 1.2 against 3.3 above. Without this the model
  // sees a short video and a long one as the same kind of thing and cannot learn the
  // difference however often it is told.
  //
  // Before the description, because the description is truncated and this must not be
  // the part that falls off the end.
  if (video.durationSeconds !== null) lines.push(`Length: ${describeLength(video.durationSeconds)}`)

  const description = (video.description ?? '').trim()
  if (description) lines.push('', truncate(description, DESCRIPTION_LIMIT))

  return lines.join('\n').trim()
}

/**
 * Length as a phrase rather than a number.
 *
 * The embedder reads text, and "45 seconds (a short)" carries more for it than "45":
 * the word has a meaning in the model's vocabulary that the integer does not, and the
 * band matters more here than the exact figure.
 */
function describeLength(seconds: number): string {
  if (seconds <= 60) return `${seconds} seconds (a short)`
  if (seconds <= 180) return `${Math.round(seconds / 60)} minutes (a short)`
  if (seconds <= 600) return `${Math.round(seconds / 60)} minutes`
  if (seconds <= 3600) return `${Math.round(seconds / 60)} minutes (long)`
  return `${(seconds / 3600).toFixed(1)} hours (very long)`
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  // Cut at a line break where there is one nearby, so the text does not end mid-word.
  const window = value.slice(0, limit)
  const lastBreak = window.lastIndexOf('\n')
  return lastBreak > limit * 0.6 ? window.slice(0, lastBreak) : window
}
