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
const FORWARDABLE_HEADERS = new Set([
  'uppy-auth-token',
  'uppy-credentials-params',
])

/** Grant lifetime: long enough for one slice's network calls, no longer. */
const GRANT_TTL_MS = 5 * 60 * 1000

export function buildServiceWorkerGrant(
  companionUrl: string,
  headers: Record<string, string>,
  now: number,
): ServiceWorkerGrant {
  if (typeof companionUrl !== 'string') {
    throw new Error('SmugMug companion origin URL is invalid')
  }

  let companionOrigin: string
  try {
    const url = new URL(companionUrl)
    if (
      url.protocol !== 'https:' ||
      url.origin === 'null' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error('companion origin must be HTTPS')
    }
    companionOrigin = url.origin
  } catch {
    throw new Error('SmugMug companion origin must be a valid HTTPS URL')
  }

  if (headers == null || typeof headers !== 'object') {
    throw new Error('SmugMug grant headers must be an object')
  }

  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!FORWARDABLE_HEADERS.has(name)) continue
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`SmugMug grant header ${name} must be non-empty`)
    }
    forwarded[name] = value
  }
  if (Object.keys(forwarded).length === 0) {
    throw new Error(
      'SmugMug grant requires at least one allowlisted Companion header',
    )
  }

  if (!Number.isFinite(now)) {
    throw new Error('SmugMug grant issuedAt must be finite')
  }

  return {
    grantId: `smugmug-${now}-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'smugmug',
    companionOrigin,
    headers: forwarded,
    issuedAt: now,
    expiresAt: now + GRANT_TTL_MS,
  }
}
