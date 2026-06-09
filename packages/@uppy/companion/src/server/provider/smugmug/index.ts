import crypto from 'node:crypto'
import type { Readable } from 'node:stream'
import got, { type Got } from 'got'
import OAuth from 'oauth-1.0a'
import type { ProviderOptions } from '../../../schemas/companion.js'
import type { GrantResponse } from '../../../types/express.js'
import { isRecord } from '../../helpers/type-guards.js'
import { prepareStream } from '../../helpers/utils.js'
import Provider, {
  type CompanionLike,
  type ProviderListResponse,
  type Query,
} from '../Provider.js'
import { withProviderErrorHandling } from '../providerErrors.js'
import {
  adaptAlbumImages,
  adaptNodeChildren,
  type SmugMugAlbumImagesResponse,
  type SmugMugNodeChildrenResponse,
} from './adapter.js'

const API_HOST = 'https://api.smugmug.com'
const API_BASE = `${API_HOST}/api/v2`
const PAGE_SIZE = 100

// SmugMug is OAuth 1.0a: there's no Bearer token. Every request is signed with the
// consumer (app) key/secret plus the user's access token/secret.
type SmugMugUserSession = {
  accessToken: string
  accessTokenSecret?: string
}

type Consumer = { key: string; secret: string }

type CompanionWithOptions = {
  options: {
    providerOptions?:
      | Record<string, Pick<ProviderOptions, 'key' | 'secret'>>
      | undefined
  }
}

type AuthUserResponse = {
  Response?: {
    User?: {
      Name?: string
      NickName?: string
      Uris?: { Node?: { Uri?: string } }
    }
  }
}

type ImageResponse = {
  Response?: {
    Image?: { ArchivedUri?: string; ArchivedSize?: number }
  }
}

const getConsumer = (companion: CompanionWithOptions): Consumer => {
  const opts = companion.options.providerOptions?.['smugmug']
  if (!opts?.key || !opts?.secret) {
    // Fail fast with a clear message rather than signing with empty strings,
    // which produces opaque OAuth-signature errors downstream.
    throw new Error(
      'SmugMug provider is not configured: set COMPANION_SMUGMUG_API_KEY and COMPANION_SMUGMUG_API_SECRET',
    )
  }
  return { key: opts.key, secret: opts.secret }
}

/**
 * Build a `got` client that OAuth1-signs every outgoing request via a `beforeRequest`
 * hook. Works for both the JSON API (api.smugmug.com) and CDN downloads, since the
 * signature is computed from whatever URL the request ends up targeting.
 */
const getClient = ({
  consumer,
  token,
  tokenSecret,
}: {
  consumer: Consumer
  token: string
  tokenSecret: string | undefined
}): Got => {
  const oauth = new OAuth({
    consumer,
    signature_method: 'HMAC-SHA1',
    hash_function(baseString, hashKey) {
      return crypto
        .createHmac('sha1', hashKey)
        .update(baseString)
        .digest('base64')
    },
  })
  const oauthToken = { key: token, secret: tokenSecret ?? '' }

  return got.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          const url = options.url as URL
          // OAuth1 base string must include the query params, so feed them in as `data`.
          // oauth-1.0a strips the query from `url` itself and re-derives it from `data`.
          const data = Object.fromEntries(url.searchParams.entries())
          const method = (options.method ?? 'GET').toUpperCase()
          const { Authorization } = oauth.toHeader(
            oauth.authorize({ url: url.toString(), method, data }, oauthToken),
          )
          options.headers['authorization'] = Authorization
        },
      ],
    },
  })
}

// SmugMug only returns JSON when explicitly asked.
const apiGet = async <T>(
  client: Got,
  path: string,
  searchParams?: Record<string, string | number>,
): Promise<T> =>
  client
    .get(`${API_BASE}/${path}`, {
      searchParams,
      headers: { Accept: 'application/json' },
      responseType: 'json',
    })
    .json<T>()

// Follow a SmugMug `NextPage` cursor (a relative `/api/v2/...` URI).
const apiGetCursor = async <T>(client: Got, cursor: string): Promise<T> =>
  client
    .get(`${API_HOST}${cursor}`, {
      headers: { Accept: 'application/json' },
      responseType: 'json',
    })
    .json<T>()

/**
 * SmugMug provider.
 * Docs: https://api.smugmug.com/api/v2/doc/index.html
 */
export default class SmugMug extends Provider<SmugMugUserSession> {
  static override get oauthProvider() {
    return 'smugmug'
  }

  // OAuth1 returns an `access_secret` alongside the token; persist it so we can sign API calls.
  static override grantResponseToUserSession({
    grantResponse,
  }: {
    grantResponse: GrantResponse | undefined
  }): Record<string, unknown> {
    return { accessTokenSecret: grantResponse?.access_secret }
  }

  override async list({
    directory,
    providerUserSession,
    query,
    companion,
  }: {
    directory?: string | undefined
    providerUserSession: SmugMugUserSession
    query?: Query
    companion: CompanionWithOptions
  }): Promise<ProviderListResponse> {
    return this.#withErrorHandling('provider.smugmug.list.error', async () => {
      const client = getClient({
        consumer: getConsumer(companion),
        token: providerUserSession.accessToken,
        tokenSecret: providerUserSession.accessTokenSecret,
      })
      const cursor =
        typeof query?.['cursor'] === 'string' ? query['cursor'] : undefined

      // Album: list its images.
      if (directory?.startsWith('album:')) {
        const albumKey = directory.slice('album:'.length)
        const res = cursor
          ? await apiGetCursor<SmugMugAlbumImagesResponse>(client, cursor)
          : await apiGet<SmugMugAlbumImagesResponse>(
              client,
              `album/${albumKey}!images`,
              { _count: PAGE_SIZE },
            )
        return adaptAlbumImages(res, undefined)
      }

      // Folder node: list its children.
      if (directory?.startsWith('node:')) {
        const nodeId = directory.slice('node:'.length)
        const res = cursor
          ? await apiGetCursor<SmugMugNodeChildrenResponse>(client, cursor)
          : await apiGet<SmugMugNodeChildrenResponse>(
              client,
              `node/${nodeId}!children`,
              { _count: PAGE_SIZE },
            )
        return adaptNodeChildren(res, undefined)
      }

      // Root: resolve the authenticated user → their root node → its children.
      const authUser = await apiGet<AuthUserResponse>(client, '!authuser')
      const user = authUser.Response?.User
      const username = user?.Name || user?.NickName
      const rootNodeId = user?.Uris?.Node?.Uri?.split('/').pop()
      if (!cursor && !rootNodeId) {
        throw new Error(
          'SmugMug !authuser response did not include a root node Uri',
        )
      }
      const res = cursor
        ? await apiGetCursor<SmugMugNodeChildrenResponse>(client, cursor)
        : await apiGet<SmugMugNodeChildrenResponse>(
            client,
            `node/${rootNodeId}!children`,
            { _count: PAGE_SIZE },
          )
      return adaptNodeChildren(res, username)
    })
  }

  override async download({
    id,
    providerUserSession,
    companion,
  }: {
    id: string
    providerUserSession: SmugMugUserSession
    companion: CompanionLike
  }): Promise<{ stream: Readable; size: number | undefined }> {
    return this.#withErrorHandling(
      'provider.smugmug.download.error',
      async () => {
        const client = getClient({
          consumer: getConsumer(companion),
          token: providerUserSession.accessToken,
          tokenSecret: providerUserSession.accessTokenSecret,
        })
        const imageKey = id.startsWith('image:')
          ? id.slice('image:'.length)
          : id

        // Resolve the original file URL, then stream the bytes (both OAuth1-signed).
        const meta = await apiGet<ImageResponse>(client, `image/${imageKey}`, {
          _filter: 'ArchivedUri,ArchivedSize',
        })
        const image = meta.Response?.Image
        if (!image?.ArchivedUri) {
          throw new Error(`SmugMug image ${imageKey} has no ArchivedUri`)
        }

        const stream = client.stream.get(image.ArchivedUri)
        const { size } = await prepareStream(stream)
        return { stream, size: size ?? image.ArchivedSize }
      },
    )
  }

  override async logout(): Promise<{
    revoked: boolean
    manual_revoke_url: string
  }> {
    // SmugMug has no token-revoke API; users revoke from their account page.
    return {
      revoked: false,
      manual_revoke_url: 'https://www.smugmug.com/account/authorizedservices',
    }
  }

  async #withErrorHandling<T>(tag: string, fn: () => Promise<T>): Promise<T> {
    return withProviderErrorHandling({
      fn,
      tag,
      providerName: SmugMug.oauthProvider as string,
      isAuthError: (response) => response.statusCode === 401,
      getJsonErrorMessage: (body) => {
        if (!isRecord(body)) return undefined
        const msg = body['Message']
        return typeof msg === 'string' ? msg : undefined
      },
    })
  }
}
