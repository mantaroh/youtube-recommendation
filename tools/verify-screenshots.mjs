/**
 * Starts the application, drives it in a real browser, and saves screenshots.
 *
 * Unit tests say the ranking is right; this says the thing actually runs — the Worker
 * serves the SPA, the API answers, a rating reaches D1 and the feed re-ranks. The two
 * answer different questions and neither replaces the other.
 *
 *   node tools/verify-screenshots.mjs [--headed] [--keep]
 *
 * Nothing here talks to YouTube, Runpod or Cloudflare. The catalog is seeded straight
 * into the local D1, so the run needs no credentials and spends no quota.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ROOT = join(import.meta.dirname, '..')
const APP = join(ROOT, 'apps/web')
const OUTPUT = join(ROOT, 'docs/verification')
const PORT = 8788
const ORIGIN = `http://127.0.0.1:${PORT}`

const headed = process.argv.includes('--headed')
const keep = process.argv.includes('--keep')

mkdirSync(OUTPUT, { recursive: true })

const notes = []
let server

try {
  await seedCatalog()

  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--local'],
    { cwd: APP, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  server.stdout.on('data', (chunk) => process.env.VERBOSE && process.stdout.write(chunk))
  server.stderr.on('data', (chunk) => process.env.VERBOSE && process.stderr.write(chunk))

  await waitForServer()

  const browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.card', { timeout: 15_000 })
  await shot(page, '1-feed', 'The feed, ranked without a trained model: every candidate scores at the pool mean, so ordering falls to the bonuses.')

  const firstTitle = await page.locator('.card-title').first().innerText()

  // Rate the first card four stars. The control asks how much more of this the user
  // wants, not whether the video was good.
  await page.locator('.card').first().locator('.rating-star').nth(4).click()
  await page.waitForTimeout(500)
  await shot(page, '2-rated', `Rated "${firstTitle}" four out of five. The card updates in place rather than re-ranking under the cursor.`)

  await page.locator('.tab', { hasText: 'Subscriptions' }).click()
  await page.waitForTimeout(800)
  await shot(page, '3-subscriptions', 'The subscription lane on its own. Filtering to a lane must not borrow from the others.')

  await page.goto(`${ORIGIN}/preferences`, { waitUntil: 'networkidle' })
  await page.fill('.add-interest input', 'kernel')
  await page.click('.add-interest button')
  await page.waitForTimeout(500)
  await shot(page, '4-preferences', 'An interest control. It applies when the feed is built, so it takes effect on the next refresh rather than the next training run.')

  await page.goto(`${ORIGIN}/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await shot(page, '5-settings', 'What is configured and what is not. Runpod and Access are absent in a local run, and the screen says so rather than failing.')

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.card')
  const opened = await page.locator('.card-title button').first().innerText()
  await page.locator('.card-title button').first().click()
  await page.waitForSelector('.player', { timeout: 10_000 })
  await shot(page, '6-video', `"${opened}" with the YouTube player, the rating question and the reasons the score was what it was.`)

  await browser.close()
  writeFileSync(join(OUTPUT, 'RUN.md'), report(), 'utf8')
  console.log(`\nWrote ${notes.length} screenshots to docs/verification`)
} finally {
  if (server && !keep) stop(server)
}

/**
 * Stop `wrangler dev` and everything it started.
 *
 * `shell: true` means the child is a shell, not the worker process, so killing it on
 * Windows leaves wrangler running and holding the port. `taskkill /T` takes the tree.
 */
function stop(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill()
  }
  // The screenshots are written; nothing is waiting on anything. Without this the
  // process lingers on the pipes the child left behind.
  setTimeout(() => process.exit(0), 1_000).unref()
}

async function shot(page, name, note) {
  await page.screenshot({ path: join(OUTPUT, `${name}.png`), fullPage: false })
  notes.push({ name, note })
  console.log(`  ${name}: ${note}`)
}

/**
 * Put a catalog in the local D1 directly.
 *
 * Crawling YouTube for a screenshot run would spend real quota and make the output
 * depend on what happened to be popular that day, which is the opposite of what a
 * verification record is for.
 */
async function seedCatalog() {
  const now = Date.now()
  const rows = [
    ['UClinux', 'Kernel Corner', 1, 'Inside the Linux scheduler', 'How CFS decides what runs next.', ['linux', 'kernel']],
    ['UClinux', 'Kernel Corner', 1, 'Page cache, end to end', 'What happens between read() and the disk.', ['linux', 'kernel']],
    ['UCbrowser', 'Engine Room', 1, 'How Firefox paints a frame', 'From style to composited pixels.', ['firefox', 'browser']],
    ['UCbrowser', 'Engine Room', 1, 'The event loop, honestly', 'Tasks, microtasks and the parts people skip.', ['browser']],
    ['UCarch', 'Silicon Notes', 0, 'A history of the CPU cache', 'Why the hierarchy looks the way it does.', ['cpu', 'hardware']],
    ['UCarch', 'Silicon Notes', 0, 'Out-of-order execution explained', 'Reorder buffers without the hand-waving.', ['cpu']],
    ['UCdb', 'Row by Row', 0, 'SQLite internals', 'B-trees, pages and the write-ahead log.', ['database', 'sqlite']],
    ['UCmisc', 'Long Reads', 0, 'The design of Unix pipes', 'One idea, forty years of consequences.', ['unix']],
  ]

  const statements = [
    `INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('default', 'default', ${now});`,
  ]

  rows.forEach(([channelId, channelTitle, subscribed, title, description, tags], index) => {
    const videoId = `demo${index}`
    const published = now - index * 86_400_000
    statements.push(
      `INSERT OR REPLACE INTO channels (id, source, external_id, title, thumbnail_url, subscribed, last_fetched_at)` +
        ` VALUES ('youtube:${channelId}', 'youtube', '${channelId}', ${quote(channelTitle)}, NULL, ${subscribed}, ${now});`,
    )
    statements.push(
      `INSERT OR REPLACE INTO videos (id, source, external_id, channel_id, title, description, thumbnail_url,` +
        ` published_at, duration_seconds, view_count, metadata_json, discovered_at, refreshed_at)` +
        ` VALUES ('youtube:${videoId}', 'youtube', '${videoId}', 'youtube:${channelId}', ${quote(title)},` +
        ` ${quote(description)}, NULL, ${published}, ${600 + index * 60}, ${1000 * (index + 1)},` +
        ` ${quote(JSON.stringify({ tags, channelTitle }))}, ${now}, ${now});`,
    )
  })

  // Written to a file rather than passed as `--command`: a statement list this long
  // on one command line is past what a Windows shell will carry.
  const seedFile = join(APP, '.wrangler', 'seed.sql')
  mkdirSync(join(APP, '.wrangler'), { recursive: true })
  writeFileSync(seedFile, statements.join('\n'), 'utf8')

  await run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'catalog', '--local'])
  await run('npx', ['wrangler', 'd1', 'execute', 'catalog', '--local', '--file', seedFile])
  console.log(`seeded ${rows.length} videos into the local database`)
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: APP, shell: true, stdio: 'ignore' })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
    child.on('error', reject)
  })
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('the worker did not start within a minute')
}

function report() {
  const stamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  return [
    '# Verification run',
    '',
    `Recorded ${stamp} JST by \`node tools/verify-screenshots.mjs\`, against \`wrangler dev --local\``,
    'with a seeded catalog and no external credentials.',
    '',
    ...notes.flatMap(({ name, note }) => [`## ${name}`, '', note, '', `![${name}](${name}.png)`, '']),
  ].join('\n')
}
