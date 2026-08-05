import crypto from 'node:crypto'
import type { Readable } from 'node:stream'
import got, { type Got, HTTPError } from 'got'
import OAuth from 'oauth-1.0a'
import type { ProviderOptions } from '../../../schemas/companion.js'
import type { GrantResponse } from '../../../types/express.js'
import { getProtectedGot } from '../../helpers/request.js'
import { isRecord } from '../../helpers/type-guards.js'
import { prepareStream } from '../../helpers/utils.js'
import logger from '../../logger.js'
import Provider, {
  type CompanionLike,
  type ProviderListResponse,
  type Query,
} from '../Provider.js'
import { withProviderErrorHandling } from '../providerErrors.js'
import {
  adaptAlbumImages,
  adaptNodeChildren,
  getUri,
  type SmugMugAlbumImagesResponse,
  type SmugMugNodeChildrenResponse,
  type SmugMugRef,
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
    Image?: {
      Uri?: string
      ImageKey?: string
      Serial?: number
      ArchivedUri?: string
      ArchivedSize?: number
      ArchivedMD5?: string
      LastUpdated?: string
      Uris?: { ImageSizeDetails?: SmugMugRef }
    }
  }
}

type ImageSizeDetailsResponse = {
  Response?: {
    ImageSizeDetails?: {
      ImageSizeOriginal?: {
        Url?: string
        Size?: number
        MimeType?: string
      }
    }
  }
}

export class SmugMugProbeError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'SmugMugProbeError'
    this.statusCode = statusCode
  }
}

type SmugMugProbeSource = {
  originalUrl: string
  metadata: {
    canonicalUri: string
    imageKey: string
    serial: number
    archivedSize: number | undefined
    archivedMd5: string | undefined
    lastUpdated: string
    size: number
    mimeType: string
    etag: string | undefined
    lastModified: string | undefined
    acceptRanges: string | undefined
  }
}

export type SmugMugProbeRange = {
  stream: Readable
  contentRange: string
  contentLength: number
  mimeType: string
}

// `image:<ImageKey>` ids are stored by the adapter; CDN downloads and metadata
// lookups both want the bare key.
const toImageKey = (id: string): string => {
  const match = /^image:([A-Za-z0-9-]+)$/.exec(id)
  if (match == null) {
    throw new SmugMugProbeError('SmugMug image id is invalid', 400)
  }
  return match[1]
}
const getHeader = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

const getProbeMimeType = (candidate: string | undefined): string =>
  candidate != null && /^[\w.+-]+\/[\w.+-]+$/.test(candidate)
    ? candidate
    : 'application/octet-stream'

const getProbeUrl = (candidate: string | undefined): string => {
  if (candidate == null) {
    throw new SmugMugProbeError(
      'SmugMug original metadata is unavailable',
      502,
    )
  }
  try {
    const url = new URL(candidate)
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'photos.smugmug.com' &&
        !url.hostname.endsWith('.photos.smugmug.com'))
    ) {
      throw new Error('untrusted original host')
    }
    return url.toString()
  } catch {
    throw new SmugMugProbeError(
      'SmugMug original metadata is unavailable',
      502,
    )
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

const getPublicProbeKey = (companion: CompanionWithOptions): string => {
  const key = companion.options.providerOptions?.['smugmug']?.key
  if (!key) {
    throw new SmugMugProbeError(
      'SmugMug public probe is not configured',
      503,
    )
  }
  return key
}

// SmugMug only returns JSON when explicitly asked.
const apiGet = async <T>(
  client: Got,
  path: string,
  searchParams?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T> =>
  client
    .get(`${API_BASE}/${path}`, {
      ...(searchParams != null && { searchParams }),
      ...(signal != null && { signal }),
      headers: { Accept: 'application/json' },
      responseType: 'json',
    })
    .json<T>()
const apiGetCursor = async <T>(
  client: Got,
  cursor: string,
  searchParams?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T> =>
  client
    .get(`${API_HOST}${cursor}`, {
      ...(searchParams != null && { searchParams }),
      ...(signal != null && { signal }),
      headers: { Accept: 'application/json' },
      responseType: 'json',
    })
    .json<T>()
const apiGetUri = async <T>(
  client: Got,
  uri: string,
  searchParams?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T> =>
  uri.startsWith('/api/v2/')
    ? apiGetCursor<T>(client, uri, searchParams, signal)
    : apiGet<T>(client, uri, searchParams, signal)
/**
 * Run `fn`, retrying on SmugMug 429 rate-limit responses with backoff. Honours a
 * `Retry-After` header (seconds or HTTP-date) when present, otherwise falls back
 * to exponential backoff, capped at 30s per wait. Mirrors the Dropbox provider.
 */
const withRateLimitRetry = async <T>(
  fn: () => Promise<T>,
  tag: string,
): Promise<T> => {
  const maxRetries = 3
  const maxWaitTime = 30000 // 30 seconds in milliseconds

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1
      if (
        !(error instanceof HTTPError) ||
        error.response.statusCode !== 429 ||
        isLastAttempt
      ) {
        throw error
      }

      const retryAfter = error.response.headers['retry-after']
      logger.warn(
        `SmugMug API rate limit hit with retry-after ${retryAfter}. Retrying attempt ${attempt + 1} of ${maxRetries}...`,
        tag,
      )

      let waitTime: number
      if (typeof retryAfter === 'string') {
        // Retry-After can be in seconds (integer) or HTTP date format.
        waitTime = /^\d+$/.test(retryAfter)
          ? parseInt(retryAfter, 10) * 1000
          : new Date(retryAfter).getTime() - Date.now()
      } else {
        // No Retry-After header, use exponential backoff: 1s, 2s, 4s, ...
        waitTime = 1000 * 2 ** attempt
      }

      // Clamp to [0, maxWaitTime] before sleeping.
      waitTime = Math.min(Math.max(0, waitTime), maxWaitTime)
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }
  }
  return undefined as T
}

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
        return adaptAlbumImages(res, undefined, directory)
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
        return adaptNodeChildren(res, undefined, directory)
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
      return adaptNodeChildren(res, username, directory)
    })
  }

  async getProbeSource({
    id,
    companion,
    signal,
  }: {
    id: string
    companion: CompanionWithOptions
    signal?: AbortSignal
  }): Promise<SmugMugProbeSource> {
    try {
      const apiKey = getPublicProbeKey(companion)
      const imageKey = toImageKey(id)
      const imageResponse = await apiGet<ImageResponse>(
        got,
        `image/${imageKey}`,
        { APIKey: apiKey },
        signal,
      )
      const image = imageResponse.Response?.Image
      const imageSizeDetailsUri = getUri(image?.Uris?.ImageSizeDetails)
      if (
        image?.Uri == null ||
        image.ImageKey == null ||
        !Number.isSafeInteger(image.Serial) ||
        image.Serial < 0 ||
        image.LastUpdated == null ||
        imageSizeDetailsUri == null
      ) {
        throw new SmugMugProbeError(
          'SmugMug image metadata is incomplete',
          502,
        )
      }

      const imageSizeDetails = await apiGetUri<ImageSizeDetailsResponse>(
        got,
        imageSizeDetailsUri,
        { APIKey: apiKey },
        signal,
      )
      const original = imageSizeDetails.Response?.ImageSizeDetails
        ?.ImageSizeOriginal
      const size = original?.Size ?? image.ArchivedSize
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new SmugMugProbeError(
          'SmugMug original metadata is incomplete',
          502,
        )
      }
      const originalUrl = getProbeUrl(original?.Url)
      const protectedGot = getProtectedGot({ allowLocalIPs: false })
      const head = await protectedGot.head(originalUrl, {
        throwHttpErrors: false,
        followRedirect: false,
        ...(signal != null && { signal }),
      })
      if (head.statusCode < 200 || head.statusCode >= 300) {
        throw new SmugMugProbeError(
          'SmugMug original metadata request failed',
          502,
        )
      }
      const contentLength = getHeader(head.headers, 'content-length')
      if (
        (original?.Size == null && contentLength == null) ||
        (contentLength != null &&
          (!/^\d+$/.test(contentLength) || Number(contentLength) !== size))
      ) {
        throw new SmugMugProbeError(
          'SmugMug original metadata is inconsistent',
          502,
        )
      }

      return {
        originalUrl,
        metadata: {
          canonicalUri: image.Uri,
          imageKey: image.ImageKey,
          serial: image.Serial,
          archivedSize: image.ArchivedSize,
          archivedMd5: image.ArchivedMD5,
          lastUpdated: image.LastUpdated,
          size,
          mimeType: getProbeMimeType(
            original?.MimeType ?? getHeader(head.headers, 'content-type'),
          ),
          etag: getHeader(head.headers, 'etag'),
          lastModified: getHeader(head.headers, 'last-modified'),
          acceptRanges: getHeader(head.headers, 'accept-ranges'),
        },
      }
    } catch (error) {
      if (error instanceof SmugMugProbeError) throw error
      throw new SmugMugProbeError(
        'SmugMug original metadata request failed',
        502,
      )
    }
  }

  async openProbeRange({
    source,
    start,
    end,
    signal,
  }: {
    source: SmugMugProbeSource
    start: number
    end: number
    signal?: AbortSignal
  }): Promise<SmugMugProbeRange> {
    const protectedGot = getProtectedGot({ allowLocalIPs: false })
    const stream = protectedGot.stream.get(source.originalUrl, {
      headers: { Range: `bytes=${start}-${end}` },
      throwHttpErrors: false,
      followRedirect: false,
      ...(signal != null && { signal }),
    })
    try {
      const response = await new Promise<{
        statusCode?: number
        headers: Record<string, string | string[] | undefined>
      }>((resolve, reject) => {
        const onError = (error: Error) => {
          stream.off('response', onResponse)
          reject(error)
        }
        const onResponse = (result: {
          statusCode?: number
          headers: Record<string, string | string[] | undefined>
        }) => {
          stream.off('error', onError)
          resolve(result)
        }
        stream.once('error', onError)
        stream.once('response', onResponse)
      })
      const expectedContentRange = `bytes ${start}-${end}/${source.metadata.size}`
      const expectedContentLength = end - start + 1
      const contentRange = getHeader(response.headers, 'content-range')
      const contentLength = getHeader(response.headers, 'content-length')
      if (
        response.statusCode !== 206 ||
        contentRange !== expectedContentRange ||
        contentLength !== String(expectedContentLength)
      ) {
        stream.destroy()
        throw new SmugMugProbeError(
          'SmugMug original did not honor the requested range',
          502,
        )
      }
      return {
        stream,
        contentRange,
        contentLength: expectedContentLength,
        mimeType: getProbeMimeType(
          getHeader(response.headers, 'content-type') ??
          source.metadata.mimeType,
        ),
      }
    } catch (error) {
      if (!stream.destroyed) stream.destroy()
      if (error instanceof SmugMugProbeError) throw error
      throw new SmugMugProbeError('SmugMug range request failed', 502)
    }
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
        const imageKey = toImageKey(id)

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

  /**
   * Get metadata for a single image.
   *
   * `image/<ImageKey>!metadata` returns the EXIF/IPTC payload (camera make/model,
   * exposure, aperture, ISO, focal length, lens, GPS, copyright, …).
   */
  override async getFileMetadata({
    fileId,
    providerUserSession,
    companion,
  }: {
    fileId: string
    providerUserSession: SmugMugUserSession
    companion: CompanionWithOptions
  }): Promise<unknown> {
    return this.#withErrorHandling(
      'provider.smugmug.getFileMetadata.error',
      async () => {
        const client = getClient({
          consumer: getConsumer(companion),
          token: providerUserSession.accessToken,
          tokenSecret: providerUserSession.accessTokenSecret,
        })
        const imageKey = toImageKey(fileId)

        const metadata = await withRateLimitRetry(
          () =>
            apiGet<{ Response?: { ImageMetadata?: unknown } }>(
              client,
              `image/${imageKey}!metadata`,
            ),
          'provider.smugmug.getFileMetadata.ratelimit',
        )

        return metadata.Response?.ImageMetadata
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
