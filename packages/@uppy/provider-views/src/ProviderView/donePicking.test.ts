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

// top/ a.jpg b.jpg  +  top/sub/ c.jpg  +  top/empty/ (walked, and empty)
const items = (path: string | null) => {
  if (path === 'top') {
    return [cFile('a'), cFile('b'), cFolder('sub'), cFolder('empty')]
  }
  if (path === 'sub') return [cFile('c')]
  // Walked and genuinely empty: its instalment carries a folder record and no
  // files, which is the case the empty-batch guard is about.
  if (path === 'empty') return []
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

/**
 * @param stream deliver `streamWalkedFiles` the way a caller CAN'T in practice —
 * straight to the view.
 * @param streamViaPlugin deliver it the way an embedder actually does: to the
 * plugin, via `uppy.use(SmugMug, { … })`. Every provider plugin builds its
 * `ProviderView` from a fixed option list and drops the rest, so this is the
 * only route that exists outside a unit test.
 */
const setup = ({
  stream,
  streamViaPlugin = false,
}: {
  stream: boolean
  streamViaPlugin?: boolean
}) => {
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
    opts: {
      companionUrl: 'https://companion.test',
      ...(streamViaPlugin ? { streamWalkedFiles: true } : {}),
    },
  }

  let state: Record<string, unknown> = {}

  const view = new ProviderView(plugin as never, {
    provider: provider as never,
    // Set only when true. An explicit `false` is not nullish, so it would
    // suppress the plugin-opts fallback — and no real caller passes one.
    ...(stream ? { streamWalkedFiles: true } : {}),
  })
  // `resetPluginState()` in the constructor seeded the default tree; replace it
  // with one checked, uncached folder so `afterFill` has something to walk.
  // Callable again to re-pick the same selection on the same Uppy instance,
  // which is how a file becomes a duplicate.
  const seed = () => {
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
  }
  seed()

  return { uppy, view, provider, plugin, seed }
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

  it('reports duplicates once for the selection, not once per instalment', async () => {
    const { uppy, view, seed } = setup({ stream: true })

    await view.donePicking()
    // a.jpg, b.jpg, sub/c.jpg — `empty/` contributes none.
    expect(uppy.getFiles()).toHaveLength(3)

    const info = vi.spyOn(uppy, 'info')
    // The same folder picked a second time: every file the walk streams is
    // already on the instance, so every instalment is entirely duplicates.
    seed()
    await view.donePicking()

    const notices = info.mock.calls.map(([message]) => String(message))
    // `quiet` silences the per-instalment notice, so without an aggregate the
    // user is told nothing at all about a selection that added nothing.
    expect(notices).toEqual(['Not adding 3 duplicate files'])
    expect(uppy.getFiles()).toHaveLength(3)
  })

  it('streams when the option was given to the PLUGIN, not the view', async () => {
    // The route every embedder uses — `uppy.use(SmugMug, { streamWalkedFiles })`
    // — and the one no other test covers: the plugin passes a fixed option list
    // to `new ProviderView`, so the flag is dropped before the view ever sees
    // it, and the walk silently falls back to the one-shot path.
    const { uppy, view } = setup({ stream: false, streamViaPlugin: true })
    const statuses: string[] = []
    uppy.on('provider-walk-batch', (batch) => statuses.push(batch.status))

    await view.donePicking()

    expect(statuses[0]).toBe('started')
    expect(statuses).toContain('streaming')
    expect(statuses.at(-1)).toBe('complete')
  })

  it('does not let the panel close reset the state under a running walk', async () => {
    const { uppy, view, plugin } = setup({ stream: true })
    // Dashboard hides its panels on `file-added`, which emits this. The abort
    // wiring already ignores it; the constructor's `resetPluginState` listener
    // did not — and it blanks `didFirstRender`, so the next `render` bootstraps
    // `openFolder`, whose own abort controller kills the walk.
    const survivedClose: unknown[] = []
    uppy.on('file-added', () => {
      plugin.setPluginState({ didFirstRender: true })
      // @ts-expect-error Dashboard's event, not declared by core.
      uppy.emit('dashboard:close-panel', 'TestProvider')
      // Sampled HERE, not after `donePicking`: the reset at the end of a
      // finished walk is legitimate and would mask this one.
      survivedClose.push(plugin.getPluginState().didFirstRender)
    })

    const statuses: string[] = []
    uppy.on('provider-walk-batch', (batch) => statuses.push(batch.status))

    await view.donePicking()

    // A false `didFirstRender` is the whole mechanism: nothing aborts at this
    // point, the NEXT render does — which is why no unit test caught it.
    expect(survivedClose.length).toBeGreaterThan(0)
    expect(survivedClose.every((v) => v === true)).toBe(true)
    expect(statuses.at(-1)).toBe('complete')
  })

  it('stops listening for the panel close once torn down', async () => {
    const { uppy, view, plugin } = setup({ stream: true })
    plugin.setPluginState({ didFirstRender: true })

    // Provider plugins call this on uninstall. The listener is registered in
    // the constructor, so without an explicit `off` an uninstalled view keeps
    // resetting plugin state — and a reinstall stacks another one on top.
    view.tearDown()
    // @ts-expect-error Dashboard's event, not declared by core.
    uppy.emit('dashboard:close-panel', 'TestProvider')

    expect(plugin.getPluginState().didFirstRender).toBe(true)
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

  it('still reports aborted when the files cannot be taken back', async () => {
    const { uppy, view } = setup({ stream: true })
    const statuses: string[] = []
    uppy.on('provider-walk-batch', (batch) => statuses.push(batch.status))

    // `Uppy.removeFiles` throws when the removal would partly empty an upload
    // already running under an uploader without `individualCancellation`.
    uppy.removeFiles = () => {
      throw new Error(
        'The installed uploader plugin does not allow removing files during an upload.',
      )
    }
    uppy.on('file-added', () => {
      uppy.emit('cancel-all')
    })

    // The host has already built a plan on the streamed files, so what it needs
    // is to be TOLD the selection is void. Letting the failed cleanup throw
    // would swallow that and leave the plan standing.
    await expect(view.donePicking()).resolves.toBeUndefined()
    expect(statuses.at(-1)).toEqual('aborted')
  })

  it('counts what Uppy took, not what the walk offered', async () => {
    // A provider repeating an item across a page boundary — the pages are
    // drained into ONE listing, so the folder offers the same file twice and
    // Uppy keeps one. (Its id is name + type + relativePath + size, so two
    // items only collide when they are genuinely the same file.)
    const paged = (path: string | null) => {
      if (path === 'top') {
        return { nextPagePath: 'top-page-2', items: [cFile('a')] }
      }
      if (path === 'top-page-2') {
        return { nextPagePath: null, items: [cFile('a')] }
      }
      return null
    }

    const { uppy, view, provider } = setup({ stream: true })
    const counts: number[] = []
    uppy.on('provider-walk-batch', (batch) => counts.push(batch.fileCount))
    provider.list.mockImplementation(
      (path: string | null) =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            const found = paged(path)
            if (found) resolve(found)
            else reject(new Error(`unexpected list: ${path}`))
          }, 0)
        }),
    )

    await view.donePicking()

    // Reporting the offered count would tell the host two files arrived in a
    // folder that produced one, and inflate the "Added N files" notice.
    expect(uppy.getFiles()).toHaveLength(1)
    expect(counts.reduce((total, n) => total + n, 0)).toEqual(1)
  })

  it('does not push an empty batch through Uppy', async () => {
    const { uppy, view } = setup({ stream: true })
    const addFiles = vi.spyOn(uppy, 'addFiles')

    await view.donePicking()

    // `sub2` is walked and empty, so its instalment carries folders but no
    // files. `Uppy.addFiles([])` still clones the whole file set into a
    // `setState` and emits `files-added`, re-rendering every subscriber for no
    // change — one call per empty folder is exactly the cost the flush cadence
    // exists to keep rare.
    expect(addFiles).toHaveBeenCalledTimes(2)
    expect(addFiles.mock.calls.every(([files]) => files.length > 0)).toBe(true)
  })
})
