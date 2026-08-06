import type { AsyncStore } from '@uppy/core'

/**
 * In-memory replacement for the default `tokenStorage` (localStorage). A
 * Service Worker cannot read localStorage, and the encrypted Companion
 * token must not persist across page reloads on this path — the SW is
 * supplied an ephemeral grant per slice instead (see `getServiceWorkerGrant`
 * in `SmugMug.tsx`). Losing the token on reload just re-triggers OAuth.
 */
export function createMemoryStore(): AsyncStore {
  const values = new Map<string, string>()
  return {
    async getItem(key) {
      return values.get(key) ?? null
    },
    async setItem(key, value) {
      values.set(key, value)
    },
    async removeItem(key) {
      values.delete(key)
    },
  }
}
