import { PreferenceDatabase, setDb } from '../src/lib/db.js'

let counter = 0

/** A fresh, isolated database per test, so nothing leaks between cases. */
export function useFreshDb(): PreferenceDatabase {
  const db = new PreferenceDatabase(`test-store-${counter++}`)
  setDb(db)
  return db
}
