import { describe, expect, test } from 'vitest'
import { createMemoryStore } from '../src/memory-store.js'

describe('createMemoryStore', () => {
  test('round-trips a value', async () => {
    const store = createMemoryStore()
    await store.setItem('k', 'v')
    expect(await store.getItem('k')).toBe('v')
  })

  test('returns null for a missing key', async () => {
    const store = createMemoryStore()
    expect(await store.getItem('missing')).toBeNull()
  })

  test('removeItem clears the value', async () => {
    const store = createMemoryStore()
    await store.setItem('k', 'v')
    await store.removeItem('k')
    expect(await store.getItem('k')).toBeNull()
  })

  test('two instances do not share state', async () => {
    const a = createMemoryStore()
    const b = createMemoryStore()
    await a.setItem('k', 'a-value')
    expect(await b.getItem('k')).toBeNull()
  })
})
