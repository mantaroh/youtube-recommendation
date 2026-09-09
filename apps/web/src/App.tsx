import { useCallback, useEffect, useState } from 'react'
import { videoPath } from './domain/reasons.js'
import { HomePage } from './pages/HomePage.js'
import { PreferencesPage } from './pages/PreferencesPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { VideoPage } from './pages/VideoPage.js'

/**
 * Routing.
 *
 * Four screens and one parameter do not need a routing library. The History API gives
 * working back and forward buttons and shareable URLs, which is the whole of what a
 * router would have been imported for.
 */

type Route =
  | { name: 'home' }
  | { name: 'video'; videoId: string }
  | { name: 'preferences' }
  | { name: 'settings' }

function parse(pathname: string): Route {
  if (pathname.startsWith('/video/')) {
    return { name: 'video', videoId: decodeURIComponent(pathname.slice('/video/'.length)) }
  }
  if (pathname.startsWith('/preferences')) return { name: 'preferences' }
  if (pathname.startsWith('/settings')) return { name: 'settings' }
  return { name: 'home' }
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname))

  useEffect(() => {
    // The browser restores the scroll position on a back navigation by itself, and it
    // does so *after* the page has re-rendered — overwriting the position the feed just
    // restored, with one measured before the feed had been laid out. Only one of the
    // two can be in charge; the feed knows which list it is showing, so it is.
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'

    const onPop = () => setRoute(parse(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => {
      window.history.scrollRestoration = previous
      window.removeEventListener('popstate', onPop)
    }
  }, [])

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path)
    setRoute(parse(path))
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className={route.name === 'video' ? 'app is-watching' : 'app'}>
      <header className="topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}>
          Personal Recommender
        </button>
        <nav className="topnav">
          <button type="button" className={route.name === 'home' ? 'is-active' : ''} onClick={() => navigate('/')}>
            Feed
          </button>
          <button
            type="button"
            className={route.name === 'preferences' ? 'is-active' : ''}
            onClick={() => navigate('/preferences')}
          >
            Preferences
          </button>
          <button
            type="button"
            className={route.name === 'settings' ? 'is-active' : ''}
            onClick={() => navigate('/settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      <main>
        {route.name === 'home' && <HomePage onOpen={(id) => navigate(videoPath(id))} />}
        {route.name === 'video' && (
          <VideoPage
            videoId={route.videoId}
            onBack={() => navigate('/')}
            onOpen={(id) => navigate(videoPath(id))}
          />
        )}
        {route.name === 'preferences' && <PreferencesPage />}
        {route.name === 'settings' && <SettingsPage />}
      </main>

      <footer className="footer">
        Your ratings are the record. The model is rebuilt from them, never the other way round.
      </footer>
    </div>
  )
}
