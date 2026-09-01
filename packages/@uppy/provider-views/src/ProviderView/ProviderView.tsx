import type {
  Body,
  Meta,
  PartialTree,
  PartialTreeFile,
  PartialTreeFolder,
  PartialTreeFolderNode,
  PartialTreeId,
  UnknownProviderPlugin,
  UnknownProviderPluginState,
  ValidateableFile,
} from '@uppy/core'
import type { CompanionFile, I18n } from '@uppy/utils'
import { remoteFileObjToLocal } from '@uppy/utils'
import classNames from 'classnames'
import debounce from 'lodash/debounce.js'
import type { h } from 'preact'
import packageJson from '../../package.json' with { type: 'json' }
import Browser from '../Browser.js'
import FilterInput from '../FilterInput.js'
import FooterActions from '../FooterActions.js'
import addFiles, { duplicateFilesNotice } from '../utils/addFiles.js'
import getClickedRange from '../utils/getClickedRange.js'
import handleError from '../utils/handleError.js'
import type { WalkFolder } from '../utils/PartialTreeUtils/afterFill.js'
import getBreadcrumbs from '../utils/PartialTreeUtils/getBreadcrumbs.js'
import getCheckedFilesWithPaths, {
  createPathScratch,
} from '../utils/PartialTreeUtils/getCheckedFilesWithPaths.js'
import getNumberOfSelectedFiles from '../utils/PartialTreeUtils/getNumberOfSelectedFiles.js'
import PartialTreeUtils from '../utils/PartialTreeUtils/index.js'
import shouldHandleScroll from '../utils/shouldHandleScroll.js'
import AuthView from './AuthView.js'
import GlobalSearchView from './GlobalSearchView.js'
import Header from './Header.js'

export function defaultPickerIcon(): h.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="30"
      height="30"
      viewBox="0 0 30 30"
    >
      <path d="M15 30c8.284 0 15-6.716 15-15 0-8.284-6.716-15-15-15C6.716 0 0 6.716 0 15c0 8.284 6.716 15 15 15zm4.258-12.676v6.846h-8.426v-6.846H5.204l9.82-12.364 9.82 12.364H19.26z" />
    </svg>
  )
}

const getDefaultState = (
  rootFolderId: string | null,
): UnknownProviderPluginState => ({
  authenticated: undefined, // we don't know yet
  partialTree: [
    {
      type: 'root',
      id: rootFolderId,
      cached: false,
      nextPagePath: null,
    },
  ],
  currentFolderId: rootFolderId,
  searchString: '',
  didFirstRender: false,
  username: null,
  loading: false,
})

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>

export interface Opts<M extends Meta, B extends Body> {
  provider: UnknownProviderPlugin<M, B>['provider']
  viewType: 'list' | 'grid'
  showTitles: boolean
  showFilter: boolean
  showBreadcrumbs: boolean
  loadAllFiles: boolean
  renderAuthForm?: (args: {
    pluginName: string
    i18n: I18n
    loading: boolean | string
    onAuth: (authFormData: unknown) => Promise<void>
  }) => h.JSX.Element
  virtualList: boolean
  supportsSearch?: boolean
  /**
   * Hand files to Uppy DURING the folder walk instead of only when it finishes.
   *
   * Off by default, because it changes two guarantees an embedder may rely on:
   * `files-added` fires many times for one selection, and aggregate
   * restrictions can no longer be enforced before the first file is added (they
   * are checked at the end, and a failure then removes everything the walk
   * streamed — see `donePicking`). Opt in only if the host reacts to partial
   * selections on purpose; ours renders the import review screen as the tree
   * comes in, which is the whole point of the walk being visible at all.
   */
  streamWalkedFiles?: boolean
}
type PassedOpts<M extends Meta, B extends Body> = Optional<
  Opts<M, B>,
  | 'viewType'
  | 'showTitles'
  | 'showFilter'
  | 'showBreadcrumbs'
  | 'loadAllFiles'
  | 'virtualList'
>
type DefaultOpts<M extends Meta, B extends Body> = Omit<Opts<M, B>, 'provider'>
type RenderOpts<M extends Meta, B extends Body> = Omit<
  PassedOpts<M, B>,
  'provider'
>
/**
 * Class to easily generate generic views for Provider plugins
 *
 * We have a *search view* and a *normal view*.
 * Search view is only used when the Provider supports server side search i.e. provider.search method is implemented for the provider.
 * The state is stored in searchResults.
 * Search view is implemented in components GlobalSearchView and SearchResultItem.
 * We conditionally switch between search view and normal in the render method when a server side search is initiated.
 * When users type their search query in search input box (SearchInput component), we debounce the input and call provider.search method to fetch results from the server.
 * when the user enters a folder in search results or clears the search input query we switch back to Normal View.
 */
export default class ProviderView<M extends Meta, B extends Body> {
  static VERSION = packageJson.version

  // Test hook (mirrors GoldenRetriever pattern): allow tests to override debounce time
  // @ts-expect-error test-only hook key
  static [Symbol.for('uppy test: searchDebounceMs')]: number | undefined

  // Test hook: the clock a streaming walk measures its flush cadence against.
  // Without it a mocked walk finishes inside the 250ms floor, so every file
  // lands in the single forced flush at the end — and any test about what
  // happens DURING a walk silently becomes a test about what happens after it.
  // @ts-expect-error test-only hook key
  static [Symbol.for('uppy test: walkFlushClock')]: (() => number) | undefined

  plugin: UnknownProviderPlugin<M, B>

  provider: UnknownProviderPlugin<M, B>['provider']

  opts: Opts<M, B>

  isHandlingScroll: boolean = false

  previousCheckbox: string | null = null
  #searchDebounced: () => void

  constructor(plugin: UnknownProviderPlugin<M, B>, opts: PassedOpts<M, B>) {
    this.plugin = plugin
    this.provider = opts.provider

    const defaultOptions: DefaultOpts<M, B> = {
      viewType: 'list',
      showTitles: true,
      showFilter: true,
      showBreadcrumbs: true,
      loadAllFiles: false,
      virtualList: false,
    }
    this.opts = { ...defaultOptions, ...opts }

    this.openFolder = this.openFolder.bind(this)
    this.logout = this.logout.bind(this)
    this.handleAuth = this.handleAuth.bind(this)
    this.handleScroll = this.handleScroll.bind(this)
    this.resetPluginState = this.resetPluginState.bind(this)
    this.donePicking = this.donePicking.bind(this)
    this.render = this.render.bind(this)
    this.cancelSelection = this.cancelSelection.bind(this)
    this.toggleCheckbox = this.toggleCheckbox.bind(this)
    this.openSearchResultFolder = this.openSearchResultFolder.bind(this)
    this.clearSearchState = this.clearSearchState.bind(this)

    // Set default state for the plugin
    this.resetPluginState()

    // todo
    // @ts-expect-error this should be typed in @uppy/dashboard.
    this.plugin.uppy.on('dashboard:close-panel', this.#handlePanelClose)

    this.plugin.uppy.registerRequestClient(
      this.provider.provider,
      this.provider,
    )

    // Configure debounced search with test override
    const testHookSymbol = Symbol.for('uppy test: searchDebounceMs')
    const testWait = (
      ProviderView as unknown as Record<symbol, number | undefined>
    )[testHookSymbol]
    const wait = testWait ?? 500
    const debounceOpts =
      testWait === 0 ? { leading: true, trailing: true } : undefined
    this.#searchDebounced = debounce(this.#search, wait, debounceOpts)
  }

  resetPluginState(): void {
    this.plugin.setPluginState(getDefaultState(this.plugin.rootFolderId))
  }

  tearDown(): void {
    // Nothing.
  }

  setLoading(loading: boolean | string): void {
    this.plugin.setPluginState({ loading })
  }

  get isLoading() {
    return this.plugin.getPluginState().loading
  }

  cancelSelection(): void {
    const { partialTree } = this.plugin.getPluginState()
    const newPartialTree: PartialTree = partialTree.map((item) =>
      item.type === 'root' ? item : { ...item, status: 'unchecked' },
    )
    this.plugin.setPluginState({ partialTree: newPartialTree })
  }

  clearSearchState(): void {
    this.plugin.setPluginState({
      searchResults: undefined,
    })
  }

  #abortController: AbortController | undefined

  /**
   * True while a STREAMING `donePicking` is walking.
   *
   * Streaming hands files to Uppy mid-walk, and Dashboard answers `file-added`
   * by hiding its panels, which emits `dashboard:close-panel`. Two listeners
   * react to that event and both would end the walk that caused it:
   * `#withAbort`'s `cancelRequest` (handled by its `ignorePanelClose`), and the
   * `resetPluginState` registered in the constructor — which blanks
   * `didFirstRender`, so the next `render` bootstraps `openFolder`, whose own
   * `#withAbort` aborts the walk's controller.
   *
   * The one-shot flow never sees either: it adds files only once the walk is
   * over.
   */
  #streamingWalk = false

  /**
   * The panel closing means "the user navigated away, drop the browsing state".
   * During a streaming walk it means the opposite: the panel closed BECAUSE the
   * walk is delivering, and the state it would drop is the walk's own.
   */
  #handlePanelClose = (): void => {
    if (this.#streamingWalk) return
    this.resetPluginState()
  }

  /**
   * @param op the abortable work
   * @param ignorePanelClose treat only `cancel-all` as cancellation, not the
   * Dashboard's panel closing.
   *
   * A STREAMING walk must set this, and it is not a nicety — it is what keeps
   * the walk alive. Dashboard listens to `file-added` with `hideAllPanels`,
   * which closes the acquirer panel and emits `dashboard:close-panel`. In the
   * one-shot flow that lands after the walk has finished, so aborting is
   * harmless. Streaming calls `addFiles` from inside the walk, so the FIRST
   * instalment would emit it, abort the very walk that produced it, and throw
   * away the whole selection. Only the first: `hideAllPanels` short-circuits
   * once the panel is already closed — which is worse, not better, because it
   * makes the failure depend on how quickly the host tears the Dashboard down.
   *
   * `cancel-all` still cancels, and so does another `#withAbort` starting.
   */
  async #withAbort(
    op: (signal: AbortSignal) => Promise<void>,
    { ignorePanelClose = false }: { ignorePanelClose?: boolean } = {},
  ) {
    // prevent multiple requests in parallel from causing race conditions
    this.#abortController?.abort()
    const abortController = new AbortController()
    this.#abortController = abortController
    const cancelRequest = () => {
      abortController.abort()
    }
    try {
      if (!ignorePanelClose) {
        // @ts-expect-error this should be typed in @uppy/dashboard.
        // Even then I don't think we can make this work without adding dashboard
        // as a dependency to provider-views.
        this.plugin.uppy.on('dashboard:close-panel', cancelRequest)
      }
      this.plugin.uppy.on('cancel-all', cancelRequest)

      await op(abortController.signal)
    } finally {
      // @ts-expect-error this should be typed in @uppy/dashboard.
      // Even then I don't think we can make this work without adding dashboard
      // as a dependency to provider-views.
      this.plugin.uppy.off('dashboard:close-panel', cancelRequest)
      this.plugin.uppy.off('cancel-all', cancelRequest)
      this.#abortController = undefined
    }
  }

  async #search(): Promise<void> {
    const { partialTree, currentFolderId, searchString } =
      this.plugin.getPluginState()

    const currentFolder = partialTree.find((i) => i.id === currentFolderId)!

    if (searchString.trim() === '') {
      this.#abortController?.abort()
      this.clearSearchState()
      return
    }

    this.setLoading(true)
    await this.#withAbort(async (signal) => {
      const scopePath =
        currentFolder.type === 'root' ? undefined : currentFolderId
      const { items } = await this.provider.search!(searchString, {
        signal,
        path: scopePath,
      })

      // For each searched file, build the entire path (from the root all the way to the leaf node)
      // This is because we need to make sure all ancestor folders are present in the partialTree before we open the folder or check the file.
      // This is needed because when the user opens a folder we need to have all its parent folders in the partialTree to be able to render the breadcrumbs correctly.
      // Similarly when the user checks a file, we need to have all it's ancestor folders in the partialTree to be able to percolateUp the checked state correctly to its ancestors.

      const { partialTree } = this.plugin.getPluginState()
      const newPartialTree: PartialTree = [...partialTree]

      for (const file of items) {
        // Decode URI and split into path segments
        const decodedPath = decodeURIComponent(file.requestPath)
        const segments = decodedPath.split('/').filter((s) => s.length > 0)

        // Start from root
        let parentId: PartialTreeId = this.plugin.rootFolderId
        let isParentFolderChecked: boolean

        // Walk through each segment starting from the root and build child nodes if they don't exist
        segments.forEach((segment, index, arr) => {
          const pathSegments = segments.slice(0, index + 1)
          const encodedPath = encodeURIComponent(`/${pathSegments.join('/')}`)

          // Skip if node already exists
          const existingNode = newPartialTree.find(
            (n) => n.id === encodedPath && n.type !== 'root',
          ) as PartialTreeFolderNode | PartialTreeFile | undefined
          if (existingNode) {
            parentId = encodedPath
            isParentFolderChecked = existingNode.status === 'checked'
            return
          }

          const isLeafNode = index === arr.length - 1
          let node: PartialTreeFolderNode | PartialTreeFile

          // propagate checked state from parent to children, if the user has checked the parent folder before searching
          // and the parent folder is an ancestor of the searched file
          // see also afterOpenFolder which contains similar logic, we should probably refactor and reuse some
          const status = isParentFolderChecked ? 'checked' : 'unchecked'

          // Build the Leaf Node, it can be a file (`PartialTreeFile`) or a folder (`PartialTreeFolderNode`).
          // Since we Already have the leaf node's data (`file`, `CompanionFile`) from the searchResults: CompanionFile[], we just use that.
          if (isLeafNode) {
            if (file.isFolder) {
              node = {
                type: 'folder',
                id: encodedPath,
                cached: false,
                nextPagePath: null,
                status,
                parentId,
                data: file,
              }
            } else {
              const restrictionError = this.validateSingleFile(file)
              node = {
                type: 'file',
                id: encodedPath,
                restrictionError,
                status: !restrictionError ? status : 'unchecked',
                parentId,
                data: file,
              }
            }
          } else {
            // not leaf node, so by definition it is a folder leading up to the leaf node
            node = {
              type: 'folder',
              id: encodedPath,
              cached: false,
              nextPagePath: null,
              status,
              parentId,
              data: {
                // we don't have any data, so fill only the necessary fields
                name: decodeURIComponent(segment),
                icon: 'folder',
                isFolder: true,
              },
            }
          }
          newPartialTree.push(node)
          parentId = encodedPath // This node becomes parent for the next iteration
          isParentFolderChecked = status === 'checked'
        })
      }

      this.plugin.setPluginState({
        partialTree: newPartialTree,
        searchResults: items.map((item) => item.requestPath),
      })
    }).catch(handleError(this.plugin.uppy))
    this.setLoading(false)
  }

  // debounced search function is initialized in the constructor

  onSearchInput = (s: string): void => {
    this.plugin.setPluginState({ searchString: s })
    if (this.opts.supportsSearch) {
      this.#searchDebounced()
    }
  }

  async openSearchResultFolder(folderId: PartialTreeId): Promise<void> {
    // stop searching
    this.plugin.setPluginState({ searchString: '' })

    // now open folder using the normal view
    await this.openFolder(folderId)
  }

  async openFolder(folderId: PartialTreeId): Promise<void> {
    // always switch away from the search view when opening a folder, whether it happens from the search view or by clicking breadcrumbs
    this.clearSearchState()

    this.previousCheckbox = null
    // Returning cached folder
    const { partialTree } = this.plugin.getPluginState()
    const clickedFolder = partialTree.find(
      (folder) => folder.id === folderId,
    )! as PartialTreeFolder

    if (clickedFolder.cached) {
      this.plugin.setPluginState({
        currentFolderId: folderId,
        searchString: '',
      })
      return
    }

    this.setLoading(true)
    await this.#withAbort(async (signal) => {
      let currentPagePath = folderId
      let currentItems: CompanionFile[] = []
      do {
        const { username, nextPagePath, items } = await this.provider.list(
          currentPagePath,
          { signal },
        )
        // It's important to set the username during one of our first fetches
        this.plugin.setPluginState({ username })

        currentPagePath = nextPagePath
        currentItems = currentItems.concat(items)
        this.setLoading(
          this.plugin.uppy.i18n('loadedXFiles', {
            numFiles: currentItems.length,
          }),
        )
      } while (this.opts.loadAllFiles && currentPagePath)

      const newPartialTree = PartialTreeUtils.afterOpenFolder(
        partialTree,
        currentItems,
        clickedFolder,
        currentPagePath,
        this.validateSingleFile,
      )

      this.plugin.setPluginState({
        partialTree: newPartialTree,
        currentFolderId: folderId,
        searchString: '',
      })
    }).catch(handleError(this.plugin.uppy))

    this.setLoading(false)
  }

  /**
   * Removes session token on client side.
   */
  async logout(): Promise<void> {
    await this.#withAbort(async (signal) => {
      const res = await this.provider.logout<{
        ok: boolean
        revoked: boolean
        manual_revoke_url: string
      }>({
        signal,
      })
      // res.ok is from the JSON body, not to be confused with Response.ok
      if (res.ok) {
        if (!res.revoked) {
          const message = this.plugin.uppy.i18n('companionUnauthorizeHint', {
            provider: this.plugin.title,
            url: res.manual_revoke_url,
          })
          this.plugin.uppy.info(message, 'info', 7000)
        }

        this.plugin.setPluginState({
          ...getDefaultState(this.plugin.rootFolderId),
          authenticated: false,
        })
      }
    }).catch(handleError(this.plugin.uppy))
  }

  async handleAuth(authFormData?: unknown): Promise<void> {
    await this.#withAbort(async (signal) => {
      this.setLoading(true)
      await this.provider.login({ authFormData, signal })
      this.plugin.setPluginState({ authenticated: true })
      await Promise.all([
        this.provider.fetchPreAuthToken(),
        this.openFolder(this.plugin.rootFolderId),
      ])
    }).catch(handleError(this.plugin.uppy))
    this.setLoading(false)
  }

  async handleScroll(event: Event): Promise<void> {
    const { partialTree, currentFolderId } = this.plugin.getPluginState()
    const currentFolder = partialTree.find(
      (i) => i.id === currentFolderId,
    ) as PartialTreeFolder
    if (
      shouldHandleScroll(event) &&
      !this.isHandlingScroll &&
      currentFolder.nextPagePath
    ) {
      this.isHandlingScroll = true
      await this.#withAbort(async (signal) => {
        const { nextPagePath, items } = await this.provider.list(
          currentFolder.nextPagePath,
          { signal },
        )
        const newPartialTree = PartialTreeUtils.afterScrollFolder(
          partialTree,
          currentFolderId,
          items,
          nextPagePath,
          this.validateSingleFile,
        )

        this.plugin.setPluginState({ partialTree: newPartialTree })
      }).catch(handleError(this.plugin.uppy))
      this.isHandlingScroll = false
    }
  }

  validateSingleFile = (file: CompanionFile): string | null => {
    const companionFile: ValidateableFile<M, B> = remoteFileObjToLocal(file)
    const result = this.plugin.uppy.validateSingleFile(companionFile)
    return result
  }

  /**
   * Announce one instalment of a streaming walk.
   *
   * Separate from `provider-walk-progress` (which is counters only, and fires
   * whether or not streaming is on): this carries the walked folders, so a host
   * can render structure — and its terminal `status` is the only reliable end
   * signal.
   *
   * `files-added` cannot stand in for it, in either direction. During the walk
   * it fires many times for what the user experienced as one selection, and
   * none of those mean "done". At the end it usually does not fire at all: the
   * final instalment normally has nothing left to add, and `addFiles` declines
   * to hand Uppy an empty batch — so there is no terminal `files-added` to wait
   * for.
   */
  #emitWalkBatch(
    status: 'started' | 'streaming' | 'complete' | 'aborted',
    folders: WalkFolder[],
    fileCount: number,
  ): void {
    // Stamped with the plugin id for the same reason the progress event is:
    // several provider plugins share one Uppy instance, and a cancelled walk
    // can report after the user has moved to another panel.
    this.plugin.uppy.emit('provider-walk-batch', {
      providerId: this.plugin.id,
      status,
      folders,
      fileCount,
    })
  }

  async donePicking(): Promise<void> {
    const { partialTree } = this.plugin.getPluginState()

    if (this.isLoading) return
    this.setLoading(true)

    // Read from the PLUGIN's opts as well as the view's. Every provider plugin
    // (@uppy/dropbox, @uppy/google-drive, @uppy/onedrive, @uppy/smugmug, …)
    // constructs its `ProviderView` with a fixed set of options — `provider`,
    // `viewType`, `showTitles`, and so on — and drops everything else, so an
    // option added here never reaches the view by the route an embedder would
    // expect: passing it to `uppy.use(SmugMug, { … })`. Forking four more
    // packages to widen that list is not worth it for one flag.
    const streaming =
      (this.opts.streamWalkedFiles ??
        (this.plugin.opts as { streamWalkedFiles?: boolean })
          .streamWalkedFiles) === true
    // Held for the whole walk, so the panel-close reset stays disarmed even
    // across the awaits inside it.
    this.#streamingWalk = streaming
    // Shared with the final `getCheckedFilesWithPaths` below so the paths the
    // walk already derived are not derived a second time.
    const scratch = createPathScratch()
    const streamedIds = new Set<PartialTreeId>()
    const streamedUppyIds: string[] = []
    let streamedCount = 0
    // `quiet` silences the per-instalment duplicate notice as well as the added
    // one, so a streaming walk owes the user a single aggregate of both. Without
    // this, re-picking a folder whose files are already on the instance would
    // stream instalment after instalment reporting nothing added and say nothing
    // about why.
    let skippedCount = 0
    let lastProgress: { foldersRemaining: number } | null = null

    // Everything the walk handed over before it failed, was cancelled, or hit an
    // aggregate restriction. Without streaming those cases add nothing at all,
    // so leaving partial files behind would be a new way to fail — the host
    // would be left reviewing a selection the user never completed.
    const discardStreamedFiles = () => {
      if (streamedUppyIds.length > 0) {
        try {
          this.plugin.uppy.removeFiles(streamedUppyIds)
        } catch (err) {
          // `removeFiles` throws when the removal would partly empty an upload
          // already running under an uploader without `individualCancellation`
          // — reachable for a host with `autoProceed`, since streaming starts
          // uploads mid-walk. This runs on the cancellation and
          // restriction-failure paths, so throwing would replace a clean abort
          // with an exception AND still leave the files behind. The host is
          // told `aborted` either way, which is the part that matters: its
          // derived state goes.
          this.plugin.uppy.log(
            `Could not discard streamed files after an aborted walk: ${err}`,
            'warning',
          )
        }
        streamedUppyIds.length = 0
      }
      streamedIds.clear()
      streamedCount = 0
      skippedCount = 0
    }

    // Announced before the first listing, so a host can open its own review UI
    // on an empty selection and fill it in. Without it the host would first
    // hear about the walk from `files-added` — by which point it has already
    // had to decide, blind, whether this is a streaming walk or a one-shot one.
    if (streaming) this.#emitWalkBatch('started', [], 0)

    await this.#withAbort(
      async (signal) => {
        // 1. Enrich our partialTree by fetching all 'checked' but not-yet-fetched folders
        const enrichedTree: PartialTree = await PartialTreeUtils.afterFill(
          partialTree,
          (path: PartialTreeId) => this.provider.list(path, { signal }),
          this.validateSingleFile,
          (progress) => {
            lastProgress = progress
            this.setLoading(
              this.plugin.uppy.i18n('addedNumFiles', {
                numFiles: progress.filesFound,
              }),
            )
            // Also surfaced as an event so an embedding app can render its own
            // progress. The loading label is Uppy's internal UI and is i18n'd, so
            // it is not something a host can reliably read.
            //
            // Stamped with the plugin id because the event is global to the Uppy
            // instance: several provider plugins are usually installed together,
            // and a cancelled walk can emit its terminal report after the user has
            // moved to another panel. Without this a host cannot tell whose
            // numbers it is showing.
            this.plugin.uppy.emit('provider-walk-progress', {
              ...progress,
              providerId: this.plugin.id,
            })
          },
          streaming
            ? {
                scratch,
                now: (
                  ProviderView as unknown as Record<
                    symbol,
                    (() => number) | undefined
                  >
                )[Symbol.for('uppy test: walkFlushClock')],
                onBatch: ({ files, folders }) => {
                  for (const file of files) streamedIds.add(file.requestPath)
                  let addedNow = 0
                  // Empty is fine to pass: `addFiles` declines to bother Uppy
                  // when nothing survives its filtering, which covers both a
                  // folders-only instalment and a batch that turns out to be
                  // entirely re-served.
                  addFiles(files, this.plugin, this.provider, {
                    // One notice for the whole selection, emitted at the end —
                    // not one per instalment.
                    quiet: true,
                    onAdded: (ids) => {
                      // Appended, not spread — see the same note in `afterFill`.
                      for (const id of ids) streamedUppyIds.push(id)
                      addedNow = ids.length
                    },
                    onSkipped: (skipped) => {
                      skippedCount += skipped
                    },
                  })
                  // What Uppy TOOK, not what the walk offered: `addFiles` skips
                  // a file that already exists or fails a restriction, and both
                  // the toast and `provider-walk-batch.fileCount` claim to
                  // count files that are on the instance.
                  streamedCount += addedNow
                  this.#emitWalkBatch('streaming', folders, addedNow)
                },
              }
            : undefined,
        )

        // 2. An incomplete walk is not a complete selection.
        //
        // `afterFill` discards the promises from `queue.add`, so a listing that
        // was cancelled or failed does NOT reject here — the walk finishes and
        // returns a PARTIAL tree, which is why `cancel-all` mid-walk otherwise
        // lands as a clean `complete`. The terminal progress report is what
        // reveals it: folders queued but never walked.
        //
        // Telling a streaming host `complete` on a partial tree is the worst
        // outcome available — it would import the folders that happened to be
        // listed first and silently drop the rest — so this discards instead. The
        // one-shot path keeps its existing behaviour of adding what it got.
        if (streaming && (lastProgress?.foldersRemaining ?? 0) > 0) {
          discardStreamedFiles()
          this.#emitWalkBatch('aborted', [], 0)
          this.plugin.setPluginState({ partialTree: enrichedTree })
          return
        }

        // 3. Now that we know how many files there are - recheck aggregateRestrictions!
        const aggregateRestrictionError =
          this.validateAggregateRestrictions(enrichedTree)
        if (aggregateRestrictionError) {
          // A streaming walk has already added files by the time we get here —
          // the restriction is about the selection as a whole, so the selection
          // as a whole has to go.
          discardStreamedFiles()
          if (streaming) this.#emitWalkBatch('aborted', [], 0)
          this.plugin.setPluginState({ partialTree: enrichedTree })
          return
        }

        // 4. Add whatever the walk did not already stream. Usually nothing when
        //    streaming — but a folder that was checked and already `cached` before
        //    the walk began is never re-listed, so its files never pass through
        //    the sink.
        const companionFiles = getCheckedFilesWithPaths(enrichedTree, {
          exclude: streaming ? streamedIds : undefined,
          scratch,
        })
        // Called unconditionally: `addFiles` declines to hand Uppy an empty
        // batch itself, so the streaming case usually reaches here, adds
        // nothing, and emits nothing. The condition this used to carry became
        // dead the moment that guard moved into the helper.
        let addedFinally = 0
        addFiles(companionFiles, this.plugin, this.provider, {
          quiet: streaming,
          onAdded: (ids) => {
            addedFinally = ids.length
          },
          onSkipped: (skipped) => {
            skippedCount += skipped
          },
        })
        if (streaming) {
          // The one notice the whole selection gets, standing in for the ones
          // `quiet` suppressed on every instalment.
          const total = streamedCount + addedFinally
          if (total > 0) {
            this.plugin.uppy.info(
              this.plugin.uppy.i18n('addedNumFiles', { numFiles: total }),
            )
          }
          if (skippedCount > 0) {
            this.plugin.uppy.info(duplicateFilesNotice(skippedCount))
          }
          this.#emitWalkBatch('complete', [], addedFinally)
        }

        // 5. Reset state
        this.resetPluginState()
      },
      { ignorePanelClose: streaming },
    ).catch((err) => {
      // Cancelled, or a listing failed. Either way the selection is incomplete.
      discardStreamedFiles()
      if (streaming) this.#emitWalkBatch('aborted', [], 0)
      return handleError(this.plugin.uppy)(err)
    })
    this.#streamingWalk = false
    this.setLoading(false)
  }

  toggleCheckbox(
    ourItem: PartialTreeFolderNode | PartialTreeFile,
    isShiftKeyPressed: boolean,
  ) {
    const { partialTree } = this.plugin.getPluginState()

    const clickedRange = getClickedRange(
      ourItem.id,
      this.getDisplayedPartialTree(),
      isShiftKeyPressed,
      this.previousCheckbox,
    )

    const newPartialTree = PartialTreeUtils.afterToggleCheckbox(
      partialTree,
      clickedRange,
    )

    this.plugin.setPluginState({ partialTree: newPartialTree })
    this.previousCheckbox = ourItem.id
  }

  getDisplayedPartialTree = (): (PartialTreeFile | PartialTreeFolderNode)[] => {
    const { partialTree, currentFolderId, searchString } =
      this.plugin.getPluginState()
    const inThisFolder = partialTree.filter(
      (item) => item.type !== 'root' && item.parentId === currentFolderId,
    ) as (PartialTreeFile | PartialTreeFolderNode)[]

    // If provider supports server side search, we don't filter the items client side
    const filtered =
      this.opts.supportsSearch || searchString.trim() === ''
        ? inThisFolder
        : inThisFolder.filter(
            (item) =>
              (item.data.name ?? this.plugin.uppy.i18n('unnamed'))
                .toLowerCase()
                .indexOf(searchString.trim().toLowerCase()) !== -1,
          )

    return filtered
  }

  getBreadcrumbs = (): PartialTreeFolder[] => {
    const { partialTree, currentFolderId } = this.plugin.getPluginState()
    return getBreadcrumbs(partialTree, currentFolderId)
  }

  getSelectedAmount = (): number => {
    const { partialTree } = this.plugin.getPluginState()
    return getNumberOfSelectedFiles(partialTree)
  }

  validateAggregateRestrictions = (partialTree: PartialTree) => {
    const checkedFiles = partialTree.filter(
      (item) => item.type === 'file' && item.status === 'checked',
    ) as PartialTreeFile[]
    const uppyFiles = checkedFiles.map((file) => file.data)
    return this.plugin.uppy.validateAggregateRestrictions(uppyFiles)
  }

  #renderSearchResults() {
    const { i18n } = this.plugin.uppy

    const { searchResults: ids, partialTree } = this.plugin.getPluginState()

    // todo memoize this so we don't have to do it on every render
    const itemsById = new Map<string, PartialTreeFile | PartialTreeFolderNode>()
    partialTree.forEach((item) => {
      if (item.type !== 'root') {
        itemsById.set(item.id, item)
      }
    })

    // the search results view needs data from the partial tree,
    const searchResults = ids!.map((id) => {
      const partialTreeItem = itemsById.get(id)
      if (partialTreeItem == null) throw new Error('Partial tree not complete')
      return partialTreeItem
    })

    return (
      <GlobalSearchView
        searchResults={searchResults}
        openFolder={this.openSearchResultFolder}
        toggleCheckbox={this.toggleCheckbox}
        i18n={i18n}
      />
    )
  }

  render(state: unknown, viewOptions: RenderOpts<M, B> = {}): h.JSX.Element {
    const { didFirstRender } = this.plugin.getPluginState()
    const { i18n } = this.plugin.uppy

    if (!didFirstRender) {
      this.plugin.setPluginState({ didFirstRender: true })
      this.provider.fetchPreAuthToken()
      this.openFolder(this.plugin.rootFolderId)
    }

    const opts: Opts<M, B> = { ...this.opts, ...viewOptions }
    const { authenticated, loading } = this.plugin.getPluginState()
    const pluginIcon = this.plugin.icon || defaultPickerIcon

    if (authenticated === false) {
      return (
        <AuthView
          pluginName={this.plugin.title}
          pluginIcon={pluginIcon}
          handleAuth={this.handleAuth}
          i18n={this.plugin.uppy.i18n}
          renderForm={opts.renderAuthForm}
          loading={loading}
        />
      )
    }

    const { partialTree, username, searchString, searchResults } =
      this.plugin.getPluginState()
    const breadcrumbs = this.getBreadcrumbs()

    return (
      <div
        className={classNames(
          'uppy-ProviderBrowser',
          `uppy-ProviderBrowser-viewType--${opts.viewType}`,
        )}
      >
        <Header<M, B>
          showBreadcrumbs={opts.showBreadcrumbs}
          openFolder={this.openFolder}
          breadcrumbs={breadcrumbs}
          pluginIcon={pluginIcon}
          title={this.plugin.title}
          logout={this.logout}
          username={username}
          i18n={i18n}
        />
        {opts.showFilter && (
          <FilterInput
            value={searchString}
            onChange={(s: string) => this.onSearchInput(s)}
            onSubmit={() => {}}
            inputLabel={i18n('filter')}
            i18n={i18n}
          />
        )}

        {searchResults ? (
          this.#renderSearchResults()
        ) : (
          <Browser<M, B>
            toggleCheckbox={this.toggleCheckbox}
            displayedPartialTree={this.getDisplayedPartialTree()}
            openFolder={this.openFolder}
            virtualList={opts.virtualList}
            noResultsLabel={i18n('noFilesFound')}
            handleScroll={this.handleScroll}
            viewType={opts.viewType}
            showTitles={opts.showTitles}
            i18n={this.plugin.uppy.i18n}
            isLoading={loading}
            utmSource="Companion"
          />
        )}

        <FooterActions
          partialTree={partialTree}
          donePicking={this.donePicking}
          cancelSelection={this.cancelSelection}
          i18n={i18n}
          validateAggregateRestrictions={this.validateAggregateRestrictions}
        />
      </div>
    )
  }
}
