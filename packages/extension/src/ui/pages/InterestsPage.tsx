import { useCallback, useState } from 'react'
import type { InterestCluster } from '@ypr/shared'
import {
  forgetInterest,
  loadPreferenceContext,
  muteInterest,
  pinInterest,
  renameInterest,
  setAsOf,
  setInterestStrength,
} from '../../lib/preference.js'
import { useAsync } from '../hooks.js'

/**
 * The interest editor (design section 5.2).
 *
 * Every row here is a term in the scoring function, which is what makes the model
 * editable at all: strength, pin, mute and forget change the same numbers the ranker
 * reads. Nothing is hidden behind a "personalisation" switch.
 */
export function InterestsPage() {
  const context = useAsync(() => loadPreferenceContext(), [])
  const [busy, setBusy] = useState(false)

  const act = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true)
      try {
        await action()
        context.reload()
      } finally {
        setBusy(false)
      }
    },
    [context],
  )

  if (context.loading) return <section className="panel"><p className="muted">Rebuilding…</p></section>
  if (context.error) return <section className="panel"><p>{context.error}</p></section>

  const state = context.value!.state
  const asOf = context.value!.asOf
  const positive = state.clusters
    .filter((cluster) => cluster.massLong > 0)
    .sort((a, b) => b.activity - a.activity || b.massLong - a.massLong)
  const negative = state.clusters
    .filter((cluster) => cluster.massLong <= 0 && cluster.massNegative > 0)
    .sort((a, b) => b.massNegative - a.massNegative)

  return (
    <>
      <TimeTravel asOf={asOf} onChange={(instant) => void act(() => setAsOf(instant))} />

      <section className="panel">
        <h2>Interests</h2>
        {positive.length === 0 ? (
          <p className="muted">
            Nothing yet. Interests appear once you have rated a few videos on the Feed tab.
          </p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Interest</th>
                <th className="num">Strength</th>
                <th>State</th>
                <th>Controls</th>
              </tr>
            </thead>
            <tbody>
              {positive.map((cluster) => (
                <InterestRow key={cluster.id} cluster={cluster} busy={busy || Boolean(asOf)} act={act} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {negative.length > 0 ? (
        <section className="panel">
          <h2>Things you asked for less of</h2>
          <p className="muted small">
            These suppress similar videos. They fade more slowly than positive interests, so a
            "no more of this" keeps working for months.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Topic</th>
                <th className="num">Suppression</th>
                <th>Controls</th>
              </tr>
            </thead>
            <tbody>
              {negative.map((cluster) => (
                <tr key={cluster.id}>
                  <td>{cluster.label}</td>
                  <td className="num">{Math.round(cluster.normalisedNegative * 100)}</td>
                  <td>
                    <button
                      className="secondary"
                      disabled={busy || Boolean(asOf)}
                      onClick={() => void act(() => forgetInterest(cluster.id, true))}
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  )
}

function InterestRow({
  cluster,
  busy,
  act,
}: {
  cluster: InterestCluster
  busy: boolean
  act: (action: () => Promise<void>) => Promise<void>
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(cluster.label)

  const strength = Math.round(cluster.activity * 100)
  const state = cluster.forgotten
    ? 'Forgotten'
    : cluster.mutedUntil && Date.parse(cluster.mutedUntil) > Date.now()
      ? `Muted until ${new Date(cluster.mutedUntil).toLocaleDateString()}`
      : cluster.pinned
        ? 'Pinned'
        : cluster.normalisedShort > cluster.normalisedLong * 1.2
          ? 'Rising'
          : cluster.normalisedShort < cluster.normalisedLong * 0.4
            ? 'Fading'
            : 'Normal'

  return (
    <tr>
      <td>
        {renaming ? (
          <span className="row">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Interest name"
            />
            <button
              className="secondary"
              onClick={() =>
                void act(async () => {
                  await renameInterest(cluster.id, draft.trim() || cluster.label)
                  setRenaming(false)
                })
              }
            >
              Save
            </button>
          </span>
        ) : (
          <>
            {cluster.label}
            <div className="muted small">
              {cluster.memberIds.length} rated · {cluster.labelSource === 'user' ? 'renamed' : 'auto-named'}
            </div>
          </>
        )}
      </td>
      <td className="num">
        <div className="strength">
          <div className="strength-bar" style={{ width: `${strength}%` }} />
          <span>{strength}</span>
        </div>
      </td>
      <td className="small">{state}</td>
      <td>
        <div className="row">
          <label className="slider" title="More of this on the right, less on the left">
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={Math.round((cluster.explicitStrength ?? cluster.activity) * 100)}
              disabled={busy}
              onMouseUp={(event) =>
                void act(() =>
                  setInterestStrength(cluster.id, Number((event.target as HTMLInputElement).value) / 100),
                )
              }
            />
          </label>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(() => pinInterest(cluster.id, !cluster.pinned))}
          >
            {cluster.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(() => muteInterest(cluster.id, cluster.mutedUntil ? null : 30))}
          >
            {cluster.mutedUntil ? 'Unmute' : 'Mute 30 days'}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(() => forgetInterest(cluster.id, !cluster.forgotten))}
          >
            {cluster.forgotten ? 'Restore' : 'Forget'}
          </button>
          <button className="secondary" disabled={busy} onClick={() => setRenaming((value) => !value)}>
            Rename
          </button>
        </div>
      </td>
    </tr>
  )
}

/**
 * Replays the model at a past instant. Because the event log is append-only, this needs
 * no snapshots: the fold simply stops early (design section 3.6).
 */
function TimeTravel({ asOf, onChange }: { asOf: string | null; onChange: (instant: string | null) => void }) {
  const [date, setDate] = useState(asOf ? asOf.slice(0, 10) : '')

  return (
    <section className="panel">
      <h2>Go back to an earlier version of yourself</h2>
      {asOf ? (
        <div className="notice">
          Showing your interests as they stood on {new Date(asOf).toLocaleDateString()}. Editing is
          disabled while you are looking at the past.
        </div>
      ) : (
        <p className="muted small">
          Nothing is deleted when you rate or edit, so the model can be rebuilt at any earlier date.
        </p>
      )}
      <div className="row">
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        <button
          className="action"
          disabled={!date}
          onClick={() => onChange(new Date(`${date}T23:59:59.999Z`).toISOString())}
        >
          View that day
        </button>
        {asOf ? (
          <button className="secondary" onClick={() => onChange(null)}>
            Back to now
          </button>
        ) : null}
      </div>
    </section>
  )
}
