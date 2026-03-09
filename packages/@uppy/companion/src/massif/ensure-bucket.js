/**
 * Auto-create S3/R2 buckets on first use.
 *
 * Caches known-existing bucket names in memory so HeadBucket is called
 * at most once per bucket per Companion process lifetime.
 */

import {
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import logger from '../server/logger.js'

/** @type {Set<string>} */
const knownBuckets = new Set()

/**
 * Ensure an S3/R2 bucket exists, creating it if necessary.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} client
 * @param {string} bucket
 */
export async function ensureBucket(client, bucket) {
  if (knownBuckets.has(bucket)) return

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    knownBuckets.add(bucket)
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      logger.info(`Bucket "${bucket}" not found, creating it`, 'massif.ensure-bucket')
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
      knownBuckets.add(bucket)
    } else {
      throw err
    }
  }
}

/**
 * Clear the bucket cache. Useful for testing.
 */
export function clearBucketCache() {
  knownBuckets.clear()
}
