import type { AsyncStore, UIPluginOptions } from '@uppy/core'

export interface CompanionPluginOptions extends UIPluginOptions {
  storage?: AsyncStore
  companionUrl: string
  companionHeaders?: Record<string, string>
  companionKeysParams?: { key: string; credentialsName: string }
  companionCookiesRule?: 'same-origin' | 'include'
  companionAllowedHosts?: string | RegExp | (string | RegExp)[]
  /**
   * Extra query params merged into the OAuth popup's connect URL (e.g. an
   * identifier the server can bind the resulting token to). Applied before
   * the protocol params (`state`, `uppyPreAuthToken`, `authCallbackToken`),
   * so it cannot override them.
   */
  extraAuthQueryParams?: Record<string, string>
}
