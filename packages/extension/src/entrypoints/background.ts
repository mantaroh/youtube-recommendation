/**
 * Background service worker.
 *
 * It deliberately does very little: it opens the dashboard and marks when a refresh is
 * due. The ingestion run itself happens in the dashboard page, because embedding a batch
 * outlives the idle timeout an MV3 service worker gets and needs a GPU context the worker
 * does not have.
 */

const REFRESH_ALARM = 'refresh-due'
const REFRESH_PERIOD_MINUTES = 6 * 60

export default defineBackground(() => {
  browser.action.onClicked.addListener(() => {
    void openDashboard()
  })

  browser.runtime.onInstalled.addListener(() => {
    void browser.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MINUTES })
    void openDashboard()
  })

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== REFRESH_ALARM) return
    // A dot on the icon, not a notification: nothing here should interrupt.
    void browser.action.setBadgeText({ text: '•' })
    void browser.action.setTitle({ title: 'Open my feed — a refresh is due' })
  })

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (isMessage(message, 'ingestion-finished')) {
      void browser.action.setBadgeText({ text: '' })
      void browser.action.setTitle({ title: 'Open my feed' })
    }
    return undefined
  })
})

async function openDashboard(): Promise<void> {
  const url = browser.runtime.getURL('/dashboard.html')
  const [existing] = await browser.tabs.query({ url })
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true })
    return
  }
  await browser.tabs.create({ url })
}

function isMessage(message: unknown, type: string): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: string }).type === type
}
