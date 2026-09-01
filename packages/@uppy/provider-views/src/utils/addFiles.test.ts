import type { CompanionFile } from '@uppy/utils'
import { getSafeFileId } from '@uppy/utils'
import { describe, expect, it, vi } from 'vitest'
import addFiles from './addFiles.js'

const cFile = (id: string): CompanionFile =>
  ({ id, requestPath: id, name: `${id}.jpg`, isFolder: false }) as CompanionFile

/**
 * A fake Uppy that keys files the way the real one does — by whatever
 * `getSafeFileId` returned inside `addFiles` — so the tests never re-derive an
 * id of their own. `taken` decides which of the offered ids it admits to
 * holding afterwards, which is the whole point: Uppy drops a file that fails a
 * restriction WITHOUT throwing, so offered and held are not the same set.
 */
const setup = ({ taken }: { taken?: (_ids: string[]) => Set<string> } = {}) => {
  const offered: string[][] = []
  const held = new Set<string>()
  const uppy = {
    getID: () => 'uppy',
    i18n: (_key: string, opts: { numFiles: number }) =>
      `added ${opts.numFiles}`,
    info: vi.fn(),
    checkIfFileAlreadyExists: (id: string) => held.has(id),
    addFiles: (files: { id: string }[]) => {
      // The real Uppy keys a file by `getSafeFileId`, not by the id the
      // descriptor arrives with. The fake has to agree, or `getFile` below
      // would answer for an id nothing was ever stored under.
      const ids = files.map((f) => getSafeFileId(f as never, 'uppy'))
      offered.push(ids)
      const keep = taken ? taken(ids) : new Set(ids)
      for (const id of ids) if (keep.has(id)) held.add(id)
    },
    getFile: (id: string) => (held.has(id) ? { id } : undefined),
  }
  const plugin = { id: 'TestProvider', uppy, opts: { companionUrl: 'x' } }
  const provider = {
    provider: 'test',
    name: 'Test',
    fileUrl: (p: string) => `https://companion.test/${p}`,
  }
  return { uppy, plugin, provider, offered }
}

describe('addFiles()', () => {
  it('reports only the ids Uppy actually took', () => {
    let seen: string[] = []
    const { plugin, provider } = setup({
      taken: (ids) => {
        seen = ids
        // Uppy rejects the middle one on a restriction, silently.
        return new Set([ids[0], ids[2]])
      },
    })
    const onAdded = vi.fn()

    addFiles(
      [cFile('a'), cFile('b'), cFile('c')],
      plugin as never,
      provider as never,
      {
        onAdded,
      },
    )

    // Reporting the rejected one would over-count the "Added N files" notice
    // and the `provider-walk-batch` payload, and would hand a stale id to the
    // `removeFiles` that undoes an aborted walk.
    expect(seen).toHaveLength(3)
    expect(onAdded).toHaveBeenCalledWith([seen[0], seen[2]])
  })

  it('counts the "Added N files" notice from what Uppy took', () => {
    const { plugin, provider, uppy } = setup({
      // Two of the three fail a restriction, silently.
      taken: (ids) => new Set([ids[1]]),
    })

    addFiles(
      [cFile('a'), cFile('b'), cFile('c')],
      plugin as never,
      provider as never,
    )

    const notices = uppy.info.mock.calls.map(([text]) => text)
    expect(notices).toContain('added 1')
    expect(notices).not.toContain('added 3')
  })

  it('says nothing when Uppy took none of them', () => {
    const { plugin, provider, uppy } = setup({ taken: () => new Set<string>() })

    addFiles([cFile('a'), cFile('b')], plugin as never, provider as never)

    // Offering two and having both rejected is not "Added 2 files", and it is
    // not "Added 0 files" either — there is nothing to tell the user here, and
    // the restriction failures raise their own errors.
    expect(uppy.info).not.toHaveBeenCalled()
  })

  it('never offers a file the instance already holds', () => {
    const { plugin, provider, offered } = setup()
    const onAdded = vi.fn()

    addFiles([cFile('a')], plugin as never, provider as never, { onAdded })
    addFiles([cFile('a'), cFile('b')], plugin as never, provider as never, {
      onAdded,
    })

    // A streaming walk re-offers nothing, but `donePicking`'s final pass hands
    // over the whole checked set — anything the walk already streamed has to
    // fall out here rather than be added twice.
    expect(offered[1]).toHaveLength(1)
    expect(offered[1][0]).not.toEqual(offered[0][0])
    expect(onAdded).toHaveBeenLastCalledWith(offered[1])
  })

  it('does not bother Uppy when nothing survives the filtering', () => {
    const { plugin, provider, offered } = setup()
    const onAdded = vi.fn()

    addFiles([cFile('a')], plugin as never, provider as never)
    // Every file in this batch is already on the instance — what a re-served
    // page looks like — so there is nothing left to add.
    addFiles([cFile('a')], plugin as never, provider as never, { onAdded })

    // `Uppy.addFiles([])` still clones the whole file set into a `setState` and
    // emits `files-added`, re-rendering every subscriber for no change.
    expect(offered).toHaveLength(1)
    expect(onAdded).toHaveBeenCalledWith([])
  })

  it('does not bother Uppy with an empty batch at all', () => {
    const { plugin, provider, offered } = setup()

    addFiles([], plugin as never, provider as never)

    expect(offered).toEqual([])
  })

  it('does not tell the user a batch duplicate "already exists"', () => {
    const { plugin, provider, uppy } = setup()

    // Both copies arrive in ONE batch, so the second is skipped because the
    // first just claimed its id — not because it was already on the instance.
    addFiles([cFile('a'), cFile('a')], plugin as never, provider as never)

    const notices = uppy.info.mock.calls.map(([text]) => text)
    expect(notices).toContain('Not adding 1 duplicate files')
    expect(notices.join(' ')).not.toContain('already exist')
  })

  it('stays silent when asked to', () => {
    // A streaming walk calls this dozens of times for ONE user action; the
    // single notice for the whole selection is the caller's to emit.
    const { plugin, provider, uppy } = setup()

    addFiles([cFile('a')], plugin as never, provider as never, { quiet: true })
    expect(uppy.info).not.toHaveBeenCalled()

    addFiles([cFile('b')], plugin as never, provider as never)
    expect(uppy.info).toHaveBeenCalledOnce()
  })
})
