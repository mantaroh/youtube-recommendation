import { useState } from 'react'
import { FeedPage } from './pages/FeedPage.js'
import { InterestsPage } from './pages/InterestsPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { StatusPage } from './pages/StatusPage.js'

const TABS = [
  { id: 'feed', label: 'Feed' },
  { id: 'interests', label: 'Interests' },
  { id: 'settings', label: 'Settings' },
  { id: 'status', label: 'Status' },
] as const

type TabId = (typeof TABS)[number]['id']

export function App() {
  const [tab, setTab] = useState<TabId>('feed')

  return (
    <div className="shell">
      <header className="masthead">
        <h1>My feed</h1>
        <span className="subtitle">
          Ratings, interests and ranking stay on this machine.
        </span>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'status' ? <StatusPage /> : null}
      {tab === 'feed' ? <FeedPage /> : null}
      {tab === 'interests' ? <InterestsPage /> : null}
      {tab === 'settings' ? <SettingsPage /> : null}
    </div>
  )
}

