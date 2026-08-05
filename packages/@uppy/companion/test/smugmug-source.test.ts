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
})
