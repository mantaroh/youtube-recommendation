import { z } from 'zod'

/**
 * Runtime schemas.
 *
 * These guard the boundaries where malformed data would corrupt something that cannot
 * be recomputed: appending a rating event, importing a backup, and accepting a result
 * from the GPU service. Everything else is validated by TypeScript alone.
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

export const epochMillis = z.number().int().nonnegative()

export const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO 8601 timestamp',
})

// ---------------------------------------------------------------------------
// API requests
// ---------------------------------------------------------------------------

export const rateRequestSchema = z.object({
  rating: ratingValueSchema,
})

export const interestControlRequestSchema = z.object({
  keyword: z.string().min(1).max(128),
  weight: z.number().min(0).max(3),
  /** Null clears a timed mute; a number is the instant it expires. */
  muteUntil: epochMillis.nullable().optional(),
})

export const settingsPatchSchema = z.object({
  discovery: z.number().min(0).max(1).optional(),
  feedSize: z.number().int().min(1).max(200).optional(),
  maxPerChannel: z.number().int().min(1).max(20).optional(),
  laneMix: z
    .object({
      subscription: z.number().min(0).max(1),
      related: z.number().min(0).max(1),
      explore: z.number().min(0).max(1),
    })
    .optional(),
})

export const discoveryRunRequestSchema = z.object({
  lanes: z.array(laneSchema).min(1).optional(),
  /** Cap on `search.list` calls for this run, below the daily budget. */
  searchBudget: z.number().int().min(0).max(100).optional(),
})

export const feedQuerySchema = z.object({
  lane: laneSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

// ---------------------------------------------------------------------------
// Import and export (design sections 45 and 46)
// ---------------------------------------------------------------------------

/**
 * One line of `ratings.jsonl`.
 *
 * This is the format the design calls the permanent record (design section 61), so it
 * is deliberately free of anything derived: no score, no model version, no lane. A
 * reader needs only this and the video id to reconstruct what was liked and when.
 */
export const ratingExportLineSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  source: sourceSchema,
  externalId: z.string().min(1),
  rating: ratingValueSchema,
  createdAt: isoTimestamp,
  disabledAt: isoTimestamp.nullable(),
})

export type RatingExportLine = z.infer<typeof ratingExportLineSchema>

// ---------------------------------------------------------------------------
// GPU results (design sections 23 and 24)
// ---------------------------------------------------------------------------

export const scoreBatchResultSchema = z.object({
  modelVersion: z.string().min(1),
  items: z.array(
    z.object({
      id: z.string().min(1),
      score: z.number(),
    }),
  ),
})

export const trainResultSchema = z.object({
  modelVersion: z.string().min(1),
  modelPath: z.string(),
  trainedEventCount: z.number().int().nonnegative(),
  trainedSeconds: z.number().nonnegative(),
  accuracy: z.record(z.string(), z.number()).optional(),
})

export const embedBatchResultSchema = z.object({
  dimensions: z.number().int().positive(),
  items: z.array(
    z.object({
      id: z.string().min(1),
      vector: z.array(z.number()),
    }),
  ),
})

export const describeBatchResultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string(),
    }),
  ),
})
