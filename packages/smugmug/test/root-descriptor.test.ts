/* @vitest-environment jsdom */

import type { PartialTree, PartialTreeFile } from '@uppy/core'
import { render } from 'preact'
import { describe, expect, test, vi } from 'vitest'
import {
  buildSourceRootFromPartialTree,
  checkedFolderRoots,
  resolveSourceRoot,
} from '../src/root-descriptor.js'
import { renderDescriptorModeFooter } from '../src/SmugMug.js'

const tree: PartialTree = [
  { type: 'root', id: null, cached: true, nextPagePath: null },
  {
    type: 'folder',
    id: 'node:R',
    cached: true,
    nextPagePath: null,
    status: 'unchecked',
    parentId: null,
    data: { name: 'Location Vault 2026', icon: 'folder', isFolder: true },
  },
  {
    type: 'folder',
    id: 'album:X',
    cached: true,
    nextPagePath: null,
    status: 'unchecked',
    parentId: 'node:R',
    data: { name: 'HD 1', icon: 'folder', isFolder: true },
  },
]

describe('buildSourceRootFromPartialTree', () => {
  test('returns null at the account root', () => {
    expect(buildSourceRootFromPartialTree(null, tree)).toBeNull()
  })

  test('returns null for an id not present in the tree', () => {
    expect(buildSourceRootFromPartialTree('node:ghost', tree)).toBeNull()
  })

  test('builds a folder root from a node: id', () => {
    expect(buildSourceRootFromPartialTree('node:R', tree)).toEqual({
      schemaVersion: 1,
      provider: 'smugmug',
      kind: 'folder',
      stableId: 'node:R',
      requestPath: 'node:R',
      name: 'Location Vault 2026',
    })
  })

  test('builds an album root from an album: id', () => {
    expect(buildSourceRootFromPartialTree('album:X', tree)).toEqual({
      schemaVersion: 1,
      provider: 'smugmug',
      kind: 'album',
      stableId: 'album:X',
      requestPath: 'album:X',
      name: 'HD 1',
    })
  })

  test('returns null for a file id (not a folder)', () => {
    const fileNode = {
      type: 'file',
      id: 'image:AAA',
      restrictionError: null,
      status: 'unchecked',
      parentId: 'album:X',
      data: { name: 'a.jpg', isFolder: false },
    } as unknown as PartialTreeFile
    expect(
      buildSourceRootFromPartialTree('image:AAA', [...tree, fileNode]),
    ).toBeNull()
  })
})

describe('descriptor-mode footer', () => {
  test('renders an import action that invokes the supplied root callback', () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const container = document.createElement('div')
    render(
      renderDescriptorModeFooter({
        canImport: true,
        onSelect,
        onCancel,
      }),
      container,
    )
    const importButton = container.querySelector('button')

    expect(container.textContent).toContain('Import this album/folder')
    expect(importButton).not.toBeNull()
    importButton?.click()
    expect(onSelect).toHaveBeenCalledOnce()
  })

  test('disables the action when no folder root is selected', () => {
    const container = document.createElement('div')
    render(
      renderDescriptorModeFooter({
        canImport: false,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      container,
    )
    const importButton = container.querySelector('button')

    expect(importButton).not.toBeNull()
    expect(importButton?.disabled).toBe(true)
  })
})

/** `tree` with the folders at `ids` ticked. */
function withChecked(ids: string[]): PartialTree {
  return tree.map((item) =>
    item.type === 'folder' && ids.includes(item.id)
      ? { ...item, status: 'checked' as const }
      : item,
  )
}

describe('resolveSourceRoot', () => {
  test('a ticked folder is the root at the account root, where there is no open folder to fall back to', () => {
    // The reported bug: standing at the account root with `locations/`
    // ticked, the Import button was disabled, because only the *open*
    // folder was ever considered and that is null here.
    const { root, checkedCount } = resolveSourceRoot(
      null,
      withChecked(['node:R']),
    )
    expect(checkedCount).toBe(1)
    expect(root).toMatchObject({ requestPath: 'node:R', kind: 'folder' })
  })

  test('a ticked folder wins over the folder currently open', () => {
    const { root } = resolveSourceRoot('node:R', withChecked(['album:X']))
    expect(root).toMatchObject({ requestPath: 'album:X', kind: 'album' })
  })

  test('falls back to the open folder when nothing is ticked', () => {
    const { root, checkedCount } = resolveSourceRoot('node:R', tree)
    expect(checkedCount).toBe(0)
    expect(root).toMatchObject({ requestPath: 'node:R' })
  })

  test('still refuses the whole account when nothing is ticked', () => {
    expect(resolveSourceRoot(null, tree).root).toBeNull()
  })

  test('reports the count but resolves no root when several folders are ticked', () => {
    const { root, checkedCount } = resolveSourceRoot(
      null,
      withChecked(['node:R', 'album:X']),
    )
    expect(checkedCount).toBe(2)
    expect(root).toBeNull()
  })

  test('ignores checked files — this path selects whole folders only', () => {
    const file: PartialTreeFile = {
      type: 'file',
      id: 'image:1',
      restrictionError: null,
      status: 'checked',
      parentId: 'node:R',
      data: {
        id: 'image:1',
        name: 'a.jpg',
        requestPath: 'image:1',
        isFolder: false,
        mimeType: 'image/jpeg',
      } as never,
    }
    const { root, checkedCount } = resolveSourceRoot(null, [...tree, file])
    expect(checkedCount).toBe(0)
    expect(root).toBeNull()
  })
})

describe('checkedFolderRoots', () => {
  test('excludes partial: that status is a descendant selection, not this folder being chosen', () => {
    const partial = tree.map((item) =>
      item.type === 'folder' && item.id === 'node:R'
        ? { ...item, status: 'partial' as const }
        : item,
    )
    expect(checkedFolderRoots(partial)).toEqual([])
  })

  test('returns every ticked folder, in tree order', () => {
    expect(
      checkedFolderRoots(withChecked(['album:X', 'node:R'])).map(
        (r) => r.requestPath,
      ),
    ).toEqual(['node:R', 'album:X'])
  })
})
