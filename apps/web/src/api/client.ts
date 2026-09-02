import type {
  AppSettings,
  Channel,
  Feed,
  GpuJob,
  InterestControl,
  Lane,
  ModelVersion,
  RatingEvent,
  RatingValue,
  Video,
} from '@ypr/domain'

/**
 * The API client.
 *
 * Same origin, so no credentials are configured and none are needed: Cloudflare Access
 * is in front of the whole deployment and its cookie travels with the request on its
 * own (design sections 5 and 43). There is no API key in this file, and there is no
 * path from the browser to YouTube or Runpod — both are reached through the Worker
 * (design section 43).
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: unknown }
    throw new ApiError(body.error ?? `request failed (${response.status})`, response.status, body.detail)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export interface StatusResponse {
  identity: string | null
  profileId: string
  videos: number
  subscribedChannels: number
  ratings: number
  activeModel: ModelVersion | null
  searchCallsUsedToday: number
  configured: {
    youtubeApiKey: boolean
    oauth: boolean
    runpod: boolean
    backups: boolean
    access: boolean
  }
}

export interface VideoResponse {
  video: Video
  channel: Channel | null
  rating: RatingValue | null
  history: RatingEvent[]
  predictedScore: number | null
  modelVersion: string | null
}

export interface PreferencesResponse {
  interests: InterestControl[]
  settings: AppSettings
  muteDays: number
}

export interface ModelResponse {
  active: ModelVersion | null
  versions: ModelVersion[]
  lastTrainedAt: number | null
  ratingsSinceLastTraining: number
  minimumRatings: number
  runpodConfigured: boolean
}

export interface DiscoverySummary {
  lane: Lane
  queries: string[]
  found: number
  stored: number
  searchCalls: number
  listCalls: number
  errors: string[]
}

export interface YouTubeStatus {
  configured: boolean
  connected: boolean
  scope?: string | null
  expiresAt?: number | null
}

export const api = {
  status: () => request<StatusResponse>('/status'),

  feed: (options: { lane?: Lane; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (options.lane) params.set('lane', options.lane)
    if (options.limit) params.set('limit', String(options.limit))
    const query = params.toString()
    return request<Feed>(`/feed${query ? `?${query}` : ''}`)
  },

  video: (id: string) => request<VideoResponse>(`/videos/${encodeURIComponent(id)}`),

  rate: (id: string, rating: RatingValue) =>
    request<{ event: RatingEvent }>(`/videos/${encodeURIComponent(id)}/rating`, {
      method: 'POST',
      body: JSON.stringify({ rating }),
    }),

  preferences: () => request<PreferencesResponse>('/preferences'),

  createInterest: (input: { keyword: string; weight: number; muteUntil?: number | null }) =>
    request<{ interest: InterestControl }>('/preferences', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateInterest: (id: string, input: { weight?: number; muteUntil?: number | null }) =>
    request<{ interest: InterestControl }>(`/preferences/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteInterest: (id: string) =>
    request<{ ok: true }>(`/preferences/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  settings: () => request<AppSettings>('/settings'),

  saveSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  model: () => request<ModelResponse>('/model'),

  train: () => request<{ jobId: string; modelVersion: string; eventCount: number }>('/model/train', {
    method: 'POST',
  }),

  score: () => request<{ jobIds: string[]; itemCount: number }>('/model/score', { method: 'POST' }),

  runDiscovery: (input: { lanes?: Lane[]; searchBudget?: number } = {}) =>
    request<{ summaries: DiscoverySummary[]; searchBudgetLeft: number }>('/discovery/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  syncSubscriptions: () =>
    request<{ channels: number; errors: string[] }>('/discovery/subscriptions', { method: 'POST' }),

  channels: () => request<{ channels: Channel[] }>('/channels'),

  jobs: () => request<{ jobs: GpuJob[] }>('/jobs'),

  pollJobs: () => request<unknown>('/jobs/poll', { method: 'POST' }),

  youtubeStatus: () => request<YouTubeStatus>('/auth/youtube/status'),

  disconnectYouTube: () => request<{ connected: false }>('/auth/youtube', { method: 'DELETE' }),

  backup: () => request<unknown>('/backup', { method: 'POST' }),
}
