/**
 * Copies the ONNX runtime WebAssembly files into the extension's public directory.
 *
 * Transformers.js otherwise fetches them from a CDN at run time, which an MV3 extension
 * cannot do: `script-src 'self'` blocks the loader outright, and the embedding backend
 * silently falls back to the lexical one. Shipping the files inside the extension is the
 * only way the real sentence encoder can run here.
 *
 * They are copied rather than committed: together they are far larger than anything that
 * belongs in a repository, and they are reproducible from the lockfile.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const target = join(import.meta.dirname, '../src/public/ort')

// onnxruntime-web is a dependency of transformers rather than of this package, and pnpm
// keeps that strict, so it is resolved from there rather than from here.
const transformers = require.resolve('@huggingface/transformers')
const distributionDirectory = dirname(createRequire(transformers).resolve('onnxruntime-web'))
const files = readdirSync(distributionDirectory).filter((name) => name.startsWith('ort-wasm'))

if (files.length === 0) {
  console.error(`no ort-wasm files found in ${distributionDirectory}`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })

let copied = 0
let skipped = 0
for (const name of files) {
  const from = join(distributionDirectory, name)
  const to = join(target, name)
  // Skip files already in place: these are tens of megabytes and every build would
  // otherwise pay for the copy.
  if (isUpToDate(from, to)) {
    skipped += 1
    continue
  }
  copyFileSync(from, to)
  copied += 1
}

console.log(`onnx runtime: ${copied} copied, ${skipped} already current -> src/public/ort`)

function isUpToDate(from, to) {
  try {
    const source = statSync(from)
    const destination = statSync(to)
    return destination.size === source.size && destination.mtimeMs >= source.mtimeMs
  } catch {
    return false
  }
}
