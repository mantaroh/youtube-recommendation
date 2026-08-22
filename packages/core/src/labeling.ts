/**
 * Automatic cluster names (design section 3.2).
 *
 * Terms are scored by frequency inside the cluster against how many clusters use them at
 * all, so a word that appears everywhere ("video", "how") cannot become a name. The result
 * is a starting point: the user renames anything that reads badly, and a rename is an
 * event like any other.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'you', 'your', 'we', 'our', 'i', 'my', 'how', 'what', 'why', 'when', 'where', 'who',
  'video', 'videos', 'part', 'episode', 'full', 'new', 'best', 'top', 'guide', 'tutorial',
  'explained', 'introduction', 'intro', 'about', 'into', 'at', 'by', 'as', 'not', 'no',
])

const MIN_TERM_LENGTH = 3
const TERMS_PER_LABEL = 3

export interface ClusterLabelInput {
  id: string
  /** Free text of the cluster's members: titles and tags work well. */
  texts: string[]
}

export function labelClusters(clusters: ClusterLabelInput[]): Map<string, string> {
  const termCounts = clusters.map((cluster) => countTerms(cluster.texts))
  const documentFrequency = new Map<string, number>()
  for (const counts of termCounts) {
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }

  const total = Math.max(1, clusters.length)
  const labels = new Map<string, string>()

  clusters.forEach((cluster, index) => {
    const counts = termCounts[index]
    const scored = [...counts.entries()]
      .map(([term, count]) => {
        const df = documentFrequency.get(term) ?? 1
        return { term, score: count * Math.log(1 + total / df) }
      })
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))

    const chosen = scored.slice(0, TERMS_PER_LABEL).map((entry) => capitalise(entry.term))
    labels.set(cluster.id, chosen.length > 0 ? chosen.join(' · ') : 'Unnamed interest')
  })

  return labels
}

function countTerms(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const term of tokenize(text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }
  return counts
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9+#]+|[぀-ヿ一-鿿]{2,}/g)
  if (!matches) return []
  return matches.filter(
    (term) => term.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(term) && !/^\d+$/.test(term),
  )
}

function capitalise(term: string): string {
  if (!/^[a-z]/.test(term)) return term
  return term[0].toUpperCase() + term.slice(1)
}
