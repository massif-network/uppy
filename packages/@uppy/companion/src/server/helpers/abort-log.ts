import type { Request } from 'express'
import logger from '../logger.js'

/**
 * Identifies the remote file behind an upload for logging. Only the provider
 * name, the provider's file id and the file name are ever read: never the
 * request body as a whole, headers, query, or provider credentials.
 */
export type RemoteFileLogContext = {
  provider: string
  fileId?: string | undefined
  fileName?: string | undefined
}

export const SOCKET_WAIT_TIMER = 'socket-wait'
export const DOWNLOAD_UPLOAD_TIMER = 'download-or-upload'

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function remoteFileLogContext(req: Request): RemoteFileLogContext {
  const params: Record<string, unknown> = req.params ?? {}
  const body: unknown = req.body
  const metadata: unknown =
    body != null && typeof body === 'object'
      ? Reflect.get(body, 'metadata')
      : undefined
  const fileName =
    metadata != null && typeof metadata === 'object'
      ? firstString(Reflect.get(metadata, 'name'))
      : undefined
  // /:providerName/get/:id, or a fixed mount such as /url and /google-picker
  const provider =
    firstString(params['providerName']) ??
    firstString(req.baseUrl?.replace(/^\/+/, '').split('/')[0]) ??
    'unknown'
  return { provider, fileId: firstString(params['id']), fileName }
}

/**
 * True for an abort signal / timeout, whether it is the error itself or its
 * `cause` (`once()` rejects with an AbortError whose cause is the
 * TimeoutError DOMException from `AbortSignal.timeout`), and for got's
 * `TimeoutError` (code ETIMEDOUT).
 */
export function isAbortOrTimeout(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const name = Reflect.get(err, 'name')
  if (name === 'AbortError' || name === 'TimeoutError') return true
  if (Reflect.get(err, 'code') === 'ETIMEDOUT') return true
  const cause = Reflect.get(err, 'cause')
  return cause != null && cause !== err && isAbortOrTimeout(cause)
}

function describeError(err: unknown): string {
  if (err == null || typeof err !== 'object') return 'unknown'
  const name = String(Reflect.get(err, 'name') ?? 'Error')
  const cause = Reflect.get(err, 'cause')
  if (cause == null || typeof cause !== 'object') return name
  return `${name}(cause=${String(Reflect.get(cause, 'name') ?? 'Error')})`
}

/**
 * One line naming the upload, the remote file and the timer that fired.
 * Logging only: callers rethrow/handle the error exactly as before.
 */
export function logRemoteUploadAbort({
  err,
  shortToken,
  timer,
  timeoutMs,
  context,
}: {
  err: unknown
  shortToken: string
  timer: string
  timeoutMs: number | string
  context: RemoteFileLogContext
}): void {
  const parts = [
    `remote upload aborted: timer=${timer}`,
    `timeoutMs=${timeoutMs}`,
    `token=${shortToken}`,
    `provider=${context.provider}`,
    `fileId=${JSON.stringify(context.fileId ?? null)}`,
    `fileName=${JSON.stringify(context.fileName ?? null)}`,
    `error=${describeError(err)}`,
  ]
  logger.error(parts.join(' '), 'uploader.abort', shortToken)
}
