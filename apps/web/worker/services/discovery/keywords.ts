/**
 * Turning ratings into search terms (design sections 19 and 20).
 *
 * No model is involved. Design section 19 asks for exploration terms derived from what
 * is currently rated highly, and the tags a video already carries are exactly that,
 * written by the uploader rather than inferred by us. Terms are counted, not embedded,
 * which is what keeps this in the Worker instead of on a GPU.
 */

/**
 * Words that appear in every technical title and identify nothing. Searching for them
 * spends one of a hundred daily search calls on a term that matches everything.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how', 'why', 'you', 'your',
  'video', 'part', 'full', 'new', 'best', 'top', 'watch', 'live', 'official', 'episode',
  'tutorial', 'guide', 'review', 'vs', 'ep', 'feat', 'ft', 'hd', '4k',
])

export interface RatedText {
  title: string
  tags: string[]
  channelTitle: string | null
  /** 0..5, used to weight how much this video's terms count. */
  rating: number
}

/**
 * Terms worth searching for, most characteristic first.
 *
 * A term's weight is the sum of the ratings of the videos it appears in, so one video
 * rated five contributes more than two rated one. Tags count double: a tag is a claim
 * about the subject, while a title word may just be phrasing.
 */
export function interestTerms(rated: RatedText[], limit: number): string[] {
  const weights = new Map<string, number>()

  const add = (term: string, weight: number) => {
    const normalised = term.trim().toLowerCase()
    if (normalised.length < 3 || normalised.length > 40) return
    if (STOP_WORDS.has(normalised)) return
    if (/^\d+$/.test(normalised)) return
    weights.set(normalised, (weights.get(normalised) ?? 0) + weight)
  }

  for (const item of rated) {
    // Only what the user actually wants more of. A video rated 2 says "less of this",
    // and searching for its terms would be reading the sign backwards.
    if (item.rating < 3) continue
    const weight = item.rating - 2

    for (const tag of item.tags.slice(0, 10)) add(tag, weight * 2)
    for (const word of splitTitle(item.title)) add(word, weight)
  }

  return [...weights.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term]) => term)
}

/**
 * Title words, with punctuation and bracketed decoration removed.
 *
 * Bigrams as well as single words: "browser engine" is a subject and "browser" alone
 * is a category, and the two return very different search results.
 */
export function splitTitle(title: string): string[] {
  const words = title
    .replace(/[\[\(\{].*?[\]\)\}]/g, ' ')
    .split(/[^\p{L}\p{N}+#]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLowerCase()))

  const terms = [...words]
  for (let index = 0; index + 1 < words.length; index += 1) {
    terms.push(`${words[index]} ${words[index + 1]}`)
  }
  return terms
}

/**
 * Adjacent topics for the explore lane (design section 20).
 *
 * The design's own example is a chain: browser engine to operating system to computer
 * architecture to CPU history. Each step stays in the same intellectual neighbourhood
 * while leaving the exact subject the user already has, which is the thing a
 * similarity search cannot do — nearest-neighbour returns more of the same by
 * definition.
 *
 * A static table, as design section 20 permits for V1. It is small, wrong in ways that
 * are visible, and cheap to correct, which is more than can be said for an embedding
 * walk that would need a GPU in the discovery path.
 */
const ADJACENCY: Array<[RegExp, string[]]> = [
  [/browser|firefox|chromium|webkit|gecko/i, ['operating system internals', 'rendering engine', 'web standards history']],
  [/linux|kernel|unix|bsd/i, ['computer architecture', 'operating system design', 'systems programming']],
  [/compiler|llvm|rust|typescript|language/i, ['programming language theory', 'type systems', 'compiler design']],
  [/cpu|gpu|hardware|silicon|arm|risc/i, ['computing history', 'semiconductor manufacturing', 'computer architecture']],
  [/network|tcp|http|dns|protocol/i, ['distributed systems', 'internet history', 'network security']],
  [/database|sql|sqlite|storage/i, ['distributed systems', 'file system design', 'data structures']],
  [/machine learning|neural|llm|ai agent|transformer/i, ['information retrieval', 'statistics', 'computational linguistics']],
  [/security|cryptography|exploit|vulnerability/i, ['formal verification', 'protocol design', 'privacy engineering']],
  [/design|typography|interface|ux/i, ['human computer interaction', 'design history', 'accessibility']],
  [/music|guitar|synth|audio/i, ['acoustics', 'music theory', 'audio engineering']],
]

/** One step sideways from each seed term, de-duplicated. */
export function adjacentTopics(seeds: string[], limit: number): string[] {
  const found = new Set<string>()
  for (const seed of seeds) {
    for (const [pattern, neighbours] of ADJACENCY) {
      if (!pattern.test(seed)) continue
      for (const neighbour of neighbours) {
        if (found.size >= limit) return [...found]
        // A neighbour the user is already deep in is not a step sideways.
        if (seeds.some((other) => other.includes(neighbour) || neighbour.includes(other))) continue
        found.add(neighbour)
      }
    }
  }
  return [...found]
}
