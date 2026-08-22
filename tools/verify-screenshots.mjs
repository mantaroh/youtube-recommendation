/**
 * Loads the built extension into a real browser, drives it, and saves screenshots.
 *
 * Unit tests say the preference model is right; this says the thing actually runs — the
 * store opens, the embedding backend resolves, the feed ranks and paints. The two answer
 * different questions and neither replaces the other.
 *
 *   node tools/verify-screenshots.mjs [--headed]
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ROOT = join(import.meta.dirname, '..')
const EXTENSION = join(ROOT, 'packages/extension/.output/chrome-mv3')
const OUTPUT = join(ROOT, 'docs/verification')
const PROFILE = join(ROOT, 'node_modules/.verify-profile')

const headed = process.argv.includes('--headed')

mkdirSync(OUTPUT, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: !headed,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
})

try {
  const extensionId = await resolveExtensionId(context)
  console.log(`extension id: ${extensionId}`)

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto(`chrome-extension://${extensionId}/dashboard.html`)
  await page.waitForLoadState('domcontentloaded')

  // Status first: this is where ingestion is triggered from.
  await page.getByRole('tab', { name: 'Status' }).click()
  await page.screenshot({ path: join(OUTPUT, '1-status-empty.png'), fullPage: true })

  console.log('running ingestion (the embedding model is fetched on first run)…')
  await page.getByRole('button', { name: /Fetch and embed now/i }).click()
  await page.waitForFunction(
    () => document.body.innerText.includes('Finished') || document.body.innerText.includes('Failed'),
    undefined,
    { timeout: 15 * 60 * 1000 },
  )
  await page.screenshot({ path: join(OUTPUT, '2-status-after-ingest.png'), fullPage: true })

  const engineLine = await page.locator('.panel', { hasText: 'Embedding model' }).innerText()
  console.log(engineLine.split('\n').slice(0, 3).join(' | '))

  // Rate a few videos so the model has something to build interests from.
  await page.getByRole('tab', { name: 'Feed' }).click()
  await page.waitForSelector('.card', { timeout: 60_000 })
  await page.screenshot({ path: join(OUTPUT, '3-feed-before-rating.png'), fullPage: true })

  const cards = page.locator('.card')
  const cardCount = await cards.count()
  console.log(`feed cards after ingestion: ${cardCount}`)
  // Rate some but not all: rating everything empties the candidate pool, which is a real
  // state but not the one worth showing here.
  const toRate = Math.min(3, cardCount)
  for (let index = 0; index < toRate; index++) {
    const stars = cards.nth(index).locator('button.star')
    await stars.nth(index % 2 === 0 ? 4 : 3).click()
  }

  // Now that interests exist, look for videos outside the subscription lane.
  await page.getByRole('tab', { name: 'Status' }).click()
  await page.getByRole('button', { name: /Look for unfamiliar videos/i }).click()
  await page.waitForFunction(
    () => document.body.innerText.includes('queries ·') || document.body.innerText.includes('Failed'),
    undefined,
    { timeout: 10 * 60 * 1000 },
  )
  await page.screenshot({ path: join(OUTPUT, '3b-status-after-discovery.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Feed' }).click()
  await page.getByRole('button', { name: 'Rebuild feed' }).click()
  await page.waitForTimeout(3000)
  console.log(`feed cards after discovery: ${await cards.count()}`)
  await page.screenshot({ path: join(OUTPUT, '4-feed-ranked.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Interests' }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(OUTPUT, '5-interests.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Evaluation' }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /Record today's feed/i }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(OUTPUT, '6-evaluation.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUTPUT, '7-settings.png'), fullPage: true })

  if (errors.length > 0) {
    console.log(`\npage errors (${errors.length}):`)
    for (const error of errors.slice(0, 20)) console.log(`  ${error}`)
    process.exitCode = 1
  } else {
    console.log('\nno page errors')
  }
} finally {
  await context.close()
}

async function resolveExtensionId(context) {
  const existing = context.serviceWorkers()[0]
  const worker = existing ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }))
  return new URL(worker.url()).host
}
