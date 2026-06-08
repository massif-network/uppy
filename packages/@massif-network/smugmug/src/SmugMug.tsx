import {
  type CompanionPluginOptions,
  getAllowedHosts,
  Provider,
  tokenStorage,
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

export type SmugMugOptions = CompanionPluginOptions & {
  locale?: LocaleStrings<typeof locale>
}

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
    this.storage = this.opts.storage || tokenStorage
    this.files = []
    this.icon = () => (
      <svg
        className="uppy-DashboardTab-iconSmugMug"
        aria-hidden="true"
        focusable="false"
        width="32"
        height="32"
        viewBox="0 0 32 32"
      >
        <g fill="none" fillRule="evenodd">
          <rect width="32" height="32" rx="6" fill="#6FBF2F" />
          <path
            fill="#fff"
            d="M9 21.5l4.8-6 3 3.6 2.2-2.8L23 21.5H9zM11.5 12.5a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z"
          />
        </g>
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
      loadAllFiles: true,
      virtualList: true,
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
}

declare module '@uppy/core' {
  export interface PluginTypeRegistry<M extends Meta, B extends Body> {
    SmugMug: SmugMug<M, B>
  }
}
