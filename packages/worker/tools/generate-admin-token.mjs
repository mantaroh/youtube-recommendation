/**
 * Generates the admin token and writes it to `.admin-token`.
 *
 *   node tools/generate-admin-token.mjs [--force]
 *
 * The value is never printed. Cloudflare cannot read a secret back once it is set, so
 * this file is the only copy: regenerating it means the deployed worker has to be
 * updated too, which is why an existing file is not overwritten without --force.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const target = join(import.meta.dirname, '../.admin-token')
const force = process.argv.includes('--force')

if (existsSync(target) && !force) {
  console.error(
    'A token already exists at packages/worker/.admin-token.\n' +
      'Pass --force to replace it, then set the new value on the worker with:\n' +
      '  npx wrangler secret put ADMIN_TOKEN < .admin-token',
  )
  process.exit(1)
}

// 32 bytes of randomness, url-safe so it can be pasted anywhere without escaping.
const token = randomBytes(32).toString('base64url')

// No trailing newline: the file is piped straight into `wrangler secret put`, which takes
// the whole of stdin as the value.
writeFileSync(target, token, { encoding: 'utf8', mode: 0o600 })

console.log(`wrote ${token.length} characters to packages/worker/.admin-token`)
console.log('set it on the worker with:  npx wrangler secret put ADMIN_TOKEN < .admin-token')
