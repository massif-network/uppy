import type {
  PartialTree,
  PartialTreeFile,
  PartialTreeFolderNode,
  PartialTreeId,
} from '@uppy/core'
import type { CompanionFile } from '@uppy/utils'
// p-queue does not have a `"main"` field in its `package.json`, and that makes `import/no-unresolved` freak out.
// We can safely ignore it because bundlers will happily use the `"exports"` field instead.
import PQueue from 'p-queue'
import shallowClone from './shallowClone.js'

export type ApiList = (directory: PartialTreeId) => Promise<{
  nextPagePath: PartialTreeId
  items: CompanionFile[]
}>

/**
 * Progress of a recursive provider folder walk.
 *
 * There is deliberately no percentage: the tree's size is unknown until the walk
 * finishes, so the only honest figures are how much has been found so far and how
 * many folders are still queued. `foldersRemaining` reaching 0 is the end.
 */
export type WalkProgress = {
  /** Files discovered and selected so far. */
  filesFound: number
  /** Folders whose listing has completed. */
  foldersWalked: number
  /** Folders still queued or in flight. */
  foldersRemaining: number
}

const recursivelyFetch = async (
  queue: PQueue,
  poorTree: PartialTree,
  poorFolder: PartialTreeFolderNode,
  apiList: ApiList,
  validateSingleFile: (file: CompanionFile) => string | null,
  counters: {
    filesFound: number
    foldersWalked: number
    foldersQueued: number
  },
) => {
  let items: CompanionFile[] = []
  let currentPath: PartialTreeId = poorFolder.cached
    ? poorFolder.nextPagePath
    : poorFolder.id
  while (currentPath) {
    const response = await apiList(currentPath)
    items = items.concat(response.items)
    currentPath = response.nextPagePath
  }

  const newFolders = items.filter((i) => i.isFolder === true)
  const newFiles = items.filter((i) => i.isFolder === false)

  const folders: PartialTreeFolderNode[] = newFolders.map((folder) => ({
    type: 'folder',
    id: folder.requestPath,

    cached: false,
    nextPagePath: null,

    status: 'checked',
    parentId: poorFolder.id,
    data: folder,
  }))
  const files: PartialTreeFile[] = newFiles.map((file) => {
    const restrictionError = validateSingleFile(file)
    return {
      type: 'file',
      id: file.requestPath,

      restrictionError,

      status: restrictionError ? 'unchecked' : 'checked',
      parentId: poorFolder.id,
      data: file,
    }
  })

  poorFolder.cached = true
  poorFolder.nextPagePath = null
  poorTree.push(...files, ...folders)

  // Counted incrementally. Re-deriving this by filtering `poorTree` on every
  // completed folder is O(tree) per event, which is quadratic over a large walk
  // — the exact cost this progress reporting exists to make visible.
  counters.foldersWalked += 1
  for (const file of files) {
    if (file.status === 'checked') counters.filesFound += 1
  }

  folders.forEach(async (folder) => {
    counters.foldersQueued += 1
    queue.add(() =>
      recursivelyFetch(
        queue,
        poorTree,
        folder,
        apiList,
        validateSingleFile,
        counters,
      ),
    )
  })
}

const afterFill = async (
  partialTree: PartialTree,
  apiList: ApiList,
  validateSingleFile: (file: CompanionFile) => string | null,
  reportProgress: (progress: WalkProgress) => void,
): Promise<PartialTree> => {
  const queue = new PQueue({ concurrency: 6 })

  // fill up the missing parts of a partialTree!
  const poorTree: PartialTree = shallowClone(partialTree)

  // Seeded from what is ALREADY checked, then incremented as new files arrive.
  // A partial tree can carry checked files from folders the user opened earlier
  // (they are `cached`, so this walk never revisits them). Starting from zero
  // would under-report the real selection in every event, including the final
  // one. Counted once here — the per-event cost stays O(1), which is the point.
  const counters = {
    filesFound: poorTree.filter(
      (item) => item.type === 'file' && item.status === 'checked',
    ).length,
    foldersWalked: 0,
    foldersQueued: 0,
  }
  const poorFolders = poorTree.filter(
    (item) =>
      item.type === 'folder' &&
      item.status === 'checked' &&
      // either "not yet cached at all" or "some pages are left to fetch"
      (item.cached === false || item.nextPagePath),
  ) as PartialTreeFolderNode[]
  // per each poor folder, recursively fetch all files and make them .checked!
  counters.foldersQueued += poorFolders.length
  poorFolders.forEach((poorFolder) => {
    queue.add(() =>
      recursivelyFetch(
        queue,
        poorTree,
        poorFolder,
        apiList,
        validateSingleFile,
        counters,
      ),
    )
  })

  queue.on('completed', () => {
    reportProgress({
      filesFound: counters.filesFound,
      foldersWalked: counters.foldersWalked,
      // Tracked by us, NOT read off the queue. p-queue emits `completed` before
      // decrementing `pending`, and `pending` can stay flat across several
      // events, so `queue.size + queue.pending` overstates the work left by a
      // varying amount. Queued-minus-walked is exact by construction.
      foldersRemaining: counters.foldersQueued - counters.foldersWalked,
    })
  })

  await queue.onIdle()

  // Terminal report. The per-task `completed` events fire while sibling tasks
  // may still be in flight, so the last of them is not guaranteed to show zero
  // remaining — a UI driven purely by those events would stall reading
  // "N folders left" forever. This guarantees consumers see the finished state.
  reportProgress({
    filesFound: counters.filesFound,
    foldersWalked: counters.foldersWalked,
    foldersRemaining: 0,
  })

  return poorTree
}

export default afterFill
