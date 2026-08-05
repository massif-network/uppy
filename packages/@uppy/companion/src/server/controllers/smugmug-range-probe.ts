import type { Readable } from 'node:stream'
import type { Request, RequestHandler, Response } from 'express'
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
