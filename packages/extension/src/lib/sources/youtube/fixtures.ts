import type {
  CatalogItem,
  SearchOptions,
  SourceAdapter,
  SubscriptionUpdateOptions,
} from '@ypr/shared'
import { METADATA_TTL_DAYS } from './mapper.js'

/**
 * Recorded-style catalog used by tests and by development without credentials.
 *
 * Items are generated deterministically from topic templates rather than copied from a
 * live response: real API payloads are not ours to redistribute, and unauthenticated API
 * data may not be retained beyond 30 days (design section 6.2). Every item is marked
 * `provenance: 'fixture'` so it can never be mistaken for real API data.
 */

interface TopicTemplate {
  key: string
  channelId: string
  channelTitle: string
  categoryId: string
  tags: string[]
  titles: string[]
  description: string
}

const TOPICS: TopicTemplate[] = [
  {
    key: 'browser',
    channelId: 'UC_fixture_browser',
    channelTitle: 'Rendering Pipeline',
    categoryId: '28',
    tags: ['browser', 'rendering', 'blink', 'compositor', 'layout'],
    description:
      'A walk through browser engine internals: parsing, style resolution, layout, paint and compositing.',
    titles: [
      'How a browser engine turns HTML into pixels',
      'Style recalculation and the cost of invalidation',
      'Inside the compositor thread',
      'Layout engines compared: Blink, Gecko and WebKit',
      'Paint records and display lists explained',
      'Why reflow is expensive in a rendering engine',
    ],
  },
  {
    key: 'os',
    channelId: 'UC_fixture_os',
    channelTitle: 'Kernel Space',
    categoryId: '28',
    tags: ['operating system', 'kernel', 'scheduler', 'memory', 'syscall'],
    description:
      'Operating system internals: schedulers, virtual memory, system calls and the boundary between user space and kernel space.',
    titles: [
      'What actually happens during a system call',
      'Virtual memory and the page table walk',
      'Process scheduling on a modern kernel',
      'Copy on write, explained from first principles',
      'Interrupt handling and the kernel stack',
      'Building a tiny kernel that boots',
    ],
  },
  {
    key: 'history',
    channelId: 'UC_fixture_history',
    channelTitle: 'Computing Past',
    categoryId: '27',
    tags: ['computer history', 'mainframe', 'unix', 'retro', 'archive'],
    description:
      'Computer history told through the machines and the people who built them.',
    titles: [
      'The machine that ran the first Unix',
      'How the mainframe era actually ended',
      'A history of the personal computer keyboard',
      'The lost operating systems of the 1980s',
      'Restoring a minicomputer from 1975',
    ],
  },
  {
    key: 'embedded',
    channelId: 'UC_fixture_embedded',
    channelTitle: 'Bare Metal',
    categoryId: '28',
    tags: ['embedded', 'microcontroller', 'firmware', 'electronics', 'soldering'],
    description: 'Embedded systems and electronics: firmware, microcontrollers and hardware bring-up.',
    titles: [
      'Bringing up a board with no bootloader',
      'Reading a datasheet without fear',
      'Debugging firmware with a logic analyser',
      'Power supply design for microcontrollers',
      'Writing an interrupt driven UART driver',
    ],
  },
  {
    key: 'agents',
    channelId: 'UC_fixture_agents',
    channelTitle: 'Agent Notes',
    categoryId: '28',
    tags: ['ai', 'agents', 'llm', 'tools', 'retrieval'],
    description: 'Building software agents: tool use, retrieval, planning and evaluation.',
    titles: [
      'Tool calling patterns that actually hold up',
      'Retrieval pipelines beyond naive chunking',
      'Evaluating an agent without fooling yourself',
      'Planning loops and where they break',
      'Local models for private workflows',
    ],
  },
  {
    key: 'chinese',
    channelId: 'UC_fixture_chinese',
    channelTitle: 'Mandarin Daily',
    categoryId: '27',
    tags: ['chinese', 'mandarin', 'language learning', 'vocabulary', 'tones'],
    description: 'Mandarin Chinese lessons: tones, vocabulary building and listening practice.',
    titles: [
      'Tone pairs that trip up every learner',
      'Two hundred characters you actually need',
      'Listening practice at natural speed',
      'Measure words without memorisation',
    ],
  },
  {
    key: 'investment',
    channelId: 'UC_fixture_investment',
    channelTitle: 'Index and Chill',
    categoryId: '25',
    tags: ['investment', 'index fund', 'portfolio', 'market', 'finance'],
    description: 'Long horizon investing: index funds, portfolio construction and market history.',
    titles: [
      'Why most active funds trail the index',
      'Rebalancing rules that survive a crash',
      'What a bond allocation is really for',
      'Reading a fund fact sheet properly',
    ],
  },
  {
    key: 'cooking',
    channelId: 'UC_fixture_cooking',
    channelTitle: 'Weeknight Kitchen',
    categoryId: '26',
    tags: ['cooking', 'recipe', 'kitchen', 'weeknight', 'technique'],
    description: 'Straightforward cooking technique for weeknight meals.',
    titles: [
      'Knife skills that save ten minutes a night',
      'One pan dinners that are not boring',
      'Stock from scraps, done properly',
      'Why your pan sauce breaks',
    ],
  },
]

/** Deterministic pseudo-random source, so fixture data is identical on every run. */
function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i)
    state = Math.imul(state, 0x01000193) >>> 0
  }
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

export interface FixtureCatalogOptions {
  /** Instant the catalog is generated at; publication dates are spread out behind it. */
  now: string
  /** Days of history the generated catalog spans. */
  spanDays?: number
}

export function buildFixtureCatalog(options: FixtureCatalogOptions): CatalogItem[] {
  const nowMs = Date.parse(options.now)
  const spanDays = options.spanDays ?? 120
  const items: CatalogItem[] = []

  for (const topic of TOPICS) {
    const random = seededRandom(topic.key)
    topic.titles.forEach((title, index) => {
      const ageDays = Math.floor(random() * spanDays)
      const publishedAt = new Date(nowMs - ageDays * 86_400_000).toISOString()
      const fetchedAt = options.now

      // Spread view counts across the popularity strata so stratified sampling has
      // something to work with (design section 4.3).
      const roll = random()
      const viewCount =
        roll < 0.2
          ? Math.floor(200 + random() * 800)
          : roll < 0.45
            ? Math.floor(1_500 + random() * 3_000)
            : Math.floor(8_000 + random() * 400_000)

      items.push({
        source: 'youtube',
        externalId: `fixture-${topic.key}-${index}`,
        title,
        description: topic.description,
        tags: topic.tags,
        channelId: topic.channelId,
        channelTitle: topic.channelTitle,
        officialCategoryId: topic.categoryId,
        durationSeconds: Math.floor(300 + random() * 2400),
        publishedAt,
        viewCount,
        metadataFetchedAt: fetchedAt,
        expiresAt: new Date(Date.parse(fetchedAt) + METADATA_TTL_DAYS * 86_400_000).toISOString(),
        provenance: 'fixture',
      })
    })
  }

  return items
}

/** Channel ids treated as subscribed in fixture mode. */
export const FIXTURE_SUBSCRIBED_CHANNEL_IDS = [
  'UC_fixture_browser',
  'UC_fixture_os',
  'UC_fixture_history',
]

/**
 * `SourceAdapter` backed by the fixture catalog. Used when no credentials are configured
 * and by tests, so the whole pipeline can run end to end offline.
 */
export class FixtureSourceAdapter implements SourceAdapter {
  readonly source = 'youtube' as const
  private readonly catalog: CatalogItem[]

  constructor(private readonly now: () => string = () => new Date().toISOString()) {
    this.catalog = buildFixtureCatalog({ now: this.now() })
  }

  async listSubscribedChannelIds(): Promise<string[]> {
    return [...FIXTURE_SUBSCRIBED_CHANNEL_IDS]
  }

  async listSubscriptionUpdates(options: SubscriptionUpdateOptions): Promise<CatalogItem[]> {
    const channelIds = new Set(options.channelIds ?? FIXTURE_SUBSCRIBED_CHANNEL_IDS)
    const cutoff = Date.parse(options.publishedAfter)
    const perChannel = new Map<string, number>()
    const selected: CatalogItem[] = []

    for (const item of [...this.catalog].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
      if (!channelIds.has(item.channelId)) continue
      if (Date.parse(item.publishedAt) < cutoff) continue
      const taken = perChannel.get(item.channelId) ?? 0
      if (taken >= options.maxPerChannel) continue
      perChannel.set(item.channelId, taken + 1)
      selected.push(item)
    }
    return selected
  }

  async search(query: string, options: SearchOptions): Promise<CatalogItem[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = this.catalog
      .map((item) => {
        const haystack = `${item.title} ${item.tags.join(' ')} ${item.description}`.toLowerCase()
        const hits = terms.filter((term) => haystack.includes(term)).length
        return { item, hits }
      })
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.item.externalId.localeCompare(b.item.externalId))

    return scored.slice(0, options.maxResults).map((entry) => entry.item)
  }

  async hydrate(externalIds: string[]): Promise<CatalogItem[]> {
    const wanted = new Set(externalIds)
    return this.catalog.filter((item) => wanted.has(item.externalId))
  }
}
