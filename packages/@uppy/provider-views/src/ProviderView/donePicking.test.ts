import Uppy from '@uppy/core'
import type { CompanionFile } from '@uppy/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProviderView from './ProviderView.js'

const CLOCK = Symbol.for('uppy test: walkFlushClock')

/**
 * These cover `donePicking` end to end against a real Uppy instance, because
 * the thing worth protecting here is an INTERACTION between packages —
 * Dashboard's `file-added` → `hideAllPanels` → `dashboard:close-panel` versus
 * this view's own abort wiring. A unit test of `afterFill` cannot see it.
 */

const cFile = (id: string): CompanionFile =>
  ({ id, requestPath: id, name: `${id}.jpg`, isFolder: false }) as CompanionFile

const cFolder = (id: string): CompanionFile =>
  ({ id, requestPath: id, name: id, isFolder: true }) as CompanionFile

// top/ a.jpg b.jpg  +  top/sub/ c.jpg
const items = (path: string | null) => {
  if (path === 'top') return [cFile('a'), cFile('b'), cFolder('sub')]
  if (path === 'sub') return [cFile('c')]
  return null
}

/**
 * Resolves on a macrotask, and honours the abort signal at that point — like
 * the real `provider.list`, which is a `fetch`. Resolving synchronously would
 * make the cancellation test vacuous: every listing would already be finished
 * before anything could abort it.
 */
const list = (path: string | null, options?: { signal?: AbortSignal }) =>
  new Promise<{ nextPagePath: string | null; items: CompanionFile[] }>(
    (resolve, reject) => {
      setTimeout(() => {
        if (options?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        const found = items(path)
        if (!found) {
          reject(new Error(`unexpected list: ${path}`))
          return
        }
        resolve({ nextPagePath: null, items: found })
      }, 0)
    },
  )

const setup = ({ stream }: { stream: boolean }) => {
  const uppy = new Uppy({ autoProceed: false })
  const provider = {
    provider: 'test',
    name: 'Test',
    list: vi.fn(list),
    fileUrl: (path: string) => `https://companion.test/test/get/${path}`,
  }

  const plugin = {
    id: 'TestProvider',
    uppy,
    rootFolderId: null,
    title: 'Test',
    files: [],
    icon: () => null,
    getPluginState: () => state,
    setPluginState: (patch: Record<string, unknown>) => {
      state = { ...state, ...patch }
    },
    opts: { companionUrl: 'https://companion.test' },
  }

  let state: Record<string, unknown> = {}

  const view = new ProviderView(plugin as never, {
    provider: provider as never,
    streamWalkedFiles: stream,
  })
  // `resetPluginState()` in the constructor seeded the default tree; replace it
  // with one checked, uncached folder so `afterFill` has something to walk.
  plugin.setPluginState({
    partialTree: [
      { type: 'root', id: null, cached: false, nextPagePath: null },
      {
        type: 'folder',
        id: 'top',
        parentId: null,
        cached: false,
        nextPagePath: null,
        status: 'checked',
        data: cFolder('top'),
      },
    ],
  })

  return { uppy, view, provider }
}

describe('donePicking() streaming', () => {
  beforeEach(() => {
    // Always past the flush interval, so each walked folder is handed over as
    // it lands. With the real clock this whole mocked walk finishes inside the
    // 250ms floor and everything arrives in one instalment AFTER the walk —
    // which would make every test below assert nothing about streaming.
    let t = 0
    ;(ProviderView as unknown as Record<symbol, unknown>)[CLOCK] = () => {
      t += 1000
      return t
    }
  })

  afterEach(() => {
    ;(ProviderView as unknown as Record<symbol, unknown>)[CLOCK] = undefined
  })

  it('is not cancelled by the panel closing behind its own first instalment', async () => {
    const { uppy, view } = setup({ stream: true })

    // Exactly what Dashboard does: it listens to `file-added` with
    // `hideAllPanels`, which closes the acquirer panel and emits this. Streaming
    // calls `addFiles` from INSIDE the walk, so the first instalment triggers
    // it — and the walk it aborts is the one that produced it.
    uppy.on('file-added', () => {
      // @ts-expect-error Dashboard's event, not declared by core.
      uppy.emit('dashboard:close-panel', 'TestProvider')
    })

    const statuses: string[] = []
    uppy.on('provider-walk-batch', (batch) => statuses.push(batch.status))

    await view.donePicking()

    // More than one streaming instalment, so the close above really did land
    // mid-walk. Without this the test would still pass on a walk that only ever
    // delivered once, at the end — where a cancellation is harmless.
    expect(statuses.filter((s) => s === 'streaming').length).toBeGreaterThan(1)
    expect(statuses.at(-1)).toEqual('complete')
    expect(
      uppy
        .getFiles()
        .map((f) => f.name)
        .sort(),
    ).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  it('is still cancelled by cancel-all', async () => {
    const { uppy, view } = setup({ stream: true })
    const statuses: string[] = []
    uppy.on('provider-walk-batch', (batch) => statuses.push(batch.status))

    uppy.on('file-added', () => {
      uppy.emit('cancel-all')
    })

    await view.donePicking()

    // Everything the walk streamed is taken back, and the host is told, so it
    // does not sit on a plan describing files that no longer exist.
    //
    // Note this is NOT delivered as a thrown abort: `afterFill` discards the
    // promises from its queue, so a cancelled listing leaves a partial tree and
    // the walk returns normally. Only the terminal progress report — folders
    // queued but never walked — distinguishes it from a clean finish.
    expect(statuses.at(-1)).toEqual('aborted')
    expect(uppy.getFiles()).toEqual([])
  })

  it('reports the walk lifecycle around the instalments', async () => {
    const { uppy, view } = setup({ stream: true })
    const statuses: string[] = []
    uppy.on('provider-walk-batch', (batch) => statuses.push(batch.status))

    await view.donePicking()

    expect(statuses[0]).toEqual('started')
    expect(statuses.at(-1)).toEqual('complete')
    expect(uppy.getFiles()).toHaveLength(3)
  })

  it('adds everything at the end when streaming is off', async () => {
    const { uppy, view } = setup({ stream: false })
    const batches: unknown[] = []
    uppy.on('provider-walk-batch', (batch) => batches.push(batch))

    await view.donePicking()

    expect(batches).toEqual([])
    expect(uppy.getFiles()).toHaveLength(3)
  })
})
