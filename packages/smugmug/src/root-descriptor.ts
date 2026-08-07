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

function toRoot(node: {
  id: string
  data: { name?: string }
}): SmugMugSourceRoot {
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

/**
 * Every folder the user has ticked, in tree order. Files are ignored: this
 * path selects whole albums/folders and hands the walk to the Service
 * Worker's bounded enumerator, so an individually-checked file has no
 * meaning here. `'partial'` is excluded too — that status only means some
 * descendant is checked, which is the descendant's selection, not this
 * folder's.
 */
export function checkedFolderRoots(
  partialTree: PartialTree,
): SmugMugSourceRoot[] {
  return partialTree
    .filter((item) => item.type === 'folder' && item.status === 'checked')
    .map((item) => toRoot(item as { id: string; data: { name?: string } }))
}

/**
 * Resolve the import root the "Import this album/folder" action should use.
 *
 * Two ways to designate one, in priority order:
 *
 * 1. **Tick it.** A checked folder is the root, wherever you are — including
 *    at the account root, where there is nothing to fall back to. This is
 *    the selection model every sibling provider (Dropbox/Drive/OneDrive)
 *    already uses, and the one the "Bulk import locations" banner describes.
 * 2. **Open it.** With nothing ticked, the folder you have navigated into is
 *    the root.
 *
 * Returns `null` at the account root with nothing ticked: that node has no
 * stable provider id and is far too broad an import target. That guard is
 * deliberate — do not relax it.
 *
 * Only ever ONE root. A `folder` root already fans out to one location per
 * child album downstream (see Massif's `locationKeyFor`), so ticking several
 * siblings is served by importing their shared parent instead; returning
 * several roots here would mean several import sessions, which the caller
 * has no way to represent. `checkedCount` lets the caller say so rather than
 * silently importing whichever one happened to sort first.
 *
 * Must NOT lead to `ProviderViews.donePicking()` — that recursively drains
 * every checked folder via `afterFill` and materializes every descendant
 * into Uppy, exactly the heap defect this path exists to avoid.
 */
export function resolveSourceRoot(
  currentFolderId: PartialTreeId,
  partialTree: PartialTree,
): { root: SmugMugSourceRoot | null; checkedCount: number } {
  const checked = checkedFolderRoots(partialTree)
  if (checked.length > 0) {
    return {
      root: checked.length === 1 ? checked[0]! : null,
      checkedCount: checked.length,
    }
  }
  return {
    root: buildSourceRootFromPartialTree(currentFolderId, partialTree),
    checkedCount: 0,
  }
}

/**
 * Build a root descriptor from the currently-open folder in
 * `ProviderViews`' partial tree, without expanding its children. Returns
 * `null` at the account root (`type: 'root'`), which has no stable provider
 * id of its own.
 *
 * Prefer `resolveSourceRoot` — this only covers the navigate-into half.
 */
export function buildSourceRootFromPartialTree(
  currentFolderId: PartialTreeId,
  partialTree: PartialTree,
): SmugMugSourceRoot | null {
  if (currentFolderId === null) return null
  const node = partialTree.find((item) => item.id === currentFolderId)
  if (node === undefined || node.type !== 'folder') return null
  return toRoot(node)
}
