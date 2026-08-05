import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('express-prom-bundle')
import * as tokenService from '../src/server/helpers/jwt.js'
import { getServer, setDefaultEnv } from './mockserver.js'

const companionSecret = 'test-companion-secret'

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

function getProbeServer() {
  return getServer({
    COMPANION_SECRET: companionSecret,
    COMPANION_SMUGMUG_API_KEY: randomUUID(),
    COMPANION_SMUGMUG_API_SECRET: randomUUID(),
  })
}

beforeEach(() => {
  vi.resetModules()
  setDefaultEnv()
})

describe('POST /smugmug/source/prepare', () => {
  test('returns 400 without required fields', async () => {
    const server = await getProbeServer()
    const token = createValidToken()

    // Missing both fields - should fail validation
    const response = await request(server)
      .post('/smugmug/source/prepare')
      .set('uppy-auth-token', token)
      .send({})
      .expect(400)

    // Just verify we get a 400
    expect(response.status).toBe(400)
  })
})

describe('GET /smugmug/source/:id/bytes', () => {
  test('returns 401 without source token', async () => {
    const server = await getProbeServer()

    const response = await request(server)
      .get('/smugmug/source/image:test/bytes?start=0&end=9')
      .expect(401)

    expect(response.status).toBe(401)
  })

  test('returns 401 with invalid source token', async () => {
    const server = await getProbeServer()
    const token = createValidToken()

    await request(server)
      .get('/smugmug/source/image:test/bytes?start=0&end=9')
      .set('uppy-source-token', 'invalid-token')
      .set('uppy-auth-token', token)
      .expect(401)
  })
})
