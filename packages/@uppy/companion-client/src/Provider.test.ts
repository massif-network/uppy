import { afterEach, describe, expect, it, vi } from 'vitest'
import Provider from './Provider.js'

const mockCore = { getState: () => ({}), log: () => {}, info: () => {} } as any

describe('Provider#authUrl', () => {
  it('includes whatever is in the query param, e.g. extraAuthQueryParams merged in by the caller', () => {
    const provider = new Provider(mockCore, {
      pluginId: 'test',
      provider: 'smugmug',
      companionUrl: 'http://companion.uppy.io',
    })

    const link = provider.authUrl({
      authFormData: undefined,
      query: { massifUserId: 'user-123' },
    })
    const params = new URL(link).searchParams

    expect(link.startsWith('http://companion.uppy.io/smugmug/connect?')).toBe(
      true,
    )
    expect(params.get('massifUserId')).toBe('user-123')
  })

  it('cannot let a query param clobber protocol-critical params', () => {
    const provider = new Provider(mockCore, {
      pluginId: 'test',
      provider: 'smugmug',
      companionUrl: 'http://companion.uppy.io',
    })

    const link = provider.authUrl({
      authFormData: undefined,
      query: { state: 'attacker-controlled' },
    })
    const params = new URL(link).searchParams
    // `state` is set by authUrl itself, after `query`, specifically so a
    // caller-supplied query param (including one merged in from
    // extraAuthQueryParams) can never override it.
    expect(params.get('state')).not.toBe('attacker-controlled')
  })
})

describe('Provider#login wiring extraAuthQueryParams onto the popup URL', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // @ts-expect-error test-only global override
    delete global.WebSocket
  })

  it('merges opts.extraAuthQueryParams into the URL passed to window.open', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    // Minimal fake: never emits, so the wrapped promise just waits until we
    // abort it below. We only need window.open's argument, captured
    // synchronously before this constructor is ever reached.
    class FakeWebSocket {
      addEventListener() {}
      close() {}
    }
    // @ts-expect-error test-only global override
    global.WebSocket = FakeWebSocket

    const provider = new Provider(mockCore, {
      pluginId: 'test',
      provider: 'smugmug',
      companionUrl: 'http://companion.uppy.io',
      extraAuthQueryParams: { massifUserId: 'user-123' },
    })

    const controller = new AbortController()
    const loginPromise = provider.login({
      uppyVersions: '1.0.0',
      authFormData: undefined,
      signal: controller.signal,
    })
    // Let loginOAuth run past its `await this.ensurePreAuth()` and reach
    // `window.open` before we inspect the spy or tear the flow down.
    await Promise.resolve()
    await Promise.resolve()

    expect(openSpy).toHaveBeenCalledTimes(1)
    const openedUrl = openSpy.mock.calls[0]?.[0] as string
    expect(new URL(openedUrl).searchParams.get('massifUserId')).toBe(
      'user-123',
    )

    controller.abort()
    await expect(loginPromise).rejects.toThrow()
  })
})
