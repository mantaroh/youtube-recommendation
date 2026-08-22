import { describe, expect, it } from 'vitest'
import {
  METADATA_TTL_DAYS,
  embeddingTextFor,
  isExpired,
  parseIso8601Duration,
  toCatalogItem,
} from '../src/lib/sources/youtube/mapper.js'

const FETCHED_AT = '2026-08-22T00:00:00.000Z'

describe('parseIso8601Duration', () => {
  it('reads hours, minutes and seconds', () => {
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723)
    expect(parseIso8601Duration('PT15M')).toBe(900)
    expect(parseIso8601Duration('PT45S')).toBe(45)
    expect(parseIso8601Duration('P1DT2H')).toBe(93_600)
  })

  it('returns zero for missing or unparseable values rather than throwing', () => {
    expect(parseIso8601Duration(undefined)).toBe(0)
    expect(parseIso8601Duration('nonsense')).toBe(0)
  })
})

describe('toCatalogItem', () => {
  const resource = {
    id: 'abc123',
    snippet: {
      title: 'Inside the compositor thread',
      description: 'A walk through the compositor.',
      tags: ['browser', 'rendering'],
      channelId: 'UC_x',
      channelTitle: 'Rendering Pipeline',
      categoryId: '28',
      publishedAt: '2026-08-01T09:00:00.000Z',
    },
    contentDetails: { duration: 'PT12M30S' },
    statistics: { viewCount: '4210' },
  }

  it('copies only the fields the design allows and stamps a 30 day TTL', () => {
    const item = toCatalogItem(resource, { fetchedAt: FETCHED_AT })
    expect(item).toMatchObject({
      source: 'youtube',
      externalId: 'abc123',
      officialCategoryId: '28',
      durationSeconds: 750,
      viewCount: 4210,
      provenance: 'youtube_api',
    })
    const ttlDays = (Date.parse(item.expiresAt) - Date.parse(item.metadataFetchedAt)) / 86_400_000
    expect(ttlDays).toBe(METADATA_TTL_DAYS)
  })

  it('survives a sparse resource without inventing values', () => {
    const item = toCatalogItem({ id: 'bare' }, { fetchedAt: FETCHED_AT })
    expect(item.title).toBe('')
    expect(item.tags).toEqual([])
    expect(item.viewCount).toBe(0)
    expect(item.officialCategoryId).toBe('')
    // With no publication date the fetch time stands in, so ordering still works.
    expect(item.publishedAt).toBe(FETCHED_AT)
  })

  it('marks an item expired once its TTL has passed', () => {
    const item = toCatalogItem(resource, { fetchedAt: FETCHED_AT })
    expect(isExpired(item, '2026-09-01T00:00:00.000Z')).toBe(false)
    expect(isExpired(item, '2026-09-30T00:00:00.000Z')).toBe(true)
  })
})

describe('embeddingTextFor', () => {
  it('leads with the title and truncates long descriptions', () => {
    const item = toCatalogItem(
      {
        id: 'x',
        snippet: {
          title: 'Kernel scheduling',
          description: 'x'.repeat(2000),
          channelTitle: 'Kernel Space',
          tags: ['kernel'],
        },
      },
      { fetchedAt: FETCHED_AT },
    )
    const text = embeddingTextFor(item)
    expect(text.startsWith('Kernel scheduling\nKernel scheduling')).toBe(true)
    expect(text).toContain('Kernel Space')
    expect(text.length).toBeLessThan(800)
  })
})
