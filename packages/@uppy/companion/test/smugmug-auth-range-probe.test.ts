import { randomUUID } from 'node:crypto'
import nock from 'nock'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('express-prom-bundle')
import * as tokenService from '../src/server/helpers/jwt.js'
import { getServer, setDefaultEnv } from './mockserver.js'

const API_HOST = 'https://api.smugmug.com'
const ORIGINAL_HOST = 'https://photos.smugmug.com'
const imageId = 'image:private-image-7'
const imagePath = '/api/v2/image/private-image-7'
const detailsPath = '/api/v2/image/private-image-7!sizedetails'
const companionSecret = 'test-companion-secret'

function mockOAuthMetadata(): void {
  nock(API_HOST)
    .get(imagePath)
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        Image: {
          Uri: imagePath,
          ImageKey: 'private-image',
          Serial: 7,
          ArchivedSize: 4,
          ArchivedMD5: 'private-md5',
          LastUpdated: '2026-08-05T00:00:00Z',
          Uris: { ImageSizeDetails: { Uri: detailsPath } },
        },
      },
    })
    .get(detailsPath)
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, {
      Response: {
        ImageSizeDetails: {
          ImageSizeOriginal: {
            Url: `${ORIGINAL_HOST}/private-original`,
            Size: 4,
            MimeType: 'image/jpeg',
          },
        },
      },
    })
}

function mockOAuthHead(): void {
  nock(ORIGINAL_HOST)
    .head('/private-original')
    .matchHeader('authorization', (value) => /^OAuth /.test(value))
    .reply(200, '', {
      'content-length': '4',
      'content-type': 'image/jpeg',
      etag: 'private-etag',
    })
}

function authenticatedToken(): string {
  return tokenService.generateEncryptedAuthToken(
    {
      smugmug: {
        accessToken: 'test-access-token',
        accessTokenSecret: 'test-access-token-secret',
      },
    },
    companionSecret,
  )
}

function getProbeServer() {
  return getServer({
    COMPANION_SECRET: companionSecret,
    COMPANION_SMUGMUG_API_KEY: randomUUID(),
    COMPANION_SMUGMUG_API_SECRET: randomUUID(),
    COMPANION_SMUGMUG_AUTH_RANGE_PROBE: 'true',
  })
}

function authProbeRequest(server: Awaited<ReturnType<typeof getServer>>) {
  return request(server)
    .get(`/smugmug/_range-probe-auth/${imageId}`)
    .set('uppy-auth-token', authenticatedToken())
}

beforeEach(() => {
  vi.resetModules()
  setDefaultEnv()
})

afterEach(() => {
  nock.cleanAll()
})

describe('temporary authenticated SmugMug range probe', () => {
  test('rejects missing and invalid encrypted Companion tokens', async () => {
    const server = await getProbeServer()

    await request(server)
      .get(`/smugmug/_range-probe-auth/${imageId}`)
      .set('Range', 'bytes=0-1')
      .expect(401)
    await request(server)
      .get(`/smugmug/_range-probe-auth/${imageId}`)
      .set('uppy-auth-token', 'invalid')
      .set('Range', 'bytes=0-1')
      .expect(401)
  })

  test('returns private metadata without returning the original URL', async () => {
    mockOAuthMetadata()
    mockOAuthHead()
    const server = await getProbeServer()

    const response = await request(server)
      .get(`/smugmug/_range-probe-auth/${imageId}/metadata`)
      .set('uppy-auth-token', authenticatedToken())
      .expect(200)

    expect(response.body).toMatchObject({
      canonicalUri: imagePath,
      imageKey: 'private-image',
      serial: 7,
      size: 4,
      etag: 'private-etag',
    })
    expect(response.text).not.toContain(ORIGINAL_HOST)
  })

  test('OAuth-signs metadata, HEAD, and two adjacent exact ranges', async () => {
    mockOAuthMetadata()
    mockOAuthHead()
    nock(ORIGINAL_HOST)
      .get('/private-original')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .matchHeader('range', 'bytes=0-1')
      .reply(206, 'ab', {
        'content-range': 'bytes 0-1/4',
        'content-length': '2',
        'content-type': 'image/jpeg',
      })
    mockOAuthMetadata()
    mockOAuthHead()
    nock(ORIGINAL_HOST)
      .get('/private-original')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .matchHeader('range', 'bytes=2-3')
      .reply(206, 'cd', {
        'content-range': 'bytes 2-3/4',
        'content-length': '2',
        'content-type': 'image/jpeg',
      })
    const server = await getProbeServer()

    const first = await authProbeRequest(server)
      .set('Range', 'bytes=0-1')
      .expect(206)
    const second = await authProbeRequest(server)
      .set('Range', 'bytes=2-3')
      .expect(206)

    expect(first.headers['content-range']).toBe('bytes 0-1/4')
    expect(second.headers['content-range']).toBe('bytes 2-3/4')
    expect(Buffer.concat([first.body, second.body]).toString()).toBe('abcd')
  })
})
