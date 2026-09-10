import { describe, expect, it } from 'vitest'
import { SCORE_BATCH_SIZE } from '@ypr/domain'
import { ensureProfile } from '../db/settings.js'
import {
  addCandidates,
  addSubscriptionCandidates,
  listChannels,
  loadVideosWithChannels,
  listChannelsToRefresh,
  markChannelsFetched,
  setSubscribed,
  upsertChannels,
} from '../db/videos.js'
import { unscoredVideoIds } from '../db/models.js'
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

describe('loading a batch of videos', () => {
  /**
   * D1 numbers bound parameters `?1` to `?100` and refuses `?101`.
   *
   * The chunk was a hundred, from before the profile was bound at all. Adding the
   * profile as `?1` made every full chunk one over, and a scoring batch is exactly a
   * hundred videos — so every `score_batch` claim answered 500 and a night's work was
   * lost. Nothing in the suite had ever loaded more than a handful at once.
   */
  it('loads more videos than D1 allows bound parameters for', async () => {
    const db = await twoProfiles()
    const ids: string[] = []
    for (let index = 0; index < 250; index++) {
      const id = `youtube:v${index}`
      await seedVideo(db, { id })
      ids.push(id)
    }

    const loaded = await loadVideosWithChannels(db, 'default', ids)

    expect(loaded).toHaveLength(250)
    expect(new Set(loaded.map((entry) => entry.video.id)).size).toBe(250)
  })

  it('loads exactly a scoring batch, which is where this broke', async () => {
    const db = await twoProfiles()
    const ids: string[] = []
    for (let index = 0; index < SCORE_BATCH_SIZE; index++) {
      const id = `youtube:b${index}`
      await seedVideo(db, { id })
      ids.push(id)
    }

    expect(await loadVideosWithChannels(db, 'default', ids)).toHaveLength(SCORE_BATCH_SIZE)
  })
})

describe('what the upload walk attributes', () => {
  /**
   * The third leak of the same kind, and the reason this describe block asserts a
   * property rather than a case.
   *
   * The walk deliberately reads the union of every profile's subscriptions, so one
   * channel two profiles follow costs one fetch. The mistake was filing the result under
   * whoever ran the pass: a hundred and ninety-five videos from channels only the second
   * account followed ended up in the first account's feed, and the same in reverse.
   */
  it('files a video against the profiles that subscribe to its channel', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:theirs', channelExternalId: 'UCtheirs' })
    await setSubscribed(db, 'private', ['youtube:UCtheirs'], NOW)
    // Written with no candidacy, exactly as the walk stores them.
    await db.prepare('DELETE FROM profile_candidates').run()

    await addSubscriptionCandidates(db, ['youtube:theirs'], NOW)

    const rows = await db
      .prepare('SELECT profile_id FROM profile_candidates WHERE video_id = ?1')
      .bind('youtube:theirs')
      .all<{ profile_id: string }>()
    expect(rows.results?.map((row) => row.profile_id)).toEqual(['private'])
  })

  it('files it against both when both subscribe', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:shared', channelExternalId: 'UCboth' })
    await setSubscribed(db, 'default', ['youtube:UCboth'], NOW)
    await setSubscribed(db, 'private', ['youtube:UCboth'], NOW)
    await db.prepare('DELETE FROM profile_candidates').run()

    await addSubscriptionCandidates(db, ['youtube:shared'], NOW)

    const rows = await db
      .prepare('SELECT profile_id FROM profile_candidates WHERE video_id = ?1 ORDER BY profile_id')
      .bind('youtube:shared')
      .all<{ profile_id: string }>()
    expect(rows.results?.map((row) => row.profile_id)).toEqual(['default', 'private'])
  })

  it('files it against nobody when nobody subscribes', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:orphan', channelExternalId: 'UCnobody' })
    await db.prepare('DELETE FROM profile_candidates').run()

    expect(await addSubscriptionCandidates(db, ['youtube:orphan'], NOW)).toBe(0)
  })

  /**
   * The property, not the case. Whatever the walk does, no profile should end up with a
   * candidate from a channel only somebody else follows — which is the shape all three
   * leaks took and the thing to check after any change to discovery.
   */
  it('leaves no profile holding a candidate from a channel only another follows', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:a', channelExternalId: 'UCmine' })
    await seedVideo(db, { id: 'youtube:b', channelExternalId: 'UCtheirs' })
    await setSubscribed(db, 'default', ['youtube:UCmine'], NOW)
    await setSubscribed(db, 'private', ['youtube:UCtheirs'], NOW)
    await db.prepare('DELETE FROM profile_candidates').run()

    await addSubscriptionCandidates(db, ['youtube:a', 'youtube:b'], NOW)

    const leaked = await db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM profile_candidates pc
           JOIN videos v ON v.id = pc.video_id
          WHERE EXISTS (SELECT 1 FROM profile_subscriptions s
                         WHERE s.channel_id = v.channel_id AND s.profile_id <> pc.profile_id)
            AND NOT EXISTS (SELECT 1 FROM profile_subscriptions t
                             WHERE t.channel_id = v.channel_id AND t.profile_id = pc.profile_id)`,
      )
      .first<{ n: number }>()
    expect(leaked?.n).toBe(0)
  })

  it('stays inside D1\'s bound parameters for a full walk', async () => {
    const db = await twoProfiles()
    const ids: string[] = []
    for (let index = 0; index < 250; index++) {
      const id = `youtube:w${index}`
      await seedVideo(db, { id, channelExternalId: 'UCwalk' })
      ids.push(id)
    }
    await setSubscribed(db, 'private', ['youtube:UCwalk'], NOW)
    await db.prepare('DELETE FROM profile_candidates').run()

    expect(await addSubscriptionCandidates(db, ids, NOW)).toBe(250)
  })
})

describe('what a profile is asked to score', () => {
  /**
   * The candidate pool was split per profile and the scoring backlog was not. It read
   * `videos` directly, so one account's nightly hours went partly to videos only the
   * other account would ever be shown — two hundred and twenty-eight of nine hundred and
   * nineteen, at about half a minute each.
   *
   * Nothing leaked: a score is written under the profile that asked for it. The work
   * went to the wrong feed, which is a different kind of wrong and just as invisible.
   */
  it('is its own candidates, not the whole catalog', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:mine', publishedAt: NOW })
    await seedVideo(db, { id: 'youtube:theirs', profileId: 'private', publishedAt: NOW })

    const mine = await unscoredVideoIds(db, 'default', 'model-1', {
      publishedAfter: NOW - 86_400_000,
      limit: 50,
    })
    expect(mine).toEqual(['youtube:mine'])

    const theirs = await unscoredVideoIds(db, 'private', 'model-1', {
      publishedAfter: NOW - 86_400_000,
      limit: 50,
    })
    expect(theirs).toEqual(['youtube:theirs'])
  })

  it('leaves out what is too short to be offered', async () => {
    const db = await twoProfiles()
    await seedVideo(db, { id: 'youtube:long', publishedAt: NOW, durationSeconds: 600 })

    // Ingest refuses a short outright, so one is written past it to stand for the rows
    // already stored — the rated ones, which keep their rows.
    await db
      .prepare(
        `INSERT INTO videos (id, source, external_id, title, duration_seconds, discovered_at, published_at)
         VALUES ('youtube:short', 'youtube', 'short', 'Old short', 45, ?1, ?1)`,
      )
      .bind(NOW)
      .run()
    await addCandidates(db, 'default', ['youtube:short'], NOW)

    const ids = await unscoredVideoIds(db, 'default', 'model-1', {
      publishedAfter: NOW - 86_400_000,
      limit: 50,
    })
    expect(ids).toEqual(['youtube:long'])
  })
})
