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

function summariseCatalog(body) {
  const items = body.items ?? []
  const lines = items.map(
    (item) => `  ${item.externalId}  ${item.channelTitle} — ${item.title}`.slice(0, 110),
  )
  return [`${items.length} item(s), hasMore=${body.hasMore}`, ...lines].join('\n')
}
