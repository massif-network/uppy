import crypto from 'node:crypto'

export type SourceTokenPayload = {
  source_id: string
  source_version: string
  user_hash: string
  chunk_max: number
  exp: number // expiry timestamp in ms
}

const TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes - matches typical slice budget
const DEFAULT_CHUNK_MAX = 64 * 1024 // 64KB default

/**
 * Non-reversible discriminator binding a token to the authenticated provider
 * session, so one user's source token cannot be replayed with another user's
 * auth token. Never expose or store the raw access token.
 */
export function deriveUserHash(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('base64url').slice(0, 22)
}

/**
 * Mint an HMAC-signed source token for bounded byte requests.
 * The token carries source_id, source_version (from prepare), the user
 * binding, expiry, and chunk_max.
 */
export function mintSourceToken({
  secret,
  sourceId,
  sourceVersion,
  userHash,
  chunkMax = DEFAULT_CHUNK_MAX,
  ttlMs = TOKEN_TTL_MS,
}: {
  secret: string
  sourceId: string
  sourceVersion: string
  userHash: string
  chunkMax?: number
  ttlMs?: number
}): string {
  const payload: SourceTokenPayload = {
    source_id: sourceId,
    source_version: sourceVersion,
    user_hash: userHash,
    chunk_max: chunkMax,
    exp: Date.now() + ttlMs,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url')
  return `${payloadB64}.${signature}`
}

/**
 * Validate and parse a source token. Returns null if invalid/expired.
 */
export function validateSourceToken({
  secret,
  token,
}: {
  secret: string
  token: string
}): SourceTokenPayload | null {
  try {
    const [payloadB64, signature] = token.split('.')
    if (!payloadB64 || !signature) return null
    
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url')
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null
    }
    
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as SourceTokenPayload
    
    if (Date.now() > payload.exp) {
      return null // expired
    }
    
    return payload
  } catch {
    return null
  }
}
