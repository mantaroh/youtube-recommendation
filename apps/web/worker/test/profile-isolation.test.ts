import { describe, expect, it } from 'vitest'
import { ensureProfile } from '../db/settings.js'
import {
  addCandidates,
  listChannels,
  listChannelsToRefresh,
  markChannelsFetched,
  setSubscribed,
  upsertChannels,
} from '../db/videos.js'
import { buildFeed } from '../services/recommendation/feed.js'
import { createTestDatabase } from './d1.js'
import { seedVideo } from './fixtures.js'

/**
 * What one profile can see of another's (`docs/design/multi-profile.ja.md`).
 *
 * These exist because the separation was reported working and was not. Subscriptions
 * were a flag on the shared channel row, so the second account's feed was built from
 * the first account's channels, and syncing the second would have cleared the first's
 * list on the way past. Nothing failed; the wrong feed simply appeared.
 *
 * So the assertions here are about absence — that a profile does *not* see something —
 * which is the shape of assertion that would have caught it.
 */

const NOW = 1_700_000_000_000

async function twoProfiles(): Promise<D1Database> {
  const db = createTestDatabase()
  await ensureProfile(db, 'private', NOW)
  return db
}

describe('subscriptions belong to one profile', () => {
  it('does not show one profile the channels another follows', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCwork', subscribed: true })

    expect((await listChannels(db, 'default', { subscribedOnly: true })).map((c) => c.id)).toEqual([
      'youtube:UCwork',
    ])
    expect(await listChannels(db, 'private', { subscribedOnly: true })).toEqual([])
  })

  it('reports `subscribed` per profile on the same channel row', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCshared', subscribed: true })

    const forDefault = await listChannels(db, 'default')
    const forPrivate = await listChannels(db, 'private')

    expect(forDefault.find((c) => c.id === 'youtube:UCshared')?.subscribed).toBe(true)
    // Same row, same title: only the relation differs.
    expect(forPrivate.find((c) => c.id === 'youtube:UCshared')?.subscribed).toBe(false)
    expect(forPrivate.find((c) => c.id === 'youtube:UCshared')?.title).toBe('UCshared')
  })

  it('leaves one profile\'s list alone when another syncs', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCkeep', subscribed: true })
    await seedVideo(db, { id: 'youtube:b', channelExternalId: 'UCnew' })

    // The old implementation cleared every row in the table before writing its own.
    await setSubscribed(db, 'private', ['youtube:UCnew'], NOW)

    expect((await listChannels(db, 'default', { subscribedOnly: true })).map((c) => c.id)).toEqual([
      'youtube:UCkeep',
    ])
    expect((await listChannels(db, 'private', { subscribedOnly: true })).map((c) => c.id)).toEqual([
      'youtube:UCnew',
    ])
  })

  it('replaces within a profile, so unsubscribing on YouTube reaches this system', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCold', subscribed: true })
    await seedVideo(db, { id: 'youtube:b', channelExternalId: 'UCnew' })

    await setSubscribed(db, 'default', ['youtube:UCnew'], NOW)

    expect((await listChannels(db, 'default', { subscribedOnly: true })).map((c) => c.id)).toEqual([
      'youtube:UCnew',
    ])
  })

  it('walks a channel once for everyone who follows it', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCboth', subscribed: true })
    await seedVideo(db, { id: 'youtube:b', channelExternalId: 'UConly' })
    await seedVideo(db, { id: 'youtube:c', channelExternalId: 'UCnone' })
    await setSubscribed(db, 'private', ['youtube:UCboth', 'youtube:UConly'], NOW)

    // The uploads go into the shared catalog, so fetching per profile would spend the
    // same quota twice for the same videos.
    const toRefresh = (await listChannelsToRefresh(db, 10)).map((c) => c.id).sort()
    expect(toRefresh).toEqual(['youtube:UCboth', 'youtube:UConly'])
  })
})

describe('the feed of a profile with nothing of its own', () => {
  it('offers no subscription lane built from another profile', async () => {
    const db = await twoProfiles()
    for (const id of ['a', 'b', 'c']) {
      await seedVideo(db, {
        id: `youtube:${id}`,
        channelExternalId: 'UCwork',
        subscribed: true,
        publishedAt: NOW - 86_400_000,
      })
    }

    const mine = await buildFeed(db, { profileId: 'default', now: NOW })
    const theirs = await buildFeed(db, { profileId: 'private', now: NOW })

    expect(mine.items.some((item) => item.lane === 'subscription')).toBe(true)
    // The reported symptom: the same suggestions on the second hostname.
    expect(theirs.items.some((item) => item.lane === 'subscription')).toBe(false)
  })

  it('does not award a subscription bonus for another profile\'s channel', async () => {
    const db = await twoProfiles()
    await seedVideo(db, {
      id: 'youtube:a',
      channelExternalId: 'UCwork',
      subscribed: true,
      publishedAt: NOW - 86_400_000,
    })

    const theirs = await buildFeed(db, { profileId: 'private', now: NOW })
    for (const item of theirs.items) {
      expect(item.breakdown.subscriptionBonus).toBe(0)
    }
  })
})

describe('a newly subscribed channel', () => {
  /**
   * The second account synced two hundred channels and not one of their videos was ever
   * fetched. `upsertChannels` stamped `last_fetched_at` with the moment the channel was
   * first *seen*, the refresh walks least-recently-fetched first, and so the new
   * channels sorted behind every channel the first account already had. Nothing failed;
   * the queue simply never reached them.
   */
  it('is recorded as never fetched, not as just fetched', async () => {
    const db = await twoProfiles()
    await upsertChannels(db, 'youtube', [
      { externalId: 'UCfresh', title: 'Fresh', thumbnailUrl: null },
    ])

    const [channel] = await listChannels(db, 'default')
    expect(channel.lastFetchedAt).toBeNull()
  })

  it('is walked before channels whose uploads have already been read', async () => {
    const db = await twoProfiles()
    // An established channel, walked long ago but walked.
    await seedVideo(db, { id: 'youtube:old', channelExternalId: 'UCold', subscribed: true })
    await markChannelsFetched(db, ['youtube:UCold'], NOW - 86_400_000)

    await upsertChannels(db, 'youtube', [
      { externalId: 'UCnew', title: 'New', thumbnailUrl: null },
    ])
    await setSubscribed(db, 'private', ['youtube:UCnew'], NOW)

    // Least-recently-fetched first, and "never" is less recent than any timestamp.
    expect((await listChannelsToRefresh(db, 10)).map((c) => c.id)).toEqual([
      'youtube:UCnew',
      'youtube:UCold',
    ])
  })

  it('does not lose the timestamp of a channel that is already known', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCknown', subscribed: true })
    await markChannelsFetched(db, ['youtube:UCknown'], NOW)

    // Seeing it again in a search result must not reset it to "never fetched", which
    // would have the walk return to it immediately and spend quota re-reading it.
    await upsertChannels(db, 'youtube', [
      { externalId: 'UCknown', title: 'Known', thumbnailUrl: null },
    ])

    const [channel] = await listChannels(db, 'default', { subscribedOnly: true })
    expect(channel.lastFetchedAt).toBe(NOW)
  })
})

describe('the candidate pool belongs to one profile', () => {
  /**
   * The catalog is shared and the feed is not. Both directions of this were reported: a
   * hundred and thirty videos from the second account's channels appeared in the first
   * account's explore lane, and three thousand of the first's appeared in the second's.
   * Storing one copy of a video was right; treating it as everyone's candidate was not.
   */
  it('does not offer a profile what another profile\'s discovery found', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:mine', publishedAt: NOW - 86_400_000 })
    await seedVideo(db, {
      id: 'youtube:theirs',
      profileId: 'private',
      channelExternalId: 'UCtheirs',
      publishedAt: NOW - 86_400_000,
    })

    const mine = await buildFeed(db, { profileId: 'default', now: NOW })
    const theirs = await buildFeed(db, { profileId: 'private', now: NOW })

    expect(mine.items.map((item) => item.video.id)).toEqual(['youtube:mine'])
    expect(theirs.items.map((item) => item.video.id)).toEqual(['youtube:theirs'])
  })

  it('offers a video to both when both found it', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:common', publishedAt: NOW - 86_400_000 })
    // The same video reached by the other profile's discovery: one row, two candidacies.
    await addCandidates(db, 'private', ['youtube:common'], NOW)

    for (const profileId of ['default', 'private']) {
      const feed = await buildFeed(db, { profileId, now: NOW })
      expect(feed.items.map((item) => item.video.id)).toEqual(['youtube:common'])
    }
  })

  it('stores the video once however many profiles reach it', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:common', publishedAt: NOW - 86_400_000 })
    await addCandidates(db, 'private', ['youtube:common'], NOW)

    // The point of the shared catalog: not two rows, and not two fetches of the
    // metadata to build them.
    const row = await db.prepare('SELECT COUNT(*) AS n FROM videos').first<{ n: number }>()
    expect(row?.n).toBe(1)
  })
})
