/**
 * Talks to the deployed catalog worker using the token in `.admin-token`.
 *
 *   node tools/admin.mjs health
 *   node tools/admin.mjs catalog [--limit 5]
 *   node tools/admin.mjs crawl
 *
 * Options:
 *   --url <origin>   target a different deployment (default: the one in the README)
 *   --token <path>   read the token from somewhere else
 *
 * The token is read from disk and sent in an Authorization header. It is never printed,
 * and it is never passed as an argument, so it does not end up in shell history or in a
 * process listing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_URL = 'https://ypr-catalog.mantaroh.workers.dev'
const DEFAULT_TOKEN_FILE = join(import.meta.dirname, '../.admin-token')

const args = process.argv.slice(2)
const command = args.find((argument) => !argument.startsWith('--')) ?? 'health'
const origin = (optionValue('--url') ?? process.env.WORKER_URL ?? DEFAULT_URL).replace(/\/$/, '')
const tokenFile = optionValue('--token') ?? process.env.ADMIN_TOKEN_FILE ?? DEFAULT_TOKEN_FILE

switch (command) {
  case 'health':
    await show(await request('GET', '/health', { authenticated: false }))
    break

  case 'catalog': {
    const limit = optionValue('--limit') ?? '5'
    const response = await request('GET', `/catalog/since?limit=${encodeURIComponent(limit)}`, {
      authenticated: false,
    })
    await show(response, summariseCatalog)
    break
  }

  case 'crawl':
    await show(await request('POST', '/admin/crawl', { authenticated: true }))
    break

  case 'strata':
    await reportStrata()
    break

  default:
    console.error(`unknown command: ${command}\nexpected one of: health, catalog, crawl`)
    process.exit(2)
}

function optionValue(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function readToken() {
  try {
    const token = readFileSync(tokenFile, 'utf8').trim()
    if (!token) throw new Error('the token file is empty')
    return token
  } catch (error) {
    console.error(
      `Could not read the admin token from ${tokenFile}\n` +
        `  ${error instanceof Error ? error.message : String(error)}\n\n` +
        'Generate one and set it on the worker with:\n' +
        '  node tools/generate-admin-token.mjs\n' +
        '  npx wrangler secret put ADMIN_TOKEN < .admin-token',
    )
    process.exit(1)
  }
}

async function request(method, path, { authenticated }) {
  const headers = { Accept: 'application/json' }
  if (authenticated) headers.Authorization = `Bearer ${readToken()}`

  const response = await fetch(`${origin}${path}`, { method, headers })
  const text = await response.text()

  if (response.status === 401) {
    console.error(
      `${response.status} unauthorized.\n` +
        'The token on disk does not match the one set on the worker. Re-set it with:\n' +
        '  npx wrangler secret put ADMIN_TOKEN < .admin-token',
    )
    process.exit(1)
  }

  return { status: response.status, text }
}

async function show({ status, text }, summarise) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    console.log(`${status}\n${text}`)
    process.exitCode = status < 400 ? 0 : 1
    return
  }

  console.log(`${status} ${origin}`)
  console.log(summarise ? summarise(body) : JSON.stringify(body, null, 2))
  process.exitCode = status < 400 ? 0 : 1
}

/**
 * How the catalog splits across the popularity strata the ranker samples from.
 *
 * This is the measurement that says whether the second crawl pass is doing its job: a
 * catalog built only from the popular chart is entirely "established", and the emerging
 * and evergreen slots the ranker reserves can never be filled from it.
 *
 * The boundaries mirror POPULARITY_BOUNDS in packages/core/src/constants.ts. They are
 * duplicated because this is a plain script with no build step; if they are changed there,
 * change them here.
 */
async function reportStrata() {
  const ESTABLISHED_VIEWS = 5000
  const EMERGING_MAX_AGE_DAYS = 90

  const counts = { established: 0, emerging: 0, wildcard: 0 }
  let cursor
  let pages = 0
  const now = Date.now()

  while (pages < 50) {
    const query = new URLSearchParams({ limit: '500' })
    if (cursor) {
      query.set('updatedAt', cursor.updatedAt)
      query.set('externalId', cursor.externalId)
    }
    const { status, text } = await request('GET', `/catalog/since?${query}`, { authenticated: false })
    if (status >= 400) {
      console.error(`${status} ${text}`)
      process.exitCode = 1
      return
    }

    const page = JSON.parse(text)
    for (const item of page.items ?? []) {
      const ageDays = (now - Date.parse(item.publishedAt)) / 86_400_000
      if (item.viewCount >= ESTABLISHED_VIEWS) counts.established += 1
      else if (ageDays <= EMERGING_MAX_AGE_DAYS) counts.emerging += 1
      else counts.wildcard += 1
    }

    pages += 1
    cursor = page.cursor
    if (!page.hasMore) break
  }

  const total = counts.established + counts.emerging + counts.wildcard
  console.log(`${total} item(s) across ${pages} page(s)`)
  for (const [tier, count] of Object.entries(counts)) {
    const share = total === 0 ? 0 : Math.round((count / total) * 100)
    console.log(`  ${tier.padEnd(12)} ${String(count).padStart(5)}  ${share}%`)
  }
}

function summariseCatalog(body) {
  const items = body.items ?? []
  const lines = items.map(
    (item) => `  ${item.externalId}  ${item.channelTitle} — ${item.title}`.slice(0, 110),
  )
  return [`${items.length} item(s), hasMore=${body.hasMore}`, ...lines].join('\n')
}
