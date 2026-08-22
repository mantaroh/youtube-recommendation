import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * A D1 stand-in backed by SQLite.
 *
 * The queries this worker runs are the interesting part — upsert-on-conflict, keyset
 * pagination, TTL deletion — so the tests execute real SQL against the real migration
 * rather than asserting against a hand-written mock that would happily agree with a
 * broken query.
 */

// `import.meta.dirname` avoids the URL type, which the workers runtime also defines.
const MIGRATION = join(import.meta.dirname, '../migrations/0001_catalog.sql')

export function createTestDatabase(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(MIGRATION, 'utf8'))
  return wrap(sqlite)
}

function wrap(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string): D1PreparedStatement => statementFor(sqlite, sql, [])

  return {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec('BEGIN')
      try {
        const results: D1Result<T>[] = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql)
      return { count: 0, duration: 0 }
    },
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('sessions are not used by this worker')
    },
  } as unknown as D1Database
}

function statementFor(sqlite: DatabaseSync, sql: string, bound: unknown[]): D1PreparedStatement {
  const run = () => {
    const statement = sqlite.prepare(sql)
    const result = statement.run(...(bound as never[]))
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes ?? 0), last_row_id: Number(result.lastInsertRowid ?? 0) },
    }
  }

  return {
    bind: (...args: unknown[]) => statementFor(sqlite, sql, args),
    async all<T = unknown>() {
      const statement = sqlite.prepare(sql)
      const rows = statement.all(...(bound as never[])) as T[]
      return { success: true, results: rows, meta: {} }
    },
    async first<T = unknown>(column?: string) {
      const statement = sqlite.prepare(sql)
      const row = statement.get(...(bound as never[])) as Record<string, unknown> | undefined
      if (!row) return null
      return (column ? row[column] : row) as T
    },
    async run() {
      return run()
    },
    async raw() {
      const statement = sqlite.prepare(sql)
      const rows = statement.all(...(bound as never[])) as Record<string, unknown>[]
      return rows.map((row) => Object.values(row))
    },
  } as unknown as D1PreparedStatement
}
