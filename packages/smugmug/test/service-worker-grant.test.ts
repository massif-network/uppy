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
    expect(grant.headers).toEqual({
      'uppy-auth-token': 'tok',
      'uppy-credentials-params': 'params',
    })
  })

  test('omits headers that were not present', () => {
    const grant = buildServiceWorkerGrant(
      'https://companion.example.com',
      { 'uppy-auth-token': 'tok' },
      1000,
    )
    expect(grant.headers).toEqual({ 'uppy-auth-token': 'tok' })
    expect('uppy-credentials-params' in grant.headers).toBe(false)
  })
  test('rejects an empty header set', () => {
    expect(() =>
      buildServiceWorkerGrant('https://companion.example.com', {}, 1000),
    ).toThrow(/at least one/i)
  })

  test('rejects a header set with no allowed headers', () => {
    expect(() =>
      buildServiceWorkerGrant(
        'https://companion.example.com',
        { cookie: 'session=abc' },
        1000,
      ),
    ).toThrow(/at least one/i)
  })

  test('rejects malformed allowlisted header values', () => {
    expect(() =>
      buildServiceWorkerGrant(
        'https://companion.example.com',
        { 'uppy-auth-token': '' },
        1000,
      ),
    ).toThrow(/header/i)
  })

  test('rejects a non-HTTPS companion origin', () => {
    expect(() =>
      buildServiceWorkerGrant(
        'http://companion.example.com',
        { 'uppy-auth-token': 'tok' },
        1000,
      ),
    ).toThrow(/https/i)
  })

  test('rejects an invalid companion URL', () => {
    expect(() =>
      buildServiceWorkerGrant('not a url', { 'uppy-auth-token': 'tok' }, 1000),
    ).toThrow(/companion origin|url/i)
  })

  test('sets a bounded expiry after issuedAt', () => {
    const grant = buildServiceWorkerGrant(
      'https://companion.example.com',
      { 'uppy-auth-token': 'tok' },
      1000,
    )
    expect(grant.issuedAt).toBe(1000)
    expect(grant.expiresAt).toBeGreaterThan(grant.issuedAt)
    expect(grant.expiresAt - grant.issuedAt).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  test('grantId is unique per call', () => {
    const a = buildServiceWorkerGrant(
      'https://companion.example.com',
      { 'uppy-auth-token': 'tok' },
      1000,
    )
    const b = buildServiceWorkerGrant(
      'https://companion.example.com',
      { 'uppy-auth-token': 'tok' },
      1000,
    )
    expect(a.grantId).not.toBe(b.grantId)
  })
})
