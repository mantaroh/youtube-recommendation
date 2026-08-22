import { useCallback, useEffect, useState } from 'react'
import {
  getAccessToken,
  getCredentials,
  getRedirectUri,
  isSignedIn,
  setCredentials,
  signOut,
} from '../../lib/sources/youtube/auth.js'
import { getCatalogEndpoint, setCatalogEndpoint } from '../../lib/sources/sharedCatalog.js'
import { useAsync } from '../hooks.js'

/**
 * Credentials and account connection.
 *
 * The client id and API key are stored locally and used only to talk to Google. There is
 * no server of ours in this path at all (design section 1).
 */
export function SettingsPage() {
  const stored = useAsync(getCredentials, [])
  const signedIn = useAsync(isSignedIn, [])
  const [clientId, setClientId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!stored.value) return
    setClientId(stored.value.clientId)
    setApiKey(stored.value.apiKey)
  }, [stored.value])

  const save = useCallback(async () => {
    await setCredentials({ clientId: clientId.trim(), apiKey: apiKey.trim() })
    setMessage('Saved.')
    stored.reload()
  }, [clientId, apiKey, stored])

  const connect = useCallback(async () => {
    setBusy(true)
    setMessage(undefined)
    try {
      await getAccessToken({ interactive: true })
      setMessage('Connected.')
      signedIn.reload()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [signedIn])

  const disconnect = useCallback(async () => {
    await signOut()
    setMessage('Disconnected. The stored token was discarded.')
    signedIn.reload()
  }, [signedIn])

  const redirectUri = safeRedirectUri()

  return (
    <>
      <section className="panel">
        <h2>YouTube account</h2>
        <p>
          Status:{' '}
          {signedIn.value ? (
            <span className="badge live">connected</span>
          ) : (
            <span className="badge fixture">not connected</span>
          )}
        </p>
        <div className="row">
          <button className="action" onClick={connect} disabled={busy}>
            {busy ? 'Waiting for Google…' : 'Connect'}
          </button>
          <button className="secondary" onClick={disconnect}>
            Disconnect
          </button>
        </div>
        {message ? <div className="notice">{message}</div> : null}
      </section>

      <section className="panel">
        <h2>Credentials</h2>
        <p className="muted small">
          Create an OAuth client and an API key in a Google Cloud project with the YouTube Data API
          v3 enabled, then paste them here. They are stored on this machine only.
        </p>
        <label className="field">
          <span>OAuth client id</span>
          <input
            type="text"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
          />
        </label>
        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="AIza…"
          />
        </label>
        <button className="action" onClick={save}>
          Save
        </button>
      </section>

      <SharedCatalogSettings />

      <section className="panel">
        <h2>Redirect URI to register</h2>
        <p className="muted small">
          Add this exact value to the OAuth client's authorised redirect URIs. It differs per
          browser and per installation.
        </p>
        <pre className="log">{redirectUri}</pre>
      </section>
    </>
  )
}

/**
 * The shared catalog is optional. It answers "what videos exist" and is never told who is
 * asking or what they like (design section 1.1).
 */
function SharedCatalogSettings() {
  const stored = useAsync(getCatalogEndpoint, [])
  const [endpoint, setEndpoint] = useState('')
  const [message, setMessage] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (stored.value !== undefined) setEndpoint(stored.value)
  }, [stored.value])

  return (
    <section className="panel">
      <h2>Shared catalog (optional)</h2>
      <p className="muted small">
        A catalog service saves every installation from crawling the same public videos. Requests to
        it carry a paging cursor and nothing else — no interests, no ratings, no identifier. Leave it
        empty to work only from your subscriptions and your own searches.
      </p>
      <label className="field">
        <span>Endpoint</span>
        <input
          type="text"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://ypr-catalog.example.workers.dev"
        />
      </label>
      <button
        className="action"
        onClick={() =>
          void setCatalogEndpoint(endpoint.trim()).then(() => {
            setMessage(endpoint.trim() ? 'Saved. The next fetch will sync from it.' : 'Disabled.')
            stored.reload()
          })
        }
      >
        Save
      </button>
      {message ? <div className="notice">{message}</div> : null}
    </section>
  )
}

function safeRedirectUri(): string {
  try {
    return getRedirectUri()
  } catch {
    return 'Unavailable outside the extension.'
  }
}
