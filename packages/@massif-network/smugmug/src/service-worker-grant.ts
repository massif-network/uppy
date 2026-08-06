/**
 * Ephemeral credential grant the page posts to the upload Service Worker
 * immediately before a slice (master plan §7.4). Mirrors Massif's
 * `CredentialGrant` wire shape without importing it, since this package
 * must stay independent of the Massif app.
 */
export type ServiceWorkerGrant = {
  grantId: string
  provider: 'smugmug'
  companionOrigin: string
  headers: Record<string, string>
  issuedAt: number
  expiresAt: number
}

/** Only these headers are ever forwarded — never Cookie/Authorization/etc. */
const FORWARDABLE_HEADERS = ['uppy-auth-token', 'uppy-credentials-params']

/** Grant lifetime: long enough for one slice's network calls, no longer. */
const GRANT_TTL_MS = 5 * 60 * 1000

export function buildServiceWorkerGrant(
  companionUrl: string,
  headers: Record<string, string>,
  now: number,
): ServiceWorkerGrant {
  const forwarded: Record<string, string> = {}
  for (const name of FORWARDABLE_HEADERS) {
    const value = headers[name]
    if (value != null) forwarded[name] = value
  }
  return {
    grantId: `smugmug-${now}-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'smugmug',
    companionOrigin: new URL(companionUrl).origin,
    headers: forwarded,
    issuedAt: now,
    expiresAt: now + GRANT_TTL_MS,
  }
}
