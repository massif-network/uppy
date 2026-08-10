import { describe, expect, it } from 'vitest'
import {
  deriveUserHash,
  mintSourceToken,
  validateSourceToken,
} from '../src/server/helpers/source-token.js'

const secret = 'test-secret'
const userHash = deriveUserHash('access-token-value')

describe('validateSourceToken', () => {
  it('accepts a token it just minted', () => {
    const token = mintSourceToken({
      secret,
      sourceId: 'source-1',
      sourceVersion: 'v1',
      userHash,
    })

    const payload = validateSourceToken({ secret, token })

    expect(payload).toMatchObject({
      source_id: 'source-1',
      source_version: 'v1',
      user_hash: userHash,
    })
  })

  it('rejects a token signed with a different secret (same-length signature)', () => {
    const token = mintSourceToken({
      secret: 'other-secret',
      sourceId: 'source-1',
      sourceVersion: 'v1',
      userHash,
    })

    expect(validateSourceToken({ secret, token })).toBeNull()
  })

  it('rejects a token whose signature length does not match the expected signature', () => {
    const token = mintSourceToken({
      secret,
      sourceId: 'source-1',
      sourceVersion: 'v1',
      userHash,
    })
    const [payloadB64] = token.split('.')
    const shortSignatureToken = `${payloadB64}.abc`

    expect(validateSourceToken({ secret, token: shortSignatureToken })).toBeNull()
  })

  it('rejects an expired token', () => {
    const token = mintSourceToken({
      secret,
      sourceId: 'source-1',
      sourceVersion: 'v1',
      userHash,
      ttlMs: -1,
    })

    expect(validateSourceToken({ secret, token })).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(validateSourceToken({ secret, token: 'not-a-real-token' })).toBeNull()
  })
})
