import Dexie, { type Table } from 'dexie'
import type {
  AppEvent,
  CatalogItem,
  InterestCluster,
  ItemRef,
  NewEvent,
  PreferenceState,
  RatingRecord,
} from '@ypr/shared'

/**
 * Local store (design section 2.4).
 *
 * `events` is the source of truth and is only ever appended to. `ratings`, `clusters`
 * and `snapshots` are derived: deleting them loses nothing, because they can be rebuilt
 * from `events` + `items` + `embeddings`.
 */

export interface EmbeddingRow extends ItemRef {
  modelId: string
  generatedAt: string
  vector: Float32Array
}

export interface SnapshotRow {
  atSeq: number
  createdAt: string
  state: PreferenceState
}

export interface SettingRow {
  key: string
  value: unknown
}

/** Channels the user subscribes to, cached so the feed works without a network round trip. */
export interface ChannelRow {
  channelId: string
  title: string
  uploadsPlaylistId: string
  subscribed: boolean
  fetchedAt: string
}

/** Compound primary key shared by every content-keyed table. */
export type ItemPrimaryKey = [string, string]

export function primaryKeyOf(ref: ItemRef): ItemPrimaryKey {
  return [ref.source, ref.externalId]
}

export class PreferenceDatabase extends Dexie {
  /** Append-only. `seq` is assigned by Dexie, so inserts carry no `seq`. */
  events!: Table<AppEvent, number, NewEvent>
  items!: Table<CatalogItem, ItemPrimaryKey>
  embeddings!: Table<EmbeddingRow, ItemPrimaryKey>
  ratings!: Table<RatingRecord, ItemPrimaryKey>
  clusters!: Table<InterestCluster, string>
  snapshots!: Table<SnapshotRow, number>
  settings!: Table<SettingRow, string>
  channels!: Table<ChannelRow, string>

  constructor(name = 'preference-store') {
    super(name)
    this.version(1).stores({
      events: '++seq, ts, type, [source+externalId]',
      items: '[source+externalId], channelId, publishedAt, expiresAt',
      embeddings: '[source+externalId], modelId',
      ratings: '[source+externalId], ratedAt',
      clusters: 'id, updatedAt',
      snapshots: 'atSeq',
      settings: 'key',
      channels: 'channelId, subscribed',
    })
  }
}

let instance: PreferenceDatabase | undefined

export function getDb(): PreferenceDatabase {
  if (!instance) instance = new PreferenceDatabase()
  return instance
}

/** Test seam: swap in a database backed by a fake IndexedDB. */
export function setDb(db: PreferenceDatabase | undefined): void {
  instance = db
}
