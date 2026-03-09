/**
 * R2-compatible upload parameters.
 *
 * Replaces createPresignedPost (unsupported by Cloudflare R2) with
 * getSignedUrl + PutObjectCommand, which is compatible with both
 * AWS S3 and any S3-compatible storage (R2, MinIO, etc.).
 *
 * The client-side @uppy/aws-s3 plugin already handles the PUT response
 * shape — see HTTPCommunicationQueue.ts#nonMultipartUpload.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { rfc2047EncodeMetadata } from '../server/helpers/utils.js'

/**
 * Generate a presigned PUT URL for direct upload.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} client
 * @param {object} opts
 * @param {string} opts.bucket
 * @param {string} opts.key
 * @param {string} opts.type - MIME type
 * @param {Record<string, string>} [opts.metadata]
 * @param {string | null} [opts.acl]
 * @param {number} opts.expires - seconds until the URL expires
 * @returns {Promise<{ method: string, url: string, fields: Record<string, string>, expires: number, headers: Record<string, string> }>}
 */
export async function getPresignedPutParams(client, { bucket, key, type, metadata = {}, acl, expires }) {
  const params = {
    Bucket: bucket,
    Key: key,
    ContentType: type,
  }

  if (acl != null) params.ACL = acl

  if (Object.keys(metadata).length > 0) {
    params.Metadata = rfc2047EncodeMetadata(metadata)
  }

  const url = await getSignedUrl(client, new PutObjectCommand(params), {
    expiresIn: expires,
    // Sign Content-Type so it can't be changed by the uploader
    signableHeaders: new Set(['content-type']),
  })

  return {
    method: 'PUT',
    url,
    fields: { key },
    expires,
    headers: { 'Content-Type': type },
  }
}
