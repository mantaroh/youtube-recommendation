import type { ItemRef, Source } from './types.js'

/**
 * Row ids are `source:externalId` rather than an opaque uuid.
 *
 * Two sources can use the same external id, and a generated id would need a lookup on
 * every ingest to find out whether a video is already known. A composite key answers
 * that from the id itself, which is what makes an upsert one statement.
 */
export function itemKey(ref: ItemRef): string {
  return `${ref.source}:${ref.externalId}`
}

export function parseItemKey(key: string): ItemRef {
  const separator = key.indexOf(':')
  if (separator === -1) throw new Error(`malformed item key: ${key}`)
  const source = key.slice(0, separator)
  const externalId = key.slice(separator + 1)
  if (!source || !externalId) throw new Error(`malformed item key: ${key}`)
  return { source: source as Source, externalId }
}

/** `model-12`. The GPU side stores versions under this name, so the format is load-bearing. */
export function modelVersionName(version: number): string {
  return `model-${version}`
}

export function parseModelVersionName(name: string): number {
  const match = /^model-(\d+)$/.exec(name)
  if (!match) throw new Error(`malformed model version: ${name}`)
  return Number(match[1])
}
