import { z } from 'zod'

/**
 * Runtime schemas.
 *
 * These guard the two places where malformed data would silently corrupt the event log:
 * appending an event, and importing / restoring a backup. Embeddings are not validated
 * here because `Float32Array` is checked structurally at the storage layer instead.
 */

export const sourceSchema = z.literal('youtube')

export const ratingValueSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
])

export const laneSchema = z.enum(['subscription', 'related', 'explore'])

export const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO 8601 timestamp',
})

export const catalogItemSchema = z.object({
  source: sourceSchema,
  externalId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  channelId: z.string(),
  channelTitle: z.string(),
  officialCategoryId: z.string(),
  durationSeconds: z.number().nonnegative(),
  publishedAt: isoTimestamp,
  viewCount: z.number().nonnegative(),
  metadataFetchedAt: isoTimestamp,
  expiresAt: isoTimestamp,
  provenance: z.enum(['youtube_api', 'fixture']),
})

const eventBase = {
  seq: z.number().int().nonnegative(),
  ts: isoTimestamp,
}

export const ratingEventSchema = z.object({
  ...eventBase,
  type: z.literal('rating'),
  source: sourceSchema,
  externalId: z.string().min(1),
  rating: ratingValueSchema,
})

export const interestOverrideEventSchema = z.object({
  ...eventBase,
  type: z.literal('interest_override'),
  clusterId: z.string().min(1),
  op: z.enum(['pin', 'unpin', 'mute', 'unmute', 'forget', 'restore', 'set_strength', 'rename']),
  value: z.number().min(0).max(1).optional(),
  label: z.string().optional(),
  untilTs: isoTimestamp.optional(),
})

export const watchEventSchema = z.object({
  ...eventBase,
  type: z.literal('watch'),
  source: sourceSchema,
  externalId: z.string().min(1),
  watchedSeconds: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
})

export const impressionEventSchema = z.object({
  ...eventBase,
  type: z.literal('impression'),
  source: sourceSchema,
  externalId: z.string().min(1),
  lane: laneSchema,
  position: z.number().int().nonnegative(),
})

export const appEventSchema = z.discriminatedUnion('type', [
  ratingEventSchema,
  interestOverrideEventSchema,
  watchEventSchema,
  impressionEventSchema,
])

/** Same as `appEventSchema` but without `seq`, which the store assigns on append. */
export const newEventSchema = z.discriminatedUnion('type', [
  ratingEventSchema.omit({ seq: true }),
  interestOverrideEventSchema.omit({ seq: true }),
  watchEventSchema.omit({ seq: true }),
  impressionEventSchema.omit({ seq: true }),
])

export const scoreWeightsSchema = z.object({
  channel: z.number(),
  long: z.number(),
  short: z.number(),
  negative: z.number(),
  explore: z.number(),
  freshness: z.number(),
  watch: z.number(),
})

export const appSettingsSchema = z.object({
  discovery: z.number().min(0).max(1),
  scoreWeights: scoreWeightsSchema,
  tau: z.number().min(0).max(1),
  kMax: z.number().int().positive(),
  feedSize: z.number().int().positive(),
  subscribedChannelIds: z.array(z.string()),
})
