import type { PartialTree, PartialTreeId } from '@uppy/core'

/**
 * One selected SmugMug album/folder, handed to the Massif Service Worker as
 * an import root. Mirrors Massif's `SmugMugSourceRoot` wire shape without
 * importing it, since this package must stay independent of the Massif app.
 */
export type SmugMugSourceRoot = {
  schemaVersion: 1
  provider: 'smugmug'
  kind: 'album' | 'folder'
  stableId: string
  requestPath: string
  name: string
}

/**
 * Build a root descriptor from the currently-open folder in
 * `ProviderViews`' partial tree, without expanding its children. The
 * account root (`type: 'root'`) has no stable provider id of its own and is
 * too broad an import target, so it returns `null` — the user must first
 * navigate into a specific album or folder.
 *
 * This is the "Import this album/folder" action: it must NOT call
 * `ProviderViews.donePicking()` (which recursively drains every checked
 * folder via `afterFill` and materializes every descendant into Uppy —
 * exactly the heap defect this path exists to avoid).
 */
export function buildSourceRootFromPartialTree(
  currentFolderId: PartialTreeId,
  partialTree: PartialTree,
): SmugMugSourceRoot | null {
  if (currentFolderId === null) return null
  const node = partialTree.find((item) => item.id === currentFolderId)
  if (node === undefined || node.type !== 'folder') return null

  const requestPath = node.id
  const kind = requestPath.startsWith('album:') ? 'album' : 'folder'
  return {
    schemaVersion: 1,
    provider: 'smugmug',
    kind,
    stableId: requestPath,
    requestPath,
    name: node.data.name ?? requestPath,
  }
}
