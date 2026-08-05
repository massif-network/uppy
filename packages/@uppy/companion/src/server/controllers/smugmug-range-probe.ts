import type { Readable } from 'node:stream'
import type { Request, RequestHandler, Response } from 'express'
import { type SmugMugUserSession } from '../provider/smugmug/index.js'
import { mintSourceToken, validateSourceToken } from '../helpers/source-token.js'
import SmugMug, { SmugMugProbeError } from '../provider/smugmug/index.js'

const DEFAULT_MAX_PROBE_BYTES = 64 * 1024
const DEFAULT_PROBE_DEADLINE_MS = 10_000

type ProbeRange = { start: number; end: number }

const destroyStreamOnce = (getStream: () => Readable | undefined) => {
  let destroyed = false
  return () => {
    const stream = getStream()
    if (destroyed || stream == null) return
    destroyed = true
    stream.destroy()
  }
}
class ProbeRequestError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'ProbeRequestError'
    this.statusCode = statusCode
  }
}

const parsePositiveSafeInteger = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const parseRange = (value: string | undefined): ProbeRange => {
  if (value == null) {
    throw new ProbeRequestError('Range header is required', 400)
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(value)
  if (match == null) {
    throw new ProbeRequestError('Range must be one explicit byte range', 400)
  }
  const start = Number(match[1])
  const end = Number(match[2])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end
  ) {
    throw new ProbeRequestError('Range is invalid', 400)
  }
  const cap = parsePositiveSafeInteger(
    process.env['COMPANION_SMUGMUG_RANGE_PROBE_MAX_BYTES'],
    DEFAULT_MAX_PROBE_BYTES,
  )
  if (end - start + 1 > cap) {
    throw new ProbeRequestError('Range exceeds the probe limit', 400)
  }
  return { start, end }
}

const getProbeDeadlineMs = (): number =>
  parsePositiveSafeInteger(
    process.env['COMPANION_SMUGMUG_RANGE_PROBE_DEADLINE_MS'],
    DEFAULT_PROBE_DEADLINE_MS,
  )

const createProbeLifecycle = (
  req: Request,
  res: Response,
  onTerminate: () => void,
) => {
  const abortController = new AbortController()
  let settled = false
  const cleanup = () => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    req.off('aborted', onRequestAborted)
    res.off('close', onResponseClose)
    res.off('finish', cleanup)
  }
  const terminate = () => {
    if (settled) return
    abortController.abort()
    onTerminate()
    cleanup()
  }
  const onRequestAborted = () => terminate()
  const onResponseClose = () => {
    if (!res.writableEnded) terminate()
    else cleanup()
  }
  const deadline = setTimeout(() => {
    if (settled) return
    abortController.abort()
    onTerminate()
    if (res.headersSent) res.destroy()
    else res.status(504).json({ message: 'SmugMug probe deadline exceeded' })
    cleanup()
  }, getProbeDeadlineMs())
  deadline.unref()
  req.once('aborted', onRequestAborted)
  res.once('close', onResponseClose)
  res.once('finish', cleanup)
  return { signal: abortController.signal, cleanup }
}

export const isSmugMugAuthenticatedRangeProbeEnabled = (): boolean =>
  process.env['COMPANION_SMUGMUG_AUTH_RANGE_PROBE'] === 'true' &&
  process.env['NODE_ENV'] !== 'production'

const sendError = (res: Response, error: unknown): void => {
  if (error instanceof ProbeRequestError || error instanceof SmugMugProbeError) {
    res.status(error.statusCode).json({ message: error.message })
    return
  }
  res.status(502).json({ message: 'SmugMug probe request failed' })
}

export const isSmugMugRangeProbeEnabled = (): boolean =>
  process.env['COMPANION_SMUGMUG_RANGE_PROBE'] === 'true' &&
  process.env['NODE_ENV'] !== 'production'

export const requireSmugMugRangeProbeProvider: RequestHandler = (
  req,
  res,
  next,
) => {
  if (req.params['providerName'] !== 'smugmug') {
    res.sendStatus(404)
    return
  }
  next()
}

const getProviderAndId = (
  req: Request,
  res: Response,
): { provider: SmugMug; id: string } | undefined => {
  const provider = req.companion.provider
  const id = req.params['id']
  if (!(provider instanceof SmugMug) || typeof id !== 'string' || id.length === 0) {
    res.sendStatus(400)
    return undefined
  }
  return { provider, id }
}

export async function smugMugRangeProbeMetadata(
  req: Request,
  res: Response,
): Promise<void> {
  const request = getProviderAndId(req, res)
  if (request == null) return
  const lifecycle = createProbeLifecycle(req, res, () => { })
  try {
    const source = await request.provider.getProbeSource({
      id: request.id,
      providerUserSession: req.companion.providerUserSession as any,
      companion: req.companion,
      signal: lifecycle.signal,
    })
    if (lifecycle.signal.aborted) return
    res.set('Cache-Control', 'no-store').status(200).json(source.metadata)
  } catch (error) {
    if (!lifecycle.signal.aborted && !res.headersSent) sendError(res, error)
  } finally {
    lifecycle.cleanup()
  }
}

export default async function smugMugRangeProbe(
  req: Request,
  res: Response,
): Promise<void> {
  const request = getProviderAndId(req, res)
  if (request == null) return
  let upstreamStream: Readable | undefined
  const destroyUpstreamOnce = destroyStreamOnce(() => upstreamStream)
  const lifecycle = createProbeLifecycle(req, res, destroyUpstreamOnce)
  let streaming = false
  try {
    const range = parseRange(req.header('Range'))
    const source = await request.provider.getProbeSource({
      id: request.id,
      providerUserSession: req.companion.providerUserSession as any,
      companion: req.companion,
      signal: lifecycle.signal,
    })
    if (lifecycle.signal.aborted) return
    if (range.end >= source.metadata.size) {
      res.set('Content-Range', `bytes */${source.metadata.size}`)
      res.status(416).json({ message: 'Range exceeds source size' })
      return
    }

    const upstream = await request.provider.openProbeRange({
      companion: req.companion,
      providerUserSession: req.companion.providerUserSession as any,
      source,
      ...range,
      signal: lifecycle.signal,
    })
    upstreamStream = upstream.stream
    if (lifecycle.signal.aborted) {
      destroyUpstreamOnce()
      return
    }
    const onUpstreamError = () => {
      destroyUpstreamOnce()
      if (!res.headersSent) {
        res.status(502).json({ message: 'SmugMug range stream failed' })
      } else {
        res.destroy()
      }
      lifecycle.cleanup()
    }
    upstream.stream.once('error', onUpstreamError)
    res.once('finish', () => upstream.stream.off('error', onUpstreamError))
    res
      .set({
        'Cache-Control': 'no-store',
        'Content-Range': upstream.contentRange,
        'Content-Length': String(upstream.contentLength),
        'Content-Type': upstream.mimeType,
      })
      .status(206)
    streaming = true
    upstream.stream.pipe(res)
  } catch (error) {
    if (!lifecycle.signal.aborted && !res.headersSent) sendError(res, error)
  } finally {
    if (!streaming) lifecycle.cleanup()
  }
}


// ============================================================================
// Phase 1: Production source API (/smugmug/source/*)
// ============================================================================

export type PrepareRequest = {
  source_id: string   // Image ID (e.g., "image:ABC123")
}

export type PrepareResponse = {
  source_version: string
  size: number
  etag: string | null
  content_type: string
  accept_ranges: boolean
  chunk_max: number
  source_token: string  // HMAC token for bytes endpoint
}

const DEFAULT_CHUNK_MAX = 64 * 1024

export async function smugMugSourcePrepare(
  req: Request,
  res: Response,
): Promise<void> {
  const provider = req.companion.provider
  if (!(provider instanceof SmugMug)) {
    res.status(400).json({ message: 'Only SmugMug is supported' })
    return
  }

  let body: PrepareRequest
  try {
    body = req.body as PrepareRequest
  } catch {
    res.status(400).json({ message: 'Invalid JSON body' })
    return
  }

  if (!body.source_id) {
    res.status(400).json({ message: 'source_id is required' })
    return
  }

  const lifecycle = createProbeLifecycle(req, res, () => {})
  try {
    // Get OAuth token from the existing authenticated session
    const providerUserSession = req.companion.providerUserSession as SmugMugUserSession | undefined
    if (!providerUserSession?.accessToken) {
      res.status(401).json({ message: 'No authenticated session' })
      return
    }

    const source = await provider.getProbeSource({
      id: body.source_id,
      providerUserSession: providerUserSession as any,
      companion: req.companion,
      signal: lifecycle.signal,
    })

    if (lifecycle.signal.aborted) return

    const chunkMax = parsePositiveSafeInteger(
      process.env['COMPANION_SMUGMUG_SOURCE_CHUNK_MAX'],
      DEFAULT_CHUNK_MAX,
    )

    // Mint a source token for the bytes endpoint
    const secret = req.companion.options.secret
    const sourceToken = mintSourceToken({
      secret,
      sourceId: body.source_id,
      sourceVersion: source.sourceVersion,
      chunkMax,
    })

    const response: PrepareResponse = {
      source_version: source.sourceVersion,
      size: source.metadata.size,
      etag: source.metadata.etag ?? null,
      content_type: source.metadata.mimeType,
      accept_ranges: source.metadata.acceptRanges === 'bytes',
      chunk_max: chunkMax,
      source_token: sourceToken,  // Token for bytes endpoint
    }

    res.set({
      'Cache-Control': 'no-store',
      'X-Massif-Source-Version': source.sourceVersion,
    }).status(200).json(response)
  } catch (error) {
    if (!lifecycle.signal.aborted && !res.headersSent) {
      if (error instanceof ProbeRequestError || error instanceof SmugMugProbeError) {
        const statusCode = error instanceof ProbeRequestError ? error.statusCode : 502
        res.status(statusCode).json({ message: error.message })
        return
      }
      res.status(502).json({ message: 'Failed to prepare source' })
    }
  } finally {
    lifecycle.cleanup()
  }
}

export async function smugMugSourceBytes(
  req: Request,
  res: Response,
): Promise<void> {
  const provider = req.companion.provider
  if (!(provider instanceof SmugMug)) {
    res.status(400).json({ message: 'Only SmugMug is supported' })
    return
  }

  const sourceId = req.params['id']
  if (!sourceId) {
    res.status(400).json({ message: 'source_id is required' })
    return
  }

  const sourceToken = req.header('uppy-source-token')
  if (!sourceToken) {
    res.status(401).json({ message: 'uppy-source-token header is required' })
    return
  }

  // Validate the source token
  const secret = req.companion.options.secret
  const tokenPayload = validateSourceToken({ secret, token: sourceToken })
  if (!tokenPayload) {
    res.status(401).json({ message: 'Invalid or expired source token' })
    return
  }

  // Verify token matches the requested source
  if (tokenPayload.source_id !== sourceId) {
    res.status(401).json({ message: 'Source token does not match requested source' })
    return
  }

  const lifecycle = createProbeLifecycle(req, res, () => {})
  try {
    // OAuth session is already verified by middlewares.hasSessionAndProvider + verifyToken
    const providerUserSession = req.companion.providerUserSession as SmugMugUserSession | undefined

    const source = await provider.getProbeSource({
      id: sourceId,
      providerUserSession: providerUserSession as any,
      companion: req.companion,
      signal: lifecycle.signal,
    })

    if (lifecycle.signal.aborted) return

    // Verify source version hasn't changed
    if (tokenPayload.source_version !== source.sourceVersion) {
      res.status(409).json({ 
        message: 'Source has been modified',
        current_version: source.sourceVersion,
        expected_version: tokenPayload.source_version,
      })
      return
    }

    const range = parseRange(req.header('Range'))
    
    if (range.end >= source.metadata.size) {
      res.set('Content-Range', `bytes */${source.metadata.size}`)
      res.status(416).json({ message: 'Range exceeds source size' })
      return
    }

    // Enforce chunk max from token
    if (range.end - range.start + 1 > tokenPayload.chunk_max) {
      res.status(400).json({ 
        message: `Range exceeds token chunk_max (${tokenPayload.chunk_max})`,
      })
      return
    }

    const upstream = await provider.openProbeRange({
      companion: req.companion,
      providerUserSession: providerUserSession as any,
      source,
      ...range,
      signal: lifecycle.signal,
    })

    if (lifecycle.signal.aborted) return

    res.set({
      'Cache-Control': 'no-store',
      'Content-Range': upstream.contentRange,
      'Content-Length': String(upstream.contentLength),
      'Content-Type': upstream.mimeType,
      'ETag': source.metadata.etag || '',
      'Last-Modified': source.metadata.lastModified || '',
      'Accept-Ranges': source.metadata.acceptRanges || '',
      'X-Massif-Source-Version': source.sourceVersion,
    }).status(206)
    upstream.stream.pipe(res)
  } catch (error) {
    if (!lifecycle.signal.aborted && !res.headersSent) {
      if (error instanceof ProbeRequestError || error instanceof SmugMugProbeError) {
        const statusCode = error instanceof ProbeRequestError ? error.statusCode : 502
        res.status(statusCode).json({ message: error.message })
        return
      }
      res.status(502).json({ message: 'Failed to fetch source bytes' })
    }
  } finally {
    lifecycle.cleanup()
  }
}
