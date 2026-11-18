import { Readable } from 'node:stream'
import type { Request } from 'express'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defaultOptions } from '../src/config/companion.js'
import { remoteFileLogContext } from '../src/server/helpers/abort-log.js'
import Uploader from '../src/server/Uploader.js'

process.env['FORCE_COLOR'] = 'false'

const ACCESS_TOKEN = 'sl.SECRET-dropbox-access-token-1234567890'
const FILE_ID = 'id:abc123'
const FILE_NAME = 'holiday.mov'

const companionOptions = {
  ...defaultOptions,
  secret: '',
  filePath: './test/output',
  server: { ...defaultOptions.server, host: '' },
}

// Token-shaped values sit in the body, query and headers: none may be logged.
const fakeReq = {
  id: 'req-1',
  baseUrl: '/dropbox',
  params: { providerName: 'dropbox', id: FILE_ID },
  query: { access_token: ACCESS_TOKEN },
  headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
  body: {
    accessToken: ACCESS_TOKEN,
    metadata: { name: FILE_NAME },
    endpoint: 'https://mux.example/upload',
  },
  companion: { providerUserSession: { accessToken: ACCESS_TOKEN } },
} as unknown as Request

function makeUploader(
  extra: Partial<ConstructorParameters<typeof Uploader>[0]> = {},
) {
  return new Uploader({
    companionOptions: { ...companionOptions, streamingUpload: true },
    endpoint: 'http://url.myendpoint.com/files',
    protocol: 'multipart',
    size: 10,
    pathPrefix: './test/output',
    metadata: { name: FILE_NAME },
    ...extra,
  })
}

function spyConsole() {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((prefix, msg) => {
    lines.push(`${String(prefix)} ${String(msg)}`)
  })
  return { lines, spy }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remote upload abort logging', () => {
  test('socket-wait timeout logs token, file, timer and value; error is unchanged', async () => {
    const { lines } = spyConsole()
    const uploader = makeUploader()

    const err = await uploader
      .awaitReady(20, remoteFileLogContext(fakeReq))
      .then(
        () => null,
        (e: unknown) => e as Error,
      )

    // control flow unchanged: same AbortError with a TimeoutError cause
    expect(err?.name).toBe('AbortError')
    expect((err?.cause as Error | undefined)?.name).toBe('TimeoutError')

    const line = lines.find((l) => l.includes('uploader.abort'))
    expect(line).toBeDefined()
    expect(line).toContain('[error]')
    expect(line).toContain(uploader.shortToken)
    expect(line).toContain('timer=socket-wait')
    expect(line).toContain('timeoutMs=20')
    expect(line).toContain(`token=${uploader.shortToken}`)
    expect(line).toContain('provider=dropbox')
    expect(line).toContain(`fileId="${FILE_ID}"`)
    expect(line).toContain(`fileName="${FILE_NAME}"`)
    expect(line).toContain('error=AbortError(cause=TimeoutError)')
    expect(lines.join('\n')).not.toContain(ACCESS_TOKEN)
    // only the short token, never the full one
    expect(lines.join('\n')).not.toContain(uploader.token)
  })

  test('socket-wait success does not log an abort line', async () => {
    const { lines } = spyConsole()
    const uploader = makeUploader()
    const ready = uploader.awaitReady(5000, remoteFileLogContext(fakeReq))
    const { default: Emitter } = await import('../src/server/emitter/index.js')
    Emitter().emit(`connection:${uploader.token}`)
    await ready
    expect(lines.some((l) => l.includes('uploader.abort'))).toBe(false)
  })

  test('awaitReady without context still logs, with unknown provider', async () => {
    const { lines } = spyConsole()
    const uploader = makeUploader()
    await uploader.awaitReady(10).catch(() => {})
    const line = lines.find((l) => l.includes('uploader.abort'))
    expect(line).toContain('provider=unknown')
    expect(line).toContain('fileId=null')
  })

  test('download/upload TimeoutError logs the phase and still emits the error', async () => {
    const { lines } = spyConsole()
    const uploader = makeUploader()
    const timeoutErr = Object.assign(new Error('Timeout awaiting request'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    })
    const stream = new Readable({
      read() {
        this.destroy(timeoutErr)
      },
    })

    await uploader.tryUploadStream(stream, fakeReq)

    const line = lines.find((l) => l.includes('uploader.abort'))
    expect(line).toBeDefined()
    expect(line).toContain('timer=download-or-upload')
    expect(line).toContain('timeoutMs=none-configured')
    expect(line).toContain('provider=dropbox')
    expect(line).toContain(`fileId="${FILE_ID}"`)
    expect(line).toContain(`fileName="${FILE_NAME}"`)
    expect(lines.join('\n')).not.toContain(ACCESS_TOKEN)
    // the pre-existing error line is still written
    expect(lines.some((l) => l.includes('uploader.error'))).toBe(true)
  })

  test('non-timeout failures do not log an abort line', async () => {
    const { lines } = spyConsole()
    const uploader = makeUploader()
    const stream = new Readable({
      read() {
        this.destroy(new Error('boom'))
      },
    })
    await uploader.tryUploadStream(stream, fakeReq)
    expect(lines.some((l) => l.includes('uploader.abort'))).toBe(false)
    expect(lines.some((l) => l.includes('uploader.error'))).toBe(true)
  })

  test('remoteFileLogContext falls back to the mount path and tolerates a bare request', () => {
    expect(
      remoteFileLogContext({
        baseUrl: '/url',
        params: {},
        body: { url: `https://x/?t=${ACCESS_TOKEN}`, metadata: { name: 'a' } },
      } as unknown as Request),
    ).toEqual({ provider: 'url', fileId: undefined, fileName: 'a' })
    expect(remoteFileLogContext({} as Request).provider).toBe('unknown')
  })
})
