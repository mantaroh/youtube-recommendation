/**
 * Watch detection on youtube.com.
 *
 * The Data API does not expose watch history, so "already seen" would otherwise be
 * guesswork (design section 11). Observing the page the user is already on closes that
 * gap without any extra API call.
 *
 * This script only reads: it never modifies YouTube's interface (design section 5.3).
 * The event it produces is weighted 0 in V1; it is recorded now so that enabling the
 * implicit signal later applies to history that already exists (design section 2.2).
 */

const REPORT_INTERVAL_MS = 15_000
/** Ignore glances: below this there is no signal worth recording. */
const MIN_WATCHED_SECONDS = 10

export default defineContentScript({
  matches: ['https://www.youtube.com/watch*'],
  runAt: 'document_idle',

  main() {
    let reportedFor: string | undefined
    let lastReportedSeconds = 0

    const report = () => {
      const videoId = currentVideoId()
      if (!videoId) return
      const video = document.querySelector('video')
      if (!video) return

      const watchedSeconds = Math.floor(video.currentTime)
      const durationSeconds = Math.floor(video.duration)
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
      if (watchedSeconds < MIN_WATCHED_SECONDS) return
      // Nothing new since the last report, so there is nothing to say.
      if (videoId === reportedFor && watchedSeconds <= lastReportedSeconds) return

      reportedFor = videoId
      lastReportedSeconds = watchedSeconds

      void browser.runtime
        .sendMessage({ type: 'watch-progress', videoId, watchedSeconds, durationSeconds })
        .catch(() => {
          // The background worker may be asleep or the extension reloading; the next tick
          // will report again, so a failure here needs no handling.
        })
    }

    const timer = setInterval(report, REPORT_INTERVAL_MS)
    window.addEventListener('pagehide', report)
    // YouTube navigates without a full page load, so the id has to be re-read.
    window.addEventListener('yt-navigate-finish', () => {
      reportedFor = undefined
      lastReportedSeconds = 0
    })

    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', report)
    }
  },
})

function currentVideoId(): string | undefined {
  return new URL(window.location.href).searchParams.get('v') ?? undefined
}
