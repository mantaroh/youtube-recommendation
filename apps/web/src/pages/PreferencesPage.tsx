import { useCallback, useEffect, useState } from 'react'
import type { InterestControl } from '@ypr/domain'
import { INTEREST_WEIGHT_STEPS, MUTE_DAYS } from '@ypr/domain'
import { api, type PreferencesResponse } from '../api/client.js'
import { formatDate } from '../domain/reasons.js'

/**
 * The preferences screen (design section 38).
 *
 * Every row is one term of the scoring function, which is what makes the model
 * editable and explainable for the same reason: there is nothing here that acts on the
 * feed and is not on the screen, and nothing on the screen that does not act on the
 * feed.
 *
 * Changes apply to the next feed, not the next training run.
 */
export function PreferencesPage() {
  const [data, setData] = useState<PreferencesResponse | null>(null)
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.preferences())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const adjust = useCallback(
    async (control: InterestControl, weight: number, muteUntil: number | null = null) => {
      setBusy(true)
      try {
        await api.updateInterest(control.id, { weight, muteUntil })
        await load()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const add = useCallback(async () => {
    const trimmed = keyword.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await api.createInterest({ keyword: trimmed, weight: INTEREST_WEIGHT_STEPS.boost })
      setKeyword('')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [keyword, load])

  const setDiscovery = useCallback(
    async (discovery: number) => {
      setData((current) =>
        current ? { ...current, settings: { ...current.settings, discovery } } : current,
      )
      try {
        await api.saveSettings({ discovery })
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [],
  )

  if (!data) return <p className="notice">Loading…</p>

  return (
    <section className="page">
      <h1>Preferences</h1>
      {error && <p className="notice notice-error">{error}</p>}

      <div className="panel">
        <h2>Interests</h2>
        <p className="panel-note">
          These apply when the feed is built, so a change here shows up on the next refresh rather
          than after the next training run.
        </p>

        <div className="add-interest">
          <input
            type="text"
            value={keyword}
            placeholder="Add a keyword, e.g. firefox internals"
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add()
            }}
          />
          <button type="button" onClick={() => void add()} disabled={busy || !keyword.trim()}>
            More of this
          </button>
        </div>

        {data.interests.length === 0 ? (
          <p className="notice">
            Nothing set. Without any, the feed is ranked entirely by what the model has learned from
            your ratings.
          </p>
        ) : (
          <ul className="interests">
            {data.interests.map((control) => (
              <li key={control.id} className="interest">
                <span className="interest-name">{control.keyword}</span>
                <span className="interest-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, control.weight * 50)}%` }} />
                </span>
                <span className="interest-state">{describeState(control)}</span>
                <span className="interest-actions">
                  <button type="button" disabled={busy} onClick={() => void adjust(control, INTEREST_WEIGHT_STEPS.boost)}>
                    More
                  </button>
                  <button type="button" disabled={busy} onClick={() => void adjust(control, INTEREST_WEIGHT_STEPS.reduce)}>
                    Less
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void adjust(control, control.weight, Date.now() + MUTE_DAYS * 86_400_000)
                    }
                  >
                    Mute {MUTE_DAYS}d
                  </button>
                  <button type="button" disabled={busy} onClick={() => void adjust(control, INTEREST_WEIGHT_STEPS.mute)}>
                    Mute
                  </button>
                  <button type="button" disabled={busy} onClick={() => void adjust(control, INTEREST_WEIGHT_STEPS.neutral)}>
                    Reset
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      await api.deleteInterest(control.id)
                      await load()
                    }}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h2>Discovery</h2>
        <p className="panel-note">
          Whether today is for going deeper or for finding something unfamiliar is your decision,
          not something inferred on your behalf.
        </p>
        <div className="slider">
          <span>Known</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={data.settings.discovery}
            onChange={(event) => void setDiscovery(Number(event.target.value))}
          />
          <span>Explore</span>
        </div>
        <p className="panel-note">
          Currently {Math.round(data.settings.discovery * 100)}% toward exploring. The feed mix is{' '}
          {Math.round(data.settings.laneMix.subscription * 100)}% subscribed,{' '}
          {Math.round(data.settings.laneMix.related * 100)}% near your interests,{' '}
          {Math.round(data.settings.laneMix.explore * 100)}% further afield.
        </p>
      </div>
    </section>
  )
}

function describeState(control: InterestControl): string {
  if (control.muteUntil !== null && control.muteUntil > Date.now()) {
    return `muted until ${formatDate(control.muteUntil)}`
  }
  if (control.weight === 0) return 'muted'
  if (control.weight === 1) return 'neutral'
  const delta = Math.round((control.weight - 1) * 100)
  return `${delta > 0 ? '+' : ''}${delta}%`
}
