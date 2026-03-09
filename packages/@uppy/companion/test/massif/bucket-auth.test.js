import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBucketToken,
  validateBucketToken,
  TokenError,
} from '../../src/massif/bucket-auth.js'

const SECRET = 'test-secret-at-least-32-chars-long!!'
const BUCKET = 'org-acme-locations'

describe('bucket-auth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('createBucketToken', () => {
    it('creates a base64url-encoded token', () => {
      const token = createBucketToken(BUCKET, SECRET, 3600)
      expect(typeof token).toBe('string')

      const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      expect(parsed.bucket).toBe(BUCKET)
      expect(parsed.exp).toBe(Math.floor(Date.now() / 1000) + 3600)
      expect(typeof parsed.sig).toBe('string')
    })

    it('throws if bucket is missing', () => {
      expect(() => createBucketToken('', SECRET)).toThrow('bucket and secret are required')
    })

    it('throws if secret is missing', () => {
      expect(() => createBucketToken(BUCKET, '')).toThrow('bucket and secret are required')
    })

    it('uses default TTL of 1 hour', () => {
      const token = createBucketToken(BUCKET, SECRET)
      const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      expect(parsed.exp).toBe(Math.floor(Date.now() / 1000) + 3600)
    })
  })

  describe('validateBucketToken', () => {
    it('accepts a valid token for the correct bucket', () => {
      const token = createBucketToken(BUCKET, SECRET, 3600)
      expect(() =>
        validateBucketToken({ bucketAuthToken: token, bucketName: BUCKET }, BUCKET, SECRET),
      ).not.toThrow()
    })

    it('rejects missing token', () => {
      expect(() =>
        validateBucketToken({}, BUCKET, SECRET),
      ).toThrow(TokenError)
      expect(() =>
        validateBucketToken({}, BUCKET, SECRET),
      ).toThrow('Missing bucketAuthToken')
    })

    it('rejects malformed token', () => {
      expect(() =>
        validateBucketToken({ bucketAuthToken: 'not-valid-base64-json!!' }, BUCKET, SECRET),
      ).toThrow('Malformed bucketAuthToken')
    })

    it('rejects token with missing fields', () => {
      const incomplete = Buffer.from(JSON.stringify({ bucket: BUCKET })).toString('base64url')
      expect(() =>
        validateBucketToken({ bucketAuthToken: incomplete }, BUCKET, SECRET),
      ).toThrow('Incomplete bucketAuthToken')
    })

    it('rejects expired token', () => {
      const token = createBucketToken(BUCKET, SECRET, 60) // 60 second TTL

      // Advance time past expiry
      vi.advanceTimersByTime(61 * 1000)

      expect(() =>
        validateBucketToken({ bucketAuthToken: token }, BUCKET, SECRET),
      ).toThrow('expired')
    })

    it('rejects token signed with wrong secret', () => {
      const token = createBucketToken(BUCKET, 'wrong-secret-entirely!!!!!!!!!!!!', 3600)
      expect(() =>
        validateBucketToken({ bucketAuthToken: token }, BUCKET, SECRET),
      ).toThrow('Invalid bucketAuthToken signature')
    })

    it('rejects token for a different bucket', () => {
      const token = createBucketToken('org-rival-corp-locations', SECRET, 3600)
      expect(() =>
        validateBucketToken({ bucketAuthToken: token }, BUCKET, SECRET),
      ).toThrow('does not match requested bucket')
    })

    it('prevents bucket swap attack (token for bucket A, request for bucket B)', () => {
      const tokenForA = createBucketToken('org-acme-locations', SECRET, 3600)
      expect(() =>
        validateBucketToken(
          { bucketAuthToken: tokenForA, bucketName: 'org-evil-locations' },
          'org-evil-locations',
          SECRET,
        ),
      ).toThrow('does not match requested bucket')
    })

    it('TokenError has correct status code', () => {
      expect.assertions(3)
      try {
        validateBucketToken({}, BUCKET, SECRET)
      } catch (err) {
        expect(err).toBeInstanceOf(TokenError)
        expect(err.status).toBe(403)
        expect(err.name).toBe('TokenError')
      }
    })

    it('rejects token with truncated signature', () => {
      const token = createBucketToken(BUCKET, SECRET, 3600)
      const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      // Truncate the signature to trigger the length guard
      parsed.sig = parsed.sig.slice(0, 5)
      const tampered = Buffer.from(JSON.stringify(parsed)).toString('base64url')
      expect(() =>
        validateBucketToken({ bucketAuthToken: tampered }, BUCKET, SECRET),
      ).toThrow('Invalid bucketAuthToken signature')
    })

    it('rejects token with extended signature', () => {
      const token = createBucketToken(BUCKET, SECRET, 3600)
      const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      parsed.sig = parsed.sig + 'AAAA_extra_bytes'
      const tampered = Buffer.from(JSON.stringify(parsed)).toString('base64url')
      expect(() =>
        validateBucketToken({ bucketAuthToken: tampered }, BUCKET, SECRET),
      ).toThrow('Invalid bucketAuthToken signature')
    })

    it('rejects null metadata', () => {
      expect(() =>
        validateBucketToken(null, BUCKET, SECRET),
      ).toThrow('Missing bucketAuthToken')
    })

    it('rejects undefined metadata', () => {
      expect(() =>
        validateBucketToken(undefined, BUCKET, SECRET),
      ).toThrow('Missing bucketAuthToken')
    })

    it('accepts token just before expiry', () => {
      const token = createBucketToken(BUCKET, SECRET, 60)

      // Advance to 59 seconds (still valid)
      vi.advanceTimersByTime(59 * 1000)

      expect(() =>
        validateBucketToken({ bucketAuthToken: token }, BUCKET, SECRET),
      ).not.toThrow()
    })
  })
})
