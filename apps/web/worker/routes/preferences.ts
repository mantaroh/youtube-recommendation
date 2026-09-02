import { Hono } from 'hono'
import { interestControlRequestSchema, MUTE_DAYS, settingsPatchSchema } from '@ypr/domain'
import type { AppBindings } from './types.js'
import { deleteInterest, getInterest, listInterests, upsertInterest } from '../db/interests.js'
import { loadSettings, saveSettings } from '../db/settings.js'

/**
 * The preferences screen (design sections 12, 38 and 40).
 *
 * Everything here takes effect on the next feed rather than the next training run.
 * That is the whole point of keeping interest controls out of the model: "quieten this
 * for a month" should be a decision the user makes and sees, not a hint they leave for
 * a trainer to interpret at some later date.
 */
export const preferenceRoutes = new Hono<AppBindings>()

preferenceRoutes.get('/preferences', async (context) => {
  const app = context.get('app')
  const [interests, settings] = await Promise.all([
    listInterests(app.env.DB, app.profileId),
    loadSettings(app.env.DB, app.profileId),
  ])
  return context.json({ interests, settings, muteDays: MUTE_DAYS })
})

preferenceRoutes.post('/preferences', async (context) => {
  const app = context.get('app')
  const parsed = interestControlRequestSchema.safeParse(await context.req.json().catch(() => null))
  if (!parsed.success) {
    return context.json({ error: 'invalid interest', detail: parsed.error.flatten() }, 400)
  }

  const control = await upsertInterest(app.env.DB, {
    id: crypto.randomUUID(),
    profileId: app.profileId,
    keyword: parsed.data.keyword.trim(),
    weight: parsed.data.weight,
    muteUntil: parsed.data.muteUntil ?? null,
    now: app.now,
  })
  return context.json({ interest: control }, 201)
})

preferenceRoutes.put('/preferences/:id', async (context) => {
  const app = context.get('app')
  const id = context.req.param('id')

  const existing = await getInterest(app.env.DB, app.profileId, id)
  if (!existing) return context.json({ error: 'not found' }, 404)

  const parsed = interestControlRequestSchema.partial().safeParse(
    await context.req.json().catch(() => null),
  )
  if (!parsed.success) {
    return context.json({ error: 'invalid interest', detail: parsed.error.flatten() }, 400)
  }

  const control = await upsertInterest(app.env.DB, {
    id: existing.id,
    profileId: app.profileId,
    keyword: parsed.data.keyword?.trim() ?? existing.keyword,
    weight: parsed.data.weight ?? existing.weight,
    muteUntil: parsed.data.muteUntil === undefined ? existing.muteUntil : parsed.data.muteUntil,
    now: app.now,
  })
  return context.json({ interest: control })
})

preferenceRoutes.delete('/preferences/:id', async (context) => {
  const app = context.get('app')
  await deleteInterest(app.env.DB, app.profileId, context.req.param('id'))
  return context.json({ ok: true })
})

preferenceRoutes.get('/settings', async (context) => {
  const app = context.get('app')
  return context.json(await loadSettings(app.env.DB, app.profileId))
})

preferenceRoutes.put('/settings', async (context) => {
  const app = context.get('app')
  const parsed = settingsPatchSchema.safeParse(await context.req.json().catch(() => null))
  if (!parsed.success) {
    return context.json({ error: 'invalid settings', detail: parsed.error.flatten() }, 400)
  }
  return context.json(await saveSettings(app.env.DB, app.profileId, parsed.data, app.now))
})
