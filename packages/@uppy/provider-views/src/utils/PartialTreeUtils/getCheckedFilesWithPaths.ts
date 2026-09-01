import type {
  PartialTree,
  PartialTreeFile,
  PartialTreeFolderNode,
  PartialTreeId,
} from '@uppy/core'
import type { CompanionFile } from '@uppy/utils'

export interface Cache {
  [key: string]: (PartialTreeFile | PartialTreeFolderNode)[]
}

type TreeNode = PartialTreeFile | PartialTreeFolderNode

/**
 * Reusable scratch space for path derivation.
 *
 * `getPath` used to locate every node with `partialTree.find(...)`, which is
 * O(tree) per lookup and so O(tree²) across a whole selection — ~841M steps for
 * a 29k-item tree, all of it in the one synchronous pass that runs immediately
 * before the files are handed to Uppy. `index` removes that; `cache`
 * (upstream's) still short-circuits the repeated parent chains.
 *
 * Both stay valid as the tree grows — a node's ancestors never change once it
 * has been discovered — so a streaming walk keeps ONE scratch object across
 * every flush and pays only for nodes it has not seen. `indexedUpTo` is what
 * makes that cheap: `PartialTree` is append-only while a walk is in flight, so
 * re-indexing can start where it left off instead of rescanning the tree per
 * flush (which would reintroduce the very cost this removes).
 */
export type PathScratch = {
  cache: Cache
  index: Map<PartialTreeId, TreeNode>
  /** The array `indexedUpTo` counts against; a different array restarts it. */
  source: PartialTree | null
  indexedUpTo: number
}

/** `Object.create(null)` so keys such as 'hasOwnProperty' are safe too. */
export const createPathScratch = (): PathScratch => ({
  cache: Object.create(null),
  index: new Map(),
  source: null,
  indexedUpTo: 0,
})

const indexTree = (partialTree: PartialTree, scratch: PathScratch): void => {
  const start = scratch.source === partialTree ? scratch.indexedUpTo : 0
  for (let i = start; i < partialTree.length; i++) {
    const item = partialTree[i]
    // A root has no ancestors and is never part of a path.
    if (item.type === 'root') continue
    scratch.index.set(item.id, item)
  }
  scratch.source = partialTree
  scratch.indexedUpTo = partialTree.length
}

const getPath = (id: PartialTreeId, scratch: PathScratch): TreeNode[] => {
  const sId = id === null ? 'null' : id
  if (scratch.cache[sId]) return scratch.cache[sId]

  const node = scratch.index.get(id)
  // The root, or an id from outside this tree: no path, and nothing to cache.
  if (!node) return []

  const meAndParentPath = [...getPath(node.parentId, scratch), node]
  scratch.cache[sId] = meAndParentPath
  return meAndParentPath
}

/**
 * The chain Uppy publishes a node's relative path from: the first *checked*
 * ancestor folder down to, and including, the node itself.
 *
 * Shared by files and folders deliberately — a streamed folder's path has to
 * prefix the paths of the files inside it, or an embedder cannot join the two.
 */
const getRelativeChain = (absFolders: TreeNode[]): TreeNode[] => {
  const firstCheckedFolderIndex = absFolders.findIndex(
    (i) => i.type === 'folder' && i.status === 'checked',
  )
  return absFolders.slice(firstCheckedFolderIndex)
}

/**
 * The relative path of a folder, in the same coordinate space as the
 * `relDirPath` injected into the files below it.
 */
export const getFolderRelativePath = (
  partialTree: PartialTree,
  folder: PartialTreeFolderNode,
  scratch: PathScratch,
): string => {
  indexTree(partialTree, scratch)
  return getRelativeChain(getPath(folder.id, scratch))
    .map((i) => i.data.name)
    .join('/')
}

// See "Uppy file properties" documentation for `.absolutePath` and `.relativePath`
// (https://uppy.io/docs/uppy/#working-with-uppy-files)
export const injectPathsIntoFiles = (
  partialTree: PartialTree,
  files: PartialTreeFile[],
  scratch: PathScratch,
): CompanionFile[] => {
  indexTree(partialTree, scratch)

  return files.map((file) => {
    const absFolders = getPath(file.id, scratch)
    const relFolders = getRelativeChain(absFolders)

    const absDirPath = `/${absFolders.map((i) => i.data.name).join('/')}`
    const relDirPath =
      relFolders.length === 1
        ? // Must return `undefined` (which later turns into `null` in `.companionFileToUppyFile()`)
          // (https://github.com/transloadit/uppy/pull/4537#issuecomment-1629136652)
          undefined
        : relFolders.map((i) => i.data.name).join('/')

    return {
      ...file.data,
      absDirPath,
      relDirPath,
    }
  })
}

export type GetCheckedFilesOptions = {
  /** Skip these file ids — the ones a streaming walk already handed to Uppy. */
  exclude?: ReadonlySet<PartialTreeId>
  /** Scratch space carried over from a streaming walk, so paths aren't re-derived. */
  scratch?: PathScratch
}

const getCheckedFilesWithPaths = (
  partialTree: PartialTree,
  options: GetCheckedFilesOptions = {},
): CompanionFile[] => {
  // We're only interested in injecting paths into 'checked' files
  const checkedFiles = partialTree.filter(
    (item) =>
      item.type === 'file' &&
      item.status === 'checked' &&
      !options.exclude?.has(item.id),
  ) as PartialTreeFile[]

  return injectPathsIntoFiles(
    partialTree,
    checkedFiles,
    options.scratch ?? createPathScratch(),
  )
}

export default getCheckedFilesWithPaths
