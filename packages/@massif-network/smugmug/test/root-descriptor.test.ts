import { describe, expect, test } from 'vitest'
import type { PartialTree, PartialTreeFile } from '@uppy/core'
import { buildSourceRootFromPartialTree } from '../src/root-descriptor.js'

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
    expect(buildSourceRootFromPartialTree('image:AAA', [...tree, fileNode])).toBeNull()
  })
})
