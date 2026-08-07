import { randomUUID } from 'node:crypto'
import nock from 'nock'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('express-prom-bundle')
import * as tokenService from '../src/server/helpers/jwt.js'
import { getServer, setDefaultEnv } from './mockserver.js'

const API_HOST = 'https://api.smugmug.com'
const ORIGINAL_HOST = 'https://photos.smugmug.com'
const companionSecret = 'test-companion-secret'

function mockSmugMugFull(): void {
  // Image metadata
  nock(API_HOST)
    .get('/api/v2/image/test-image-1')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        Image: {
          Uri: '/api/v2/image/test-image-1',
          ImageKey: 'test-image',
          Serial: 1,
          ArchivedSize: 100,
          ArchivedMD5: 'test-md5',
          LastUpdated: '2026-08-05T00:00:00Z',
          Uris: { ImageSizeDetails: { Uri: '/api/v2/image/test-image-1!sizedetails' } },
        },
      },
    })
    .get('/api/v2/image/test-image-1!sizedetails')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        ImageSizeDetails: {
          ImageSizeOriginal: { Url: 'https://photos.smugmug.com/test-original', Size: 100, MimeType: 'image/jpeg' },
        },
      },
    })
  
  // HEAD on original
  nock(ORIGINAL_HOST)
    .head('/test-original')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, '', { 'content-length': '100', 'content-type': 'image/jpeg', etag: 'test-etag', 'accept-ranges': 'bytes' })
    
  // GET range on original
  nock(ORIGINAL_HOST)
    .get('/test-original')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .matchHeader('range', (value) => /^bytes=/.test(value))
    .reply(206, 'ABCDEFGHIJ', { 'content-range': 'bytes 0-9/100', 'content-length': '10', 'content-type': 'image/jpeg' })
}

function mockSmugMugNoMd5(): void {
  nock(API_HOST)
    .get('/api/v2/image/no-md5-1')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        Image: {
          Uri: '/api/v2/image/no-md5-1',
          ImageKey: 'no-md5',
          Serial: 1,
          ArchivedSize: 100,
          LastUpdated: '2026-08-05T00:00:00Z',
          Uris: { ImageSizeDetails: { Uri: '/api/v2/image/no-md5-1!sizedetails' } },
        },
      },
    })
    .get('/api/v2/image/no-md5-1!sizedetails')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        ImageSizeDetails: {
          ImageSizeOriginal: { Url: 'https://photos.smugmug.com/no-md5-original', Size: 100, MimeType: 'image/jpeg' },
        },
      },
    })
  nock(ORIGINAL_HOST)
    .head('/no-md5-original')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, '', { 'content-length': '100', 'content-type': 'image/jpeg' })
}

const BIG_SIZE = 9 * 1024 * 1024
const CHUNK_MAX = 8 * 1024 * 1024

/** A source larger than one 8 MiB part, for exercising the unified chunk cap. */
function mockSmugMugBig(withRange: { start: number; end: number } | null): void {
  nock(API_HOST)
    .get('/api/v2/image/big-image-1')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        Image: {
          Uri: '/api/v2/image/big-image-1',
          ImageKey: 'big-image',
          Serial: 1,
          ArchivedSize: BIG_SIZE,
          LastUpdated: '2026-08-05T00:00:00Z',
          Uris: { ImageSizeDetails: { Uri: '/api/v2/image/big-image-1!sizedetails' } },
        },
      },
    })
    .get('/api/v2/image/big-image-1!sizedetails')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        ImageSizeDetails: {
          ImageSizeOriginal: { Url: 'https://photos.smugmug.com/big-original', Size: BIG_SIZE, MimeType: 'image/jpeg' },
        },
      },
    })
  nock(ORIGINAL_HOST)
    .head('/big-original')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, '', { 'content-length': String(BIG_SIZE), 'content-type': 'image/jpeg', 'accept-ranges': 'bytes' })
  if (withRange !== null) {
    const length = withRange.end - withRange.start + 1
    nock(ORIGINAL_HOST)
      .get('/big-original')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .matchHeader('range', `bytes=${withRange.start}-${withRange.end}`)
      .reply(206, Buffer.alloc(length, 0x41), {
        'content-range': `bytes ${withRange.start}-${withRange.end}/${BIG_SIZE}`,
        'content-length': String(length),
        'content-type': 'image/jpeg',
      })
  }
}

function createValidToken(): string {
  return tokenService.generateEncryptedAuthToken(
    { smugmug: { accessToken: 'test-access-token', accessTokenSecret: 'test-access-token-secret' } },
    companionSecret,
  )
}

function getProbeServer() {
  return getServer({ COMPANION_SECRET: companionSecret, COMPANION_SMUGMUG_API_KEY: randomUUID(), COMPANION_SMUGMUG_API_SECRET: randomUUID() })
}

beforeEach(() => { vi.resetModules(); setDefaultEnv() })
afterEach(() => { nock.cleanAll() })

describe('POST /smugmug/source/prepare', () => {
  test('returns 400 without source_id', async () => {
    const server = await getProbeServer()
    const token = createValidToken()
    const res = await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({}).expect(400)
    expect(res.status).toBe(400)
  })

  test('returns 401 without auth token', async () => {
    const server = await getProbeServer()
    await request(server).post('/smugmug/source/prepare').send({ source_id: 'image:test' }).expect(401)
  })

  test('returns source metadata and source_token', async () => {
    mockSmugMugFull()
    const server = await getProbeServer()
    const token = createValidToken()
    const res = await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({ source_id: 'image:test-image-1' }).expect(200)
    expect(res.body.source_version).toBeDefined()
    expect(res.body.source_token).toBeDefined()
    expect(res.headers['x-massif-source-version']).toBeDefined()
  })

  // The client engine refuses the whole session when the advertised chunk_max
  // is below its own 8 MiB part ceiling — the old 64 KiB default bricked
  // every import that reached prepare.
  test('advertises an 8 MiB chunk_max by default', async () => {
    mockSmugMugFull()
    const server = await getProbeServer()
    const token = createValidToken()
    const res = await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({ source_id: 'image:test-image-1' }).expect(200)
    expect(res.body.chunk_max).toBe(8 * 1024 * 1024)
  })

  test('returns archived_md5 when SmugMug supplies it, null when it does not', async () => {
    mockSmugMugFull() // fixture image has ArchivedMD5: 'test-md5'
    const server = await getProbeServer()
    const token = createValidToken()
    const withMd5 = await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({ source_id: 'image:test-image-1' }).expect(200)
    expect(withMd5.body.archived_md5).toBe('test-md5')

    mockSmugMugNoMd5()
    const withoutMd5 = await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({ source_id: 'image:no-md5-1' }).expect(200)
    expect(withoutMd5.body.archived_md5).toBeNull()
  })

  // Upstream rate limits and auth failures used to collapse to 502, which the
  // client retries blindly (429) or cannot recover from at all (401 is the
  // only status that triggers a re-grant).
  test('passes an upstream 429 through with its Retry-After after retries are exhausted', async () => {
    // Persistent: withRateLimitRetry makes 3 attempts and got itself retries
    // 429s internally, so the exact upstream request count is an
    // implementation detail.
    nock(API_HOST)
      .get('/api/v2/image/limited-1')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .reply(429, { message: 'rate limited' }, { 'retry-after': '0' })
      .persist()
    const server = await getProbeServer()
    const token = createValidToken()
    const res = await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({ source_id: 'image:limited-1' }).expect(429)
    expect(res.headers['retry-after']).toBe('0')
  }, 15_000)

  test('passes an upstream 401 through as 401', async () => {
    nock(API_HOST)
      .get('/api/v2/image/revoked-1')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .reply(401, { message: 'oauth problem' })
    const server = await getProbeServer()
    const token = createValidToken()
    await request(server).post('/smugmug/source/prepare').set('uppy-auth-token', token).send({ source_id: 'image:revoked-1' }).expect(401)
  })
})

describe('GET /smugmug/source/:id/bytes', () => {
  test('returns 401 without source token', async () => {
    const server = await getProbeServer()
    await request(server).get('/smugmug/source/image:test/bytes').set('Range', 'bytes=0-9').expect(401)
  })

  test('returns 401 with invalid source token', async () => {
    const server = await getProbeServer()
    const token = createValidToken()
    await request(server).get('/smugmug/source/image:test/bytes').set('Range', 'bytes=0-9').set('uppy-source-token', 'invalid').set('uppy-auth-token', token).expect(401)
  })

  test('returns 401 when the source token was minted for another session', async () => {
    mockSmugMugFull()
    const server = await getProbeServer()
    const token = createValidToken()

    const prepareRes = await request(server)
      .post('/smugmug/source/prepare')
      .set('uppy-auth-token', token)
      .send({ source_id: 'image:test-image-1' })
      .expect(200)

    const otherSessionToken = tokenService.generateEncryptedAuthToken(
      { smugmug: { accessToken: 'other-access-token', accessTokenSecret: 'other-secret' } },
      companionSecret,
    )

    await request(server)
      .get('/smugmug/source/image:test-image-1/bytes')
      .set('Range', 'bytes=0-9')
      .set('uppy-source-token', prepareRes.body.source_token)
      .set('uppy-auth-token', otherSessionToken)
      .expect(401)
  })

  test('returns 206 with valid source token - full roundtrip', async () => {
    mockSmugMugFull()  // Mock for prepare
    const server = await getProbeServer()
    const token = createValidToken()
    
    // Step 1: Call prepare to get source_token
    const prepareRes = await request(server)
      .post('/smugmug/source/prepare')
      .set('uppy-auth-token', token)
      .send({ source_id: 'image:test-image-1' })
      .expect(200)
    
    const sourceToken = prepareRes.body.source_token
    const sourceVersion = prepareRes.body.source_version
    expect(sourceToken).toBeDefined()
    expect(sourceVersion).toBeDefined()
    
    // Step 2: Call bytes with the source token from prepare
    mockSmugMugFull()  // Mock again for bytes call (nock interceptors are consumed)
    
    const bytesRes = await request(server)
      .get('/smugmug/source/image:test-image-1/bytes')
      .set('Range', 'bytes=0-9')
      .set('uppy-source-token', sourceToken)
      .set('uppy-auth-token', token)
      .expect(206)
    
    // Verify headers - this proves the contract works
    expect(bytesRes.status).toBe(206)
    expect(bytesRes.headers['content-range']).toBe('bytes 0-9/100')
    expect(bytesRes.headers['x-massif-source-version']).toBe(sourceVersion)
  })

  // The cap prepare advertises and the cap /bytes enforces must be the same
  // number: previously /bytes read the dev-probe env (64 KiB default), so a
  // full-width part promised by prepare would 400.
  test('serves a range exactly as wide as the advertised chunk_max, rejects one byte more', async () => {
    mockSmugMugBig(null) // for prepare
    const server = await getProbeServer()
    const token = createValidToken()

    const prepareRes = await request(server)
      .post('/smugmug/source/prepare')
      .set('uppy-auth-token', token)
      .send({ source_id: 'image:big-image-1' })
      .expect(200)
    expect(prepareRes.body.chunk_max).toBe(CHUNK_MAX)

    mockSmugMugBig({ start: 0, end: CHUNK_MAX - 1 }) // for the bytes re-probe + range
    const wide = await request(server)
      .get('/smugmug/source/image:big-image-1/bytes')
      .set('Range', `bytes=0-${CHUNK_MAX - 1}`)
      .set('uppy-source-token', prepareRes.body.source_token)
      .set('uppy-auth-token', token)
      .expect(206)
    expect(wide.headers['content-range']).toBe(`bytes 0-${CHUNK_MAX - 1}/${BIG_SIZE}`)

    mockSmugMugBig(null) // bytes re-probes before parsing the range
    await request(server)
      .get('/smugmug/source/image:big-image-1/bytes')
      .set('Range', `bytes=0-${CHUNK_MAX}`)
      .set('uppy-source-token', prepareRes.body.source_token)
      .set('uppy-auth-token', token)
      .expect(400)
  }, 15_000)
})
