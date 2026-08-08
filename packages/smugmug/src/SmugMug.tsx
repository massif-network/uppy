import {
  type CompanionPluginOptions,
  getAllowedHosts,
  Provider,
} from '@uppy/companion-client'
import type {
  AsyncStore,
  Body,
  Meta,
  UnknownProviderPlugin,
  UnknownProviderPluginState,
  UppyFile,
} from '@uppy/core'
import { UIPlugin, type Uppy } from '@uppy/core'
import { ProviderViews } from '@uppy/provider-views'

import type { LocaleStrings } from '@uppy/utils'
// biome-ignore lint/style/useImportType: h is not a type
import { type ComponentChild, h } from 'preact'
import packageJson from '../package.json' with { type: 'json' }
import locale from './locale.js'
import { createMemoryStore } from './memory-store.js'
import {
  buildSourceRootFromPartialTree,
  resolveSourceRoots,
  type SmugMugSourceRoot,
} from './root-descriptor.js'
import {
  buildServiceWorkerGrant,
  type ServiceWorkerGrant,
} from './service-worker-grant.js'

export type DescriptorModeFooterOptions = {
  canImport: boolean
  onSelect: () => void
  onCancel: () => void
  /** Names of the resolved roots, for a label that says what will happen. */
  rootNames?: string[]
}

export function renderDescriptorModeFooter({
  canImport,
  onSelect,
  onCancel,
  rootNames = [],
}: DescriptorModeFooterOptions): h.JSX.Element {
  // Name the target when there's one, count them when there are several, so
  // the button always says what it is about to do.
  const label =
    rootNames.length === 1
      ? `Import ${rootNames[0]}`
      : rootNames.length > 1
        ? `Import ${rootNames.length} folders`
        : 'Import this album/folder'
  return (
    <div className="uppy-ProviderBrowser-footer uppy-SmugMug-descriptor-footer">
      <div className="uppy-ProviderBrowser-footer-buttons">
        <button
          className="uppy-u-reset uppy-c-btn uppy-c-btn-primary"
          disabled={!canImport}
          onClick={onSelect}
          type="button"
        >
          {label}
        </button>
        <button
          className="uppy-u-reset uppy-c-btn uppy-c-btn-link"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export type AuthPromptOptions = {
  /**
   * `connect` — no stored credential; offer the embedder's connect action.
   * `blocked` — connecting would discard queued work; explain instead.
   * `transient` — a credential exists, so the failed browse is something else
   *   (Uppy sets `authenticated: false` for ANY status >= 400, not just 401),
   *   and sending the user through OAuth would not fix it.
   */
  mode: 'connect' | 'blocked' | 'transient'
  message: string
  connectLabel?: string
  onConnect?: () => void
}

/**
 * Body for `renderAuthForm`, replacing Uppy's own "Connect to X" button.
 *
 * Lives here rather than in the embedding app for the same reason
 * `renderDescriptorModeFooter` does: this package already owns Preact, so the
 * app can pass plain data and never take a Preact dependency of its own — which
 * matters, because two Preact copies in one Dashboard render loop crash on
 * hooks (see massif's pnpm `preact` override).
 *
 * Renders inside Uppy's chrome: `AuthView` still draws the plugin icon and the
 * "Authenticate with SmugMug" heading around this.
 */
export function renderAuthPrompt({
  mode,
  message,
  connectLabel = 'Connect to SmugMug',
  onConnect,
}: AuthPromptOptions): h.JSX.Element {
  return (
    <div className="uppy-Provider-authForm uppy-SmugMug-authPrompt">
      <p>{message}</p>
      {mode === 'connect' ? (
        <button
          className="uppy-u-reset uppy-c-btn uppy-c-btn-primary"
          onClick={onConnect}
          type="button"
        >
          {connectLabel}
        </button>
      ) : null}
    </div>
  )
}

export type SmugMugOptions = CompanionPluginOptions & {
  locale?: LocaleStrings<typeof locale>
  /**
   * When true, browsing does not eagerly expand every page of every folder
   * (`loadAllFiles: false`) and the plugin exposes `selectRoot`
   * / `getServiceWorkerGrant` for the upload-Service-Worker import path.
   * Callers on this path must never invoke `donePicking()`.
   */
  rootDescriptorMode?: boolean
  /**
   * Replaces the form inside Uppy's auth screen (the one shown when the plugin
   * has no usable Companion token), so an embedder can offer its own connect
   * flow instead of `Provider.login()`'s OAuth popup.
   *
   * Passed straight through to `ProviderViewOptions.renderAuthForm`, which
   * `AuthView` calls in place of its default "Connect to SmugMug" button. The
   * plugin icon and the `authenticateWithTitle` heading still render around it.
   *
   * Args are Uppy's: `onAuth` is the popup handler, which an embedder
   * replacing the popup will simply not call.
   */
  renderAuthForm?: (args: {
    pluginName: string
    i18n: unknown
    loading: boolean | string
    onAuth: (authFormData: unknown) => Promise<void>
  }) => h.JSX.Element
  /**
   * Fired when `selectRoots()` resolves at least one root. Prefer this:
   * ticking several folders is the documented selection model, and each
   * root becomes its own location downstream.
   */
  onSourceRootsSelected?: (roots: SmugMugSourceRoot[]) => void
  /**
   * @deprecated Single-root callers only; ignored once
   * `onSourceRootsSelected` is supplied. Never fires for a multi-folder
   * selection, so a caller that can only represent one import session does
   * not silently start several.
   */
  onSourceRootSelected?: (root: SmugMugSourceRoot) => void
}

export type { SmugMugSourceRoot } from './root-descriptor.js'
export type { ServiceWorkerGrant } from './service-worker-grant.js'

export default class SmugMug<M extends Meta, B extends Body>
  extends UIPlugin<SmugMugOptions, M, B, UnknownProviderPluginState>
  implements UnknownProviderPlugin<M, B>
{
  static VERSION = packageJson.version

  icon: () => h.JSX.Element

  provider: Provider<M, B>

  view!: ProviderViews<M, B>

  storage: AsyncStore

  files: UppyFile<M, B>[]

  rootFolderId: string | null = null

  constructor(uppy: Uppy<M, B>, opts: SmugMugOptions) {
    super(uppy, opts)
    this.id = this.opts.id || 'SmugMug'
    this.type = 'acquirer'
    // Default to an in-memory store rather than `tokenStorage` (localStorage):
    // the upload Service Worker path re-supplies an ephemeral grant per
    // slice instead of persisting the Companion token across reloads.
    this.storage = this.opts.storage || createMemoryStore()
    this.files = []
    this.icon = () => (
      <svg
        className="uppy-DashboardTab-iconSmugMug"
        aria-hidden="true"
        focusable="false"
        width="22"
        height="22"
        viewBox="0 0 93 93"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="46" cy="46" r="37" fill="white" />
        <path
          d="M46.3214 0C20.7732 0 0 20.7877 0 46.3214C0 71.8552 20.7877 92.6428 46.3214 92.6428C71.8696 92.6428 92.6428 71.8552 92.6428 46.3214C92.6428 20.7732 71.8552 0 46.3214 0ZM46.3214 80.7992C27.1206 80.7992 11.4974 65.3347 11.4974 46.3214C11.4974 27.3081 27.1206 11.8436 46.3214 11.8436C65.5222 11.8436 81.1454 27.3081 81.1454 46.3214C81.1454 65.3347 65.5222 80.7992 46.3214 80.7992Z"
          fill="#252626"
        />
        <path
          d="M56.5204 36.2666C56.7224 36.2666 56.9099 36.2666 57.1119 36.2522C59.5498 36.1223 61.5262 35.4732 62.9688 34.3191C64.3825 33.1939 65.1759 31.6503 65.1904 29.9769V29.6451C65.1038 28.1016 64.3825 26.659 63.1563 25.5626C61.555 24.1633 59.3335 23.4997 56.8811 23.6872L56.6214 23.7161C52.7985 24.12 50.5337 26.7167 49.9855 29.1835L49.8845 29.7317C49.6393 31.5061 50.2163 33.2372 51.4425 34.4489C52.6687 35.6607 54.4143 36.281 56.506 36.281L56.5204 36.2666Z"
          fill="#252626"
        />
        <path
          d="M64.8586 42.5849C63.4449 41.5463 61.6272 41.0269 59.4489 41.0269L58.1217 41.1424C49.9279 41.9358 47.9804 42.1233 35.3145 42.4263L28.8661 42.5705C27.2793 42.5849 25.9233 43.2341 24.9567 44.4314C24.1633 45.4124 23.6728 46.7252 23.4997 48.3409C23.2112 51.125 23.9037 54.6882 25.4184 58.136C28.4045 64.9162 35.0981 72.1579 44.8788 72.1579C49.1922 72.1579 53.5343 70.5422 57.4726 67.4695C60.8338 64.844 63.719 61.2808 65.6232 57.4291C67.5563 53.4909 68.2343 49.7113 67.5274 46.7829C67.109 45.0373 66.1714 43.5803 64.8298 42.5994L64.8586 42.5849ZM56.8234 55.5538C54.7173 59.2035 50.6203 63.1129 45.4703 63.1418C38.0843 63.1418 34.4633 58.8717 32.9631 56.3183C31.6792 54.14 31.3762 52.3657 31.3041 51.7021C31.2897 51.5578 31.2753 51.428 31.2753 51.2982C39.1229 50.9952 44.3018 50.7067 48.3555 50.4615L49.4518 50.4037C51.9475 50.2595 53.9094 50.1441 55.8425 50.0575L58.0785 49.9854H58.1073C58.2227 49.9854 58.2805 49.9854 58.2805 49.9854C58.3093 50.0287 58.4103 50.2306 58.4247 50.6923C58.4535 51.9473 57.8477 53.7505 56.8234 55.5394V55.5538Z"
          fill="#252626"
        />
        <path
          d="M34.9681 36.7716C34.9681 36.7716 35.0835 36.7716 35.1412 36.7716L36.0788 36.7283C40.5509 36.3243 43.6524 33.5257 43.436 30.0635L43.4071 29.7173C43.0321 26.7312 40.2768 24.6106 36.3529 24.3365L35.5595 24.3076H35.5018C31.4626 24.3076 28.9669 27.1062 28.3466 29.7317L28.2456 30.2943C28.0004 32.011 28.5341 33.67 29.6738 34.8529C30.9 36.108 32.7176 36.7716 34.9536 36.7716H34.9681Z"
          fill="#252626"
        />
      </svg>
    )

    this.opts.companionAllowedHosts = getAllowedHosts(
      this.opts.companionAllowedHosts,
      this.opts.companionUrl,
    )
    this.provider = new Provider(uppy, {
      companionUrl: this.opts.companionUrl,
      companionHeaders: this.opts.companionHeaders,
      companionKeysParams: this.opts.companionKeysParams,
      companionCookiesRule: this.opts.companionCookiesRule,
      provider: 'smugmug',
      pluginId: this.id,
      // SmugMug is OAuth 1.0a: tokens don't expire and there is no refresh token.
      supportsRefreshToken: false,
    })

    this.defaultLocale = locale

    this.i18nInit()
    this.title = this.i18n('pluginNameSmugMug')

    this.render = this.render.bind(this)
  }

  install(): void {
    this.view = new ProviderViews(this, {
      provider: this.provider,
      // `loadAllFiles: true` eagerly drains every page of every opened
      // folder — the exact recursive-materialization defect the SW import
      // path exists to avoid. In that mode, browsing stays paginated; the
      // SW's own bounded enumerator (not this view) walks the selected root.
      loadAllFiles: !this.opts.rootDescriptorMode,
      virtualList: true,
      // Undefined is the same as absent here: ProviderView falls back to
      // AuthView's own default form.
      renderAuthForm: this.opts.renderAuthForm,
      ...(this.opts.rootDescriptorMode
        ? {
            // The param type is annotated rather than inferred: this file is
            // mirrored into massif-network/massif, where @uppy/provider-views
            // resolves to the *public* 5.2.2, which has no `renderFooter` in
            // its options type. Without the annotation the binding infers as
            // `any` and fails under `strict` there (TS7031). Shape matches
            // ProviderViewOptions.renderFooter in this fork.
            renderFooter: ({
              cancelSelection,
            }: {
              cancelSelection: () => void
            }) => {
              const { currentFolderId, partialTree } = this.getPluginState()
              const roots = resolveSourceRoots(currentFolderId, partialTree)
              return renderDescriptorModeFooter({
                canImport: roots.length > 0,
                rootNames: roots.map((r) => r.name),
                onSelect: () => {
                  this.selectRoots()
                },
                onCancel: cancelSelection,
              })
            },
          }
        : {}),
    })

    const { target } = this.opts
    if (target) {
      this.mount(target, this)
    }
  }

  uninstall(): void {
    this.view.tearDown()
    this.unmount()
  }

  render(state: unknown): ComponentChild {
    return this.view.render(state)
  }

  /**
   * Resolve the import root — a ticked folder if there is exactly one,
   * otherwise the folder currently open — and hand it to
   * `onSourceRootSelected`.
   *
   * Deliberately does NOT call `ProviderViews.donePicking()`: that path
   * recursively drains every checked folder (`afterFill`) and materializes
   * every descendant file into Uppy, which is exactly what root-descriptor
   * mode exists to avoid at 10,000+ image scale.
   *
   * Returns `null` when nothing resolves: at the account root with nothing
   * ticked (too broad a target), or with several folders ticked (each would
   * need its own import session — see `resolveSourceRoot`).
   */
  selectRoots(): SmugMugSourceRoot[] {
    const { currentFolderId, partialTree } = this.getPluginState()
    const roots = resolveSourceRoots(currentFolderId, partialTree)
    if (roots.length > 0) {
      this.opts.onSourceRootsSelected?.(roots)
      // Back-compat for callers wired before multi-root. Firing it for every
      // root would start N unrelated import sessions in a caller that only
      // expects one, so it only fires when the selection really is single.
      if (roots.length === 1 && this.opts.onSourceRootsSelected == null) {
        this.opts.onSourceRootSelected?.(roots[0]!)
      }
    }
    return roots
  }

  /** @deprecated Use `selectRoots()`. */
  selectRoot(): SmugMugSourceRoot | null {
    return this.selectRoots()[0] ?? null
  }

  /**
   * @deprecated Use `selectRoot()`, which also honours a ticked folder.
   * Kept so an existing caller that only ever meant "the open folder"
   * doesn't change behaviour underneath it.
   */
  selectCurrentFolderAsRoot(): SmugMugSourceRoot | null {
    const { currentFolderId, partialTree } = this.getPluginState()
    const root = buildSourceRootFromPartialTree(currentFolderId, partialTree)
    if (root != null) {
      this.opts.onSourceRootSelected?.(root)
    }
    return root
  }

  /**
   * Mint an ephemeral grant for the page to post to the upload Service
   * Worker immediately before a slice. Only the allowlisted Companion
   * headers are included; the underlying token/secret never leave this
   * plugin's in-memory store.
   */
  async getServiceWorkerGrant(): Promise<ServiceWorkerGrant> {
    const headers = await this.provider.headers()
    const companionUrl = this.opts.companionUrl
    if (companionUrl == null) {
      throw new Error(
        'SmugMug: companionUrl is required to mint a Service Worker grant',
      )
    }
    return buildServiceWorkerGrant(companionUrl, headers, Date.now())
  }
}
declare module '@uppy/core' {
  export interface PluginTypeRegistry<M extends Meta, B extends Body> {
    SmugMug: SmugMug<M, B>
  }
}
