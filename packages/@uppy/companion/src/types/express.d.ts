import type { S3Client } from '@aws-sdk/client-s3'
import { CredentialsFetchResponse } from '../schemas/companion.js'
import type Provider from '../server/provider/Provider.js'
import type { CompanionRuntimeOptions } from './companion-options.js'

export type BuildUrl = (
  subPath: string,
  isExternal: boolean,
  excludeHost?: boolean,
) => string

export interface ProviderGrantConfig {
  dynamic?: string[]
  redirect_uri?: string | undefined
}

export interface ProviderUserSession {
  accessToken?: string
  refreshToken?: string | undefined
  [key: string]: unknown
}

export type CompanionContext = {
  options: CompanionRuntimeOptions
  provider?: Provider
  providerName?: string
  providerClass?: typeof Provider
  providerGrantConfig?: ProviderGrantConfig
  providerUserSession?: ProviderUserSession | undefined
  authToken?: string | undefined
  buildURL?: BuildUrl
  s3Client?: S3Client
  s3ClientCreatePresignedPost?: S3Client
  getProviderCredentials?: () => Promise<CredentialsFetchResponse | null>
}

export interface GrantDynamic {
  state?: string
}

// The `response` object Grant stores in the session after the OAuth handshake.
// OAuth2 providers populate `access_token`/`refresh_token`; OAuth1 providers
// (e.g. SmugMug) populate `access_token`/`access_secret` instead.
export interface GrantResponse {
  access_token?: string
  refresh_token?: string
  access_secret?: string
  raw?: Record<string, unknown>
}

export interface CompanionSession {
  grant?: {
    state?: string | null
    dynamic?: GrantDynamic | null
    response?: GrantResponse
  }
}

export interface CompanionExpressLocals {
  grant?: {
    dynamic?: {
      key?: string
      secret?: string
      origins?: string[]
      redirect_uri?: string
    } | null
  }
}

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Request {
      companion: CompanionContext
      id?: string
      cookies?: Record<string, string>
      session?: CompanionSession
    }
  }
}
