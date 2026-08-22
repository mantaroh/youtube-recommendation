/**
 * Records what YouTube's own home page recommended, as the comparison arm of the
 * experiment (design section 9).
 *
 * This reads the page and changes nothing on it. Only video ids are taken; the metadata
 * is fetched later through the API, on request, so a visit to the home page never causes
 * a surprise API call.
 */

const ITEMS_PER_TRIAL = 10
/** Give the home grid time to render before reading it. */
const SETTLE_MS = 3000

export default defineContentScript({
  matches: ['https://www.youtube.com/', 'https://www.youtube.com/?*'],
  runAt: 'document_idle',

  main() {
    const timer = setTimeout(() => {
      const videoIds = topVideoIds(ITEMS_PER_TRIAL)
      if (videoIds.length === 0) return
      void browser.runtime.sendMessage({ type: 'home-feed', videoIds }).catch(() => {
        // The worker may be asleep; the next visit records instead.
      })
    }, SETTLE_MS)

    return () => clearTimeout(timer)
  },
})

function topVideoIds(limit: number): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="/watch?v="]')) {
    const videoId = new URL(anchor.href, window.location.origin).searchParams.get('v')
    if (!videoId || seen.has(videoId)) continue
    seen.add(videoId)
    ids.push(videoId)
    if (ids.length >= limit) break
  }

  return ids
}
