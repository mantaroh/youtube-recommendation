import type { ItemRef, Source } from './types.js'

/**
 * Stable string key for an item. Used as the primary key everywhere a Map or a Set is
 * keyed by content, so that two sources can never collide on the same external id.
 */
export function itemKey(ref: ItemRef): string {
  return `${ref.source}:${ref.externalId}`
}

export function parseItemKey(key: string): ItemRef {
  const separator = key.indexOf(':')
  if (separator === -1) throw new Error(`malformed item key: ${key}`)
  return {
    source: key.slice(0, separator) as Source,
    externalId: key.slice(separator + 1),
  }
}
