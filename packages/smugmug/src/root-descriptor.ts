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
 * Drop any ticked folder that already sits under another ticked folder.
 *
 * Ticking a folder and one of its descendants would enumerate the
 * descendant twice. Distinct roots normally can't collide — Massif's
 * `occurrenceId` is `${root}::${path}`, so sibling roots produce disjoint
 * ids — but a nested pair yields the same file under two roots, and
 * `resolveFileId` is session-scoped and deterministic, so the engine's
 * ingest would hard-error on the duplicate file id. The ancestor already
 * covers the descendant, so keeping only the ancestor loses nothing.
 */
function dropNestedRoots(
  partialTree: PartialTree,
  checkedIds: Set<string>,
): (id: string) => boolean {
  const parentOf = new Map<string, PartialTreeId>()
  for (const item of partialTree) {
    if (item.type === 'folder') parentOf.set(item.id, item.parentId)
  }
  return (id: string) => {
    let cursor = parentOf.get(id) ?? null
    while (cursor !== null) {
      if (checkedIds.has(cursor)) return false
      cursor = parentOf.get(cursor) ?? null
    }
    return true
  }
}

/**
 * Resolve the import roots the "Import" action should use.
 *
 * Two ways to designate them, in priority order:
 *
 * 1. **Tick them.** Every checked folder is a root, wherever you are —
 *    including at the account root, where there is nothing to fall back to.
 *    This is the selection model every sibling provider
 *    (Dropbox/Drive/OneDrive) already uses in the same Dashboard, and the
 *    one the "Bulk import locations" banner describes: *each selected
 *    folder will be imported as its own location*.
 * 2. **Open one.** With nothing ticked, the folder you have navigated into
 *    is the single root.
 *
 * Returns `[]` at the account root with nothing ticked: that node has no
 * stable provider id and is far too broad an import target. That guard is
 * deliberate — do not relax it.
 *
 * Note these two routes are equivalent by design, not by accident. Ticking
 * every child of a folder and ticking the folder itself both end up
 * importing the same files, because a `folder` root already fans out to one
 * location per child album downstream (Massif's `locationKeyFor` keys on the
 * top segment of each file's relative path).
 *
 * Must NOT lead to `ProviderViews.donePicking()` — that recursively drains
 * every checked folder via `afterFill` and materializes every descendant
 * into Uppy, exactly the heap defect this path exists to avoid.
 */
export function resolveSourceRoots(
  currentFolderId: PartialTreeId,
  partialTree: PartialTree,
): SmugMugSourceRoot[] {
  const checked = checkedFolderRoots(partialTree)
  if (checked.length > 0) {
    const ids = new Set(checked.map((r) => r.requestPath))
    return checked.filter((r) =>
      dropNestedRoots(partialTree, ids)(r.requestPath),
    )
  }
  const open = buildSourceRootFromPartialTree(currentFolderId, partialTree)
  return open === null ? [] : [open]
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
