import { describe, expect, test } from 'vitest'
import { buildServiceWorkerGrant } from '../src/service-worker-grant.js'

describe('buildServiceWorkerGrant', () => {
  test('forwards only the allowlisted headers', () => {
    const grant = buildServiceWorkerGrant(
      'https://companion.example.com',
      {
        'uppy-auth-token': 'tok',
        'uppy-credentials-params': 'params',
        cookie: 'session=abc',
        authorization: 'Bearer nope',
      },
      1000,
    )
    expect(grant.headers).toEqual({ 'uppy-auth-token': 'tok', 'uppy-credentials-params': 'params' })
  })

  test('omits headers that were not present', () => {
    const grant = buildServiceWorkerGrant('https://companion.example.com', { 'uppy-auth-token': 'tok' }, 1000)
    expect(grant.headers).toEqual({ 'uppy-auth-token': 'tok' })
    expect('uppy-credentials-params' in grant.headers).toBe(false)
  })

  test('derives the origin from a companion URL with a path', () => {
    const grant = buildServiceWorkerGrant('https://companion.example.com/some/path', {}, 1000)
    expect(grant.companionOrigin).toBe('https://companion.example.com')
  })

  test('sets a bounded expiry after issuedAt', () => {
    const grant = buildServiceWorkerGrant('https://companion.example.com', {}, 1000)
    expect(grant.issuedAt).toBe(1000)
    expect(grant.expiresAt).toBeGreaterThan(grant.issuedAt)
    expect(grant.expiresAt - grant.issuedAt).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  test('grantId is unique per call', () => {
    const a = buildServiceWorkerGrant('https://companion.example.com', {}, 1000)
    const b = buildServiceWorkerGrant('https://companion.example.com', {}, 1000)
    expect(a.grantId).not.toBe(b.grantId)
  })
})
