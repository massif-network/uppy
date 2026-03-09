/**
 * Bucket authorization via HMAC-signed tokens.
 *
 * Prevents unauthorized bucket access when using COMPANION_AWS_DYNAMIC_BUCKET.
 * The application server (e.g. SvelteKit) generates a short-lived token that
 * binds a user to a specific bucket. Companion validates the token before
 * allowing the upload.
 *
 * Token format: base64url({ bucket, exp, sig })
 *   - bucket: the allowed bucket name
 *   - exp: expiry as Unix timestamp (seconds)
 *   - sig: HMAC-SHA256(bucket + ":" + exp, secret)
 *
 * Usage:
 *   Client sets metadata.bucketAuthToken before upload.
 *   Companion calls validateBucketToken(metadata, resolvedBucket).
 *
 * Env: COMPANION_BUCKET_AUTH_SECRET (required when COMPANION_AWS_DYNAMIC_BUCKET=true)
 */

import crypto from 'node:crypto'

const ALGORITHM = 'sha256'

/**
 * Create a bucket authorization token.
 *
 * Call this on your application server (NOT in Companion) when preparing
 * file metadata for a remote upload. Example (SvelteKit):
 *
 *   import { createBucketToken } from './bucket-auth.js'
 *   const token = createBucketToken(bucketName, secret, 3600)
 *   uppy.setFileMeta(fileId, { bucketAuthToken: token, bucketName })
 *
 * @param {string} bucket - The bucket the user is allowed to upload to
 * @param {string} secret - Shared secret (COMPANION_BUCKET_AUTH_SECRET)
 * @param {number} [ttlSeconds=3600] - Token lifetime in seconds (default: 1 hour)
 * @returns {string} Base64url-encoded token
 */
export function createBucketToken(bucket, secret, ttlSeconds = 3600) {
  if (!bucket || !secret) {
    throw new Error('bucket and secret are required to create a bucket auth token')
  }

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${bucket}:${exp}`
  const sig = crypto.createHmac(ALGORITHM, secret).update(payload).digest('base64url')

  return Buffer.from(JSON.stringify({ bucket, exp, sig })).toString('base64url')
}

/**
 * Validate a bucket authorization token from file metadata.
 *
 * @param {Record<string, string>} metadata - File metadata from the upload request
 * @param {string} resolvedBucket - The bucket name that was resolved from metadata
 * @param {string} secret - Shared secret (COMPANION_BUCKET_AUTH_SECRET)
 * @throws {Error} If token is missing, expired, invalid, or bucket doesn't match
 */
export function validateBucketToken(metadata, resolvedBucket, secret) {
  const token = metadata?.bucketAuthToken
  if (!token) {
    throw new TokenError('Missing bucketAuthToken in metadata', 403)
  }

  let parsed
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new TokenError('Malformed bucketAuthToken', 403)
  }

  const { bucket, exp, sig } = parsed

  if (!bucket || !exp || !sig) {
    throw new TokenError('Incomplete bucketAuthToken', 403)
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000)
  if (exp <= now) {
    throw new TokenError('bucketAuthToken has expired', 403)
  }

  // Verify HMAC signature (length guard prevents timingSafeEqual RangeError)
  const expectedPayload = `${bucket}:${exp}`
  const expectedSig = crypto.createHmac(ALGORITHM, secret).update(expectedPayload).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expectedSigBuf = Buffer.from(expectedSig)

  if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
    throw new TokenError('Invalid bucketAuthToken signature', 403)
  }

  // Verify the token's bucket matches what was resolved
  if (bucket !== resolvedBucket) {
    throw new TokenError(
      `bucketAuthToken bucket "${bucket}" does not match requested bucket "${resolvedBucket}"`,
      403,
    )
  }
}

/**
 * Error class for bucket auth failures. Includes an HTTP status code.
 */
export class TokenError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status = 403) {
    super(message)
    this.name = 'TokenError'
    this.status = status
  }
}
