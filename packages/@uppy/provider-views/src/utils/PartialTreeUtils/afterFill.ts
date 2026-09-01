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
import {
  createPathScratch,
  getFolderRelativePath,
  injectPathsIntoFiles,
  type PathScratch,
} from './getCheckedFilesWithPaths.js'
import shallowClone from './shallowClone.js'

export type ApiList = (directory: PartialTreeId) => Promise<{
  nextPagePath: PartialTreeId
  items: CompanionFile[]
}>

/**
 * Progress of a recursive provider folder walk.
 *
 * There is deliberately no percentage: the tree's size is unknown until the walk
 * finishes, so the only honest figures are how much has been found so far and
 * how many folders are still queued.
 *
 * **This is progress, not lifecycle — do not use it to detect completion.**
 * `foldersRemaining` reaching 0 is not a reliable end signal: a walk in which a
 * folder listing failed or was aborted finishes with a non-zero value (see the
 * terminal report in `afterFill`), which is the honest answer but means a
 * consumer waiting for 0 would wait forever. Completion is `afterFill`
 * resolving, and for an embedder, Uppy's own `files-added`.
 */
export type WalkProgress = {
  /** Files discovered and selected so far. */
  filesFound: number
  /** Folders whose listing has completed. */
  foldersWalked: number
  /** Folders still queued or in flight. */
  foldersRemaining: number
}

/**
 * A folder whose listing has COMPLETED, and everything final about it.
 *
 * Only walked folders are reported, which is what makes a streamed selection
 * stable: `subfolderCount` is known the moment the listing lands (all pages are
 * drained in one go), so a consumer can classify the folder — leaf or
 * intermediary — immediately and never have to re-classify it later. Reporting
 * folders on *discovery* instead would hand out folders of unknown shape, and a
 * leaf that later sprouts children changes identity under the consumer's feet.
 */
export type WalkFolder = {
  /**
   * Path relative to the checked root, in the same coordinate space as the
   * `relativePath` of the files inside it — so `${folder.path}/` prefixes them.
   */
  path: string
  /** Files held directly in this folder that passed per-file restrictions. */
  fileCount: number
  /** Subfolders found in this folder's listing. */
  subfolderCount: number
}

/** One incremental instalment of a walk. */
export type WalkBatch = {
  /** Newly selected files, with `absDirPath`/`relDirPath` already injected. */
  files: CompanionFile[]
  /** Folders walked since the previous batch. */
  folders: WalkFolder[]
}

export type WalkStream = {
  /** Receives each instalment. Called synchronously, on the walk's own turn. */
  onBatch: (batch: WalkBatch) => void
  /**
   * Path-derivation scratch space. Pass the same object to the final
   * `getCheckedFilesWithPaths` to avoid re-deriving every path a second time.
   */
  scratch?: PathScratch
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number
}

/**
 * Flush cadence.
 *
 * Both `uppy.addFiles` and a consumer's own state update clone the entire file
 * set, so flushing per folder is O(files) per folder — the quadratic that makes
 * a large import unusable in the first place. The interval therefore GROWS with
 * how much has already been streamed: snappy for the first few hundred files,
 * settling to one flush every few seconds once the set is large. A 29k-file
 * walk lands in roughly three dozen flushes instead of a few thousand.
 */
const FLUSH_MIN_MS = 250
const FLUSH_MAX_MS = 5_000
/** Streamed-file count per millisecond of flush interval. */
const FLUSH_FILES_PER_MS = 20

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
  sink: WalkSink | null,
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
  const checkedFiles = files.filter((file) => file.status === 'checked')
  counters.filesFound += checkedFiles.length

  // Recorded only after the tree has been pushed to: path derivation reads the
  // node's ancestors out of `poorTree`, so the folder and its files must be in
  // it first.
  sink?.record(poorFolder, checkedFiles, folders.length)

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
        sink,
      ),
    )
  })

  sink?.flush(false)
}

/**
 * Buffers walked folders and their files, and hands them to the consumer on the
 * growing cadence described above. Created per walk; a no-op when the embedder
 * has not opted into streaming.
 */
type WalkSink = {
  record: (
    folder: PartialTreeFolderNode,
    files: PartialTreeFile[],
    subfolderCount: number,
  ) => void
  flush: (force: boolean) => void
}

const createWalkSink = (
  poorTree: PartialTree,
  stream: WalkStream,
): WalkSink => {
  const now = stream.now ?? (() => Date.now())
  const scratch = stream.scratch ?? createPathScratch()

  let pendingFiles: PartialTreeFile[] = []
  let pendingFolders: WalkFolder[] = []
  let streamed = 0
  let lastFlushAt = now()

  return {
    record: (folder, files, subfolderCount) => {
      pendingFolders.push({
        path: getFolderRelativePath(poorTree, folder, scratch),
        fileCount: files.length,
        subfolderCount,
      })
      // Appended one by one, not spread: a single folder listing can hold
      // tens of thousands of files, and a spread that wide is an argument list
      // wide enough to overflow the stack.
      for (const file of files) pendingFiles.push(file)
    },

    flush: (force) => {
      if (pendingFiles.length === 0 && pendingFolders.length === 0) return
      if (!force) {
        const interval = Math.min(
          FLUSH_MAX_MS,
          Math.max(FLUSH_MIN_MS, streamed / FLUSH_FILES_PER_MS),
        )
        if (now() - lastFlushAt < interval) return
      }

      const files = injectPathsIntoFiles(poorTree, pendingFiles, scratch)
      const folders = pendingFolders
      pendingFiles = []
      pendingFolders = []
      streamed += files.length
      lastFlushAt = now()

      stream.onBatch({ files, folders })
    },
  }
}

const afterFill = async (
  partialTree: PartialTree,
  apiList: ApiList,
  validateSingleFile: (file: CompanionFile) => string | null,
  reportProgress: (progress: WalkProgress) => void,
  stream?: WalkStream,
): Promise<PartialTree> => {
  const queue = new PQueue({ concurrency: 6 })

  // fill up the missing parts of a partialTree!
  const poorTree: PartialTree = shallowClone(partialTree)

  const sink = stream ? createWalkSink(poorTree, stream) : null

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
        sink,
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

  // Everything still buffered, whatever the cadence would have said. A walk
  // that ends mid-interval must not strand its last folders.
  sink?.flush(true)

  // Terminal report, so a consumer always sees a final state even if the last
  // per-task event did not land on one.
  //
  // NOT hardcoded to zero. `queue.onIdle()` resolves once every task has
  // SETTLED, including rejected ones, and the promises from `queue.add()` are
  // discarded — so a folder whose listing failed or was aborted leaves
  // `foldersWalked < foldersQueued` and `afterFill` still returns a partial
  // tree (pre-existing behaviour, not introduced here). Announcing 0 remaining
  // in that case would tell the UI the walk finished cleanly when files are
  // missing. Reporting the real figure makes an incomplete walk visible.
  reportProgress({
    filesFound: counters.filesFound,
    foldersWalked: counters.foldersWalked,
    foldersRemaining: counters.foldersQueued - counters.foldersWalked,
  })

  return poorTree
}

export default afterFill
