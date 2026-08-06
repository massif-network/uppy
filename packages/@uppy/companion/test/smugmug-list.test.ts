import { randomUUID } from 'node:crypto'
import nock from 'nock'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as tokenService from '../src/server/helpers/jwt.js'
import { getServer, setDefaultEnv } from './mockserver.js'

vi.mock('express-prom-bundle')

const API_HOST = 'https://api.smugmug.com'
const companionSecret = 'test-list-companion-secret'

function createValidToken(): string {
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

function getListServer() {
  return getServer({
    COMPANION_SECRET: companionSecret,
    COMPANION_SMUGMUG_API_KEY: randomUUID(),
    COMPANION_SMUGMUG_API_SECRET: randomUUID(),
  })
}

beforeEach(() => {
  setDefaultEnv()
})

afterEach(() => {
  nock.cleanAll()
})

describe('GET /smugmug/list/:id cursor contract', () => {
  test('accepts an opaque same-host relative cursor', async () => {
    nock(API_HOST)
      .get('/api/v2/album/abc!images')
      .query({ start: '101' })
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .reply(200, {
        Response: {
          AlbumImage: [
            {
              Uri: '/api/v2/image/k1',
              ImageKey: 'k1',
              Serial: 7,
              ArchivedSize: 1234,
              ArchivedMD5: 'md5-k1',
              LastUpdated: '2026-08-05T00:00:00Z',
              FileName: 'a.jpg',
            },
          ],
        },
      })

    const server = await getListServer()
    const res = await request(server)
      .get('/smugmug/list/album:abc')
      .query({ cursor: '/api/v2/album/abc!images?start=101' })
      .set('uppy-auth-token', createValidToken())
      .expect(200)

    expect(res.body.items[0]).toMatchObject({
      id: 'image:k1',
      sourceVersion: '/api/v2/image/k1|7|2026-08-05T00:00:00Z|1234|md5-k1',
    })
  })

  test.each([
    ['missing leading slash', 'album/abc!images?start=101'],
    [
      'absolute same-host URL',
      'https://api.smugmug.com/api/v2/album/abc!images',
    ],
    ['cross-host URL', '//evil.example.test/api/v2/album/abc!images'],
    ['backslash URL', '/\\evil.example.test/api/v2/album/abc!images'],
    ['malformed escape', '/api/v2/album/abc!images?opaque=%ZZ'],
    ['unrelated v2 endpoint', '/api/v2/node/n1!children'],
    ['album key mismatch', '/api/v2/album/other!images'],
    ['fragment', '/api/v2/album/abc!images#fragment'],
  ])('rejects %s before making an API request', async (_label, cursor) => {
    const server = await getListServer()
    await request(server)
      .get('/smugmug/list/album:abc')
      .query({ cursor })
      .set('uppy-auth-token', createValidToken())
      .expect(400)
  })

  test.each([
    ['album traversal', '/smugmug/list/album:%2E%2E%2Fevil'],
    ['node traversal', '/smugmug/list/node:%2E%2E%2Fevil'],
    ['album slash', '/smugmug/list/album:bad%2Fevil'],
    ['node slash', '/smugmug/list/node:bad%2Fevil'],
  ])('rejects malformed %s directories before an API request', async (_kind, path) => {
    const server = await getListServer()
    await request(server)
      .get(path)
      .set('uppy-auth-token', createValidToken())
      .expect(400)
    expect(nock.pendingMocks()).toEqual([])
  })

  test('binds a root cursor to the authenticated root node', async () => {
    nock(API_HOST)
      .get('/api/v2/!authuser')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .reply(200, {
        Response: {
          User: {
            Name: 'tester',
            Uris: { Node: { Uri: '/api/v2/node/root' } },
          },
        },
      })
    nock(API_HOST)
      .get('/api/v2/node/root!children')
      .query({ start: '101' })
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .reply(200, { Response: { Node: [] } })

    const server = await getListServer()
    const res = await request(server)
      .get('/smugmug/list')
      .query({ cursor: '/api/v2/node/root!children?start=101' })
      .set('uppy-auth-token', createValidToken())
      .expect(200)

    expect(res.body.username).toBe('tester')
    expect(res.body.items).toEqual([])
  })

  test('rejects a root cursor for a different authenticated root node', async () => {
    nock(API_HOST)
      .get('/api/v2/!authuser')
      .matchHeader('authorization', (value) => /^OAuth /.test(value))
      .reply(200, {
        Response: {
          User: {
            Name: 'tester',
            Uris: { Node: { Uri: '/api/v2/node/root' } },
          },
        },
      })

    const server = await getListServer()
    await request(server)
      .get('/smugmug/list')
      .query({ cursor: '/api/v2/node/other!children?start=101' })
      .set('uppy-auth-token', createValidToken())
      .expect(400)
  })
})
