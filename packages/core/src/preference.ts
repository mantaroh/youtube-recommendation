import type {
  AppEvent,
  ChannelAffinity,
  InterestCluster,
  InterestOverrideEvent,
  PreferenceState,
  RatingValue,
} from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import {
  ACTIVITY_WEIGHTS,
  H_NEG_DAYS,
  H_SHORT_DAYS,
  K_MAX,
  PIN_MIN_ACTIVITY,
  RATING_WEIGHTS,
  TAU,
  TAU_Z_SCORE,
} from './constants.js'
import { adaptiveThreshold } from './calibration.js'
import { LeaderClusterer } from './clustering.js'
import { decayAt } from './decay.js'
import { labelClusters } from './labeling.js'

/**
 * Materialises the preference state from the event log (design section 3).
 *
 * The whole function is a fold over events in sequence order with no hidden state, which
 * is what makes "restore myself as of April 2026" a matter of stopping the fold early
 * rather than a feature of its own (design section 3.6).
 *
 * Interests are a set of clusters rather than one vector. Averaging unrelated interests
 * into a single centroid produces a point that represents neither of them and has nothing
 * near it, which is why scoring later takes a maximum across clusters (design section 3.1).
 */

export interface PreferenceInput {
  events: readonly AppEvent[]
  /** Vectors by item key. Ratings whose item has no vector cannot be placed and are skipped. */
  embeddings: ReadonlyMap<string, Float32Array>
  /** Free text by item key, used to name clusters. */
  texts?: ReadonlyMap<string, string>
  /** Channel id by item key, used for channel affinity. */
  channels?: ReadonlyMap<string, string>
  now: string
  modelId: string
  dimensions: number
  tau?: number
  kMax?: number
  /** Replay only events at or before this instant (design section 3.6). */
  upToTs?: string
  /** Replay only events at or before this sequence number. */
  upToSeq?: number
}

interface OverrideState {
  pinned: boolean
  mutedUntil: string | null
  forgotten: boolean
  forgottenAtSeq: number
  explicitStrength: number | null
  label: string | null
}

function emptyOverride(): OverrideState {
  return {
    pinned: false,
    mutedUntil: null,
    forgotten: false,
    forgottenAtSeq: -1,
    explicitStrength: null,
    label: null,
  }
}

export function buildPreferenceState(input: PreferenceInput): PreferenceState {
  const kMax = input.kMax ?? K_MAX
  const events = truncate(input.events, input.upToTs, input.upToSeq)

  /**
   * The threshold comes from the ratings rather than from settings, once there are enough
   * of them. A fixed cosine cannot work across embedding models: with a sentence encoder
   * every pair sits in a narrow high band, so a constant either merges everything into one
   * interest or separates nothing (design addendum 1).
   */
  const ratedVectors = events
    .filter((event): event is typeof event & { type: 'rating' } => event.type === 'rating')
    .map((event) => input.embeddings.get(itemKey(event)))
    .filter((vector): vector is Float32Array => Boolean(vector))

  const tau = adaptiveThreshold(ratedVectors, {
    zScore: TAU_Z_SCORE,
    fallback: input.tau ?? TAU,
  })

  const clusterer = new LeaderClusterer({ dimensions: input.dimensions, tau, kMax })
  const overrideEvents: InterestOverrideEvent[] = []
  const revivedAtSeq = new Map<string, number>()
  const channels: Record<string, ChannelAffinity> = {}
  const ratedKeys = new Set<string>()
  const seenKeys = new Set<string>()
  let atSeq = 0

  for (const event of events) {
    atSeq = Math.max(atSeq, event.seq)

    if (event.type === 'impression') {
      seenKeys.add(itemKey(event))
      continue
    }
    if (event.type === 'interest_override') {
      overrideEvents.push(event)
      continue
    }
    if (event.type === 'watch') {
      // Recorded but not yet used: the implicit signal ships at weight 0 (design section 2.2).
      continue
    }

    const key = itemKey(event)
    ratedKeys.add(key)

    const channelId = input.channels?.get(key)
    const weight = RATING_WEIGHTS[event.rating as RatingValue]
    if (channelId) {
      const affinity = channels[channelId] ?? { channelId, weightSum: 0, ratedCount: 0 }
      affinity.weightSum += weight
      affinity.ratedCount += 1
      channels[channelId] = affinity
    }

    const vector = input.embeddings.get(key)
    if (!vector) continue

    const cluster = clusterer.add({ key, weight, ts: event.ts }, vector)
    // Rating something positively again revives an interest that was forgotten earlier.
    if (weight > 0) revivedAtSeq.set(cluster.id, event.seq)
  }

  const overrides = applyOverrides(overrideEvents, clusterer)
  const clusters = materialiseClusters({
    clusterer,
    overrides,
    revivedAtSeq,
    now: input.now,
    texts: input.texts,
  })

  return {
    clusters,
    channels,
    ratedKeys: [...ratedKeys],
    seenKeys: [...seenKeys],
    atSeq,
    effectiveTau: tau,
    evaluatedAt: input.now,
    modelId: input.modelId,
    dimensions: input.dimensions,
  }
}

function truncate(
  events: readonly AppEvent[],
  upToTs: string | undefined,
  upToSeq: number | undefined,
): AppEvent[] {
  const cutoffMillis = upToTs === undefined ? undefined : Date.parse(upToTs)
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter((event) => {
      if (upToSeq !== undefined && event.seq > upToSeq) return false
      if (cutoffMillis !== undefined && Date.parse(event.ts) > cutoffMillis) return false
      return true
    })
}

function applyOverrides(
  overrideEvents: InterestOverrideEvent[],
  clusterer: LeaderClusterer,
): Map<string, OverrideState> {
  const overrides = new Map<string, OverrideState>()

  for (const event of overrideEvents) {
    // Resolve through merges, so an edit made before two clusters merged still applies.
    const id = clusterer.resolveId(event.clusterId)
    const state = overrides.get(id) ?? emptyOverride()

    switch (event.op) {
      case 'pin':
        state.pinned = true
        break
      case 'unpin':
        state.pinned = false
        break
      case 'mute':
        state.mutedUntil = event.untilTs ?? null
        break
      case 'unmute':
        state.mutedUntil = null
        break
      case 'forget':
        state.forgotten = true
        state.forgottenAtSeq = event.seq
        break
      case 'restore':
        state.forgotten = false
        state.forgottenAtSeq = -1
        break
      case 'set_strength':
        state.explicitStrength = event.value ?? null
        break
      case 'rename':
        state.label = event.label ?? null
        break
    }
    overrides.set(id, state)
  }

  return overrides
}

function materialiseClusters(context: {
  clusterer: LeaderClusterer
  overrides: Map<string, OverrideState>
  revivedAtSeq: Map<string, number>
  now: string
  texts: ReadonlyMap<string, string> | undefined
}): InterestCluster[] {
  const { clusterer, overrides, revivedAtSeq, now, texts } = context

  const masses = clusterer.clusters.map((cluster) => {
    let massLong = 0
    let massShort = 0
    let massNegative = 0
    for (const member of cluster.members) {
      massLong += member.weight
      massShort += member.weight * decayAt(member.ts, now, H_SHORT_DAYS)
      if (member.weight < 0) {
        massNegative += Math.abs(member.weight) * decayAt(member.ts, now, H_NEG_DAYS)
      }
    }
    return { massLong, massShort, massNegative }
  })

  /**
   * Long- and short-term mass share one denominator on purpose.
   *
   * Normalising each against its own maximum would make decay invisible: a user with a
   * single interest would see its short-term mass rescaled back to 1 no matter how old
   * the ratings behind it were. Against a common scale, a stale cluster's short-term
   * component really does fall to nearly nothing, which is the behaviour the model is
   * supposed to have. It also makes the two comparable, which a weighted sum requires.
   */
  const massScale = Math.max(0, ...masses.map((mass) => mass.massLong))
  const maxNegative = Math.max(0, ...masses.map((mass) => mass.massNegative))

  const labels = labelClusters(
    clusterer.clusters.map((cluster) => ({
      id: cluster.id,
      texts: cluster.members.map((member) => texts?.get(member.key) ?? ''),
    })),
  )

  return clusterer.clusters.map((cluster, index) => {
    const mass = masses[index]
    const override = overrides.get(cluster.id) ?? emptyOverride()

    const forgotten =
      override.forgotten && (revivedAtSeq.get(cluster.id) ?? -1) <= override.forgottenAtSeq
    const muted = override.mutedUntil !== null && Date.parse(override.mutedUntil) > Date.parse(now)

    const normalisedLong = massScale > 0 ? clamp01(mass.massLong / massScale) : 0
    const normalisedShort = massScale > 0 ? clamp01(mass.massShort / massScale) : 0

    let activity: number
    if (override.explicitStrength === null) {
      // With no explicit strength set, share its weight between the other two components
      // rather than treating it as a zero, which would penalise every unedited interest.
      const denominator = ACTIVITY_WEIGHTS.long + ACTIVITY_WEIGHTS.short
      activity =
        (ACTIVITY_WEIGHTS.long * normalisedLong + ACTIVITY_WEIGHTS.short * normalisedShort) /
        denominator
    } else {
      activity =
        ACTIVITY_WEIGHTS.long * normalisedLong +
        ACTIVITY_WEIGHTS.short * normalisedShort +
        ACTIVITY_WEIGHTS.explicit * override.explicitStrength
    }
    activity = clamp01(activity)

    if (override.pinned) activity = Math.max(activity, PIN_MIN_ACTIVITY)
    if (muted || forgotten) activity = 0

    return {
      id: cluster.id,
      label: override.label ?? labels.get(cluster.id) ?? 'Unnamed interest',
      labelSource: override.label ? 'user' : 'auto',
      centroid: cluster.centroid,
      memberIds: cluster.members.map((member) => member.key),
      massLong: mass.massLong,
      massShort: mass.massShort,
      massNegative: mass.massNegative,
      // Exposed normalised so the ranker does not have to renormalise per candidate.
      normalisedLong,
      normalisedShort,
      normalisedNegative: maxNegative > 0 ? clamp01(mass.massNegative / maxNegative) : 0,
      explicitStrength: override.explicitStrength,
      pinned: override.pinned,
      mutedUntil: override.mutedUntil,
      forgotten,
      activity,
      updatedAt: now,
    } satisfies InterestCluster
  })
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
