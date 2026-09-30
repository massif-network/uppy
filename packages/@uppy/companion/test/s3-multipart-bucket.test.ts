import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { getServer } from './mockserver.js'

/**
 * Companion resolves the bucket for the multipart follow-up routes (sign part,
 * list parts, complete, abort) from `?bucket=`, then from a cache filled at
 * create time. Prod runs several Companion instances behind one hostname, so
 * that cache has to be shared through Redis: a follow-up served by the instance
 * that did not create the upload used to fall back to the default bucket and
 * sign for a bucket the upload does not exist in (massif-network/uppy#50).
 *
 * The Redis module is replaced by an in-memory store that survives
 * `vi.resetModules()`, and each `getServer()` after a reset is a fresh module
 * graph, i.e. a second "instance" with an empty in-process cache.
 */

// Same as companion.test.ts: the metrics bundle registers global prom-client
// metrics, which a second server (after vi.resetModules) would re-register.
vi.mock('express-prom-bundle')

const shared = vi.hoisted(() => ({
  store: new Map<string, string>(),
  redisEnabled: true,
  s3Calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
}))

vi.mock('../src/server/redis.js', () => {
  // Enough of ioredis for the bucket cache (get/set/del) and for the upload
  // emitter, which duplicates the client twice for pub/sub at startup.
  const pubsub = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    Object.assign(c, {
      on: () => c,
      off: () => c,
      connect: async () => undefined,
      quit: async () => 'OK',
      duplicate: () => pubsub(),
      psubscribe: async () => 1,
      punsubscribe: async () => 0,
      publish: async () => 0,
    })
    return c
  }
  const fake = {
    ...pubsub(),
    get: async (key: string) => shared.store.get(key) ?? null,
    set: async (key: string, value: string) => {
      shared.store.set(key, value)
      return 'OK'
    },
    del: async (key: string) => (shared.store.delete(key) ? 1 : 0),
  }
  return { client: () => (shared.redisEnabled ? fake : undefined) }
})

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  class FakeS3Client {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      shared.s3Calls.push({
        name: command.constructor.name,
        input: command.input,
      })
      switch (command.constructor.name) {
        case 'CreateMultipartUploadCommand':
          return { UploadId: 'upload-1', Key: command.input['Key'] }
        case 'ListPartsCommand':
          return { Parts: [], IsTruncated: false }
        case 'CompleteMultipartUploadCommand':
          return {
            Location: `https://s3.test/${command.input['Bucket']}/${command.input['Key']}`,
            Key: command.input['Key'],
          }
        default:
          return {}
      }
    }
  }
  return { ...actual, S3Client: FakeS3Client }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (
    _client: unknown,
    command: { input: Record<string, unknown> },
  ) =>
    `https://signed.test/${command.input['Bucket']}/${command.input['Key']}?part=${command.input['PartNumber']}`,
}))

const dynamicBucketEnv = {
  COMPANION_AWS_KEY: 'test_key',
  COMPANION_AWS_SECRET: 'test_secret',
  COMPANION_AWS_REGION: 'us-east-1',
  COMPANION_AWS_BUCKET: 'fallback-bucket',
  COMPANION_AWS_DYNAMIC_BUCKET: 'true',
  COMPANION_REDIS_URL: 'redis://fake',
}

const createUpload = async (
  server: Awaited<ReturnType<typeof getServer>>,
  bucketName: string,
) => {
  const res = await request(server)
    .post('/s3/multipart')
    .send({
      filename: 'a.jpg',
      type: 'image/jpeg',
      metadata: { bucketName, objectName: 'loc/images/a.jpg' },
    })
    .expect(200)
  return res.body as { uploadId: string; key: string; bucket: string }
}

const freshInstance = async (env = dynamicBucketEnv) => {
  vi.resetModules()
  return getServer(env)
}

afterEach(() => {
  shared.store.clear()
  shared.s3Calls.length = 0
  shared.redisEnabled = true
})

describe('multipart follow-ups resolve the bucket across Companion instances', () => {
  test('create stores the bucket in Redis; another instance signs, lists, completes and aborts against it', async () => {
    const first = await freshInstance()
    const { uploadId, key, bucket } = await createUpload(
      first,
      'org-a-locations',
    )
    expect(bucket).toBe('org-a-locations')
    expect(shared.store.get(`companion:s3:bucket:${uploadId}`)).toBe(
      'org-a-locations',
    )

    const second = await freshInstance()

    const sign = await request(second)
      .get(`/s3/multipart/${uploadId}/1`)
      .query({ key })
      .expect(200)
    expect(sign.body.url).toBe(
      `https://signed.test/org-a-locations/${key}?part=1`,
    )

    const batch = await request(second)
      .get(`/s3/multipart/${uploadId}/batch`)
      .query({ key, partNumbers: '1,2' })
      .expect(200)
    expect(batch.body.presignedUrls['2']).toBe(
      `https://signed.test/org-a-locations/${key}?part=2`,
    )

    await request(second)
      .get(`/s3/multipart/${uploadId}`)
      .query({ key })
      .expect(200)
    expect(
      shared.s3Calls.find((c) => c.name === 'ListPartsCommand')?.input[
        'Bucket'
      ],
    ).toBe('org-a-locations')

    const complete = await request(second)
      .post(`/s3/multipart/${uploadId}/complete`)
      .query({ key })
      .send({ parts: [{ PartNumber: 1, ETag: '"e1"' }] })
      .expect(200)
    expect(complete.body.bucket).toBe('org-a-locations')
    expect(
      shared.s3Calls.find((c) => c.name === 'CompleteMultipartUploadCommand')
        ?.input['Bucket'],
    ).toBe('org-a-locations')
    expect(shared.store.has(`companion:s3:bucket:${uploadId}`)).toBe(false)
  })

  test('abort on another instance uses the created bucket and clears the entry', async () => {
    const first = await freshInstance()
    const { uploadId, key } = await createUpload(first, 'org-b-locations')

    const second = await freshInstance()
    await request(second)
      .delete(`/s3/multipart/${uploadId}`)
      .query({ key })
      .expect(200)
    expect(
      shared.s3Calls.find((c) => c.name === 'AbortMultipartUploadCommand')
        ?.input['Bucket'],
    ).toBe('org-b-locations')
    expect(shared.store.has(`companion:s3:bucket:${uploadId}`)).toBe(false)
  })

  test('?bucket= from the client wins over the cache', async () => {
    const server = await freshInstance()
    const { uploadId, key } = await createUpload(server, 'org-c-locations')

    const sign = await request(server)
      .get(`/s3/multipart/${uploadId}/1`)
      .query({ key, bucket: 'org-c-locations-explicit' })
      .expect(200)
    expect(sign.body.url).toBe(
      `https://signed.test/org-c-locations-explicit/${key}?part=1`,
    )
  })

  test('dynamic bucket with no Redis and no cache entry answers 400 instead of signing for the default bucket', async () => {
    shared.redisEnabled = false
    const server = await freshInstance()

    const sign = await request(server)
      .get('/s3/multipart/unknown-upload/1')
      .query({ key: 'k' })
      .expect(400)
    expect(sign.body.error).toMatch(/bucket for this uploadId is unknown/)
    await request(server)
      .post('/s3/multipart/unknown-upload/complete')
      .query({ key: 'k' })
      .send({ parts: [] })
      .expect(400)
    expect(
      shared.s3Calls.some((c) => c.name !== 'CreateMultipartUploadCommand'),
    ).toBe(false)
  })

  test('dynamic bucket without Redis still works within one instance', async () => {
    shared.redisEnabled = false
    const server = await freshInstance()
    const { uploadId, key } = await createUpload(server, 'org-d-locations')

    const sign = await request(server)
      .get(`/s3/multipart/${uploadId}/1`)
      .query({ key })
      .expect(200)
    expect(sign.body.url).toBe(
      `https://signed.test/org-d-locations/${key}?part=1`,
    )
  })

  test('a static bucket needs no cache: a fresh instance signs against it', async () => {
    shared.redisEnabled = false
    const server = await freshInstance({
      ...dynamicBucketEnv,
      COMPANION_AWS_DYNAMIC_BUCKET: 'false',
      COMPANION_AWS_BUCKET: 'static-bucket',
    })

    const sign = await request(server)
      .get('/s3/multipart/any-upload/1')
      .query({ key: 'k' })
      .expect(200)
    expect(sign.body.url).toBe('https://signed.test/static-bucket/k?part=1')
  })
})
