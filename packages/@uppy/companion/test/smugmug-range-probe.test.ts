import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import express from 'express'
import nock from 'nock'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const upload = vi.hoisted(() => ({ startDownUpload: vi.fn() }))

vi.mock('express-prom-bundle')

vi.mock('../src/server/helpers/upload.js', () => upload)

import { isSmugMugRangeProbeEnabled } from '../src/server/controllers/smugmug-range-probe.js'
import { getServer, setDefaultEnv } from './mockserver.js'
const API_HOST = 'https://api.smugmug.com'
const ORIGINAL_HOST = 'https://photos.smugmug.com'
const UNTRUSTED_HOST = 'https://untrusted.example.test'
const imageId = 'image:probe-image-7'
const imagePath = '/api/v2/image/probe-image-7'
const detailsPath = '/api/v2/image/probe-image-7!sizedetails'

function mockImageMetadata(
  { size = 10, originalHost = ORIGINAL_HOST }: {
    size?: number
    originalHost?: string
  } = {},
): void {
  nock(API_HOST)
    .get(imagePath)
    .query((query) => typeof query['APIKey'] === 'string')
    .reply(200, {
      Response: {
        Image: {
          Uri: imagePath,
          ImageKey: 'probe-image',
          Serial: 7,
          ArchivedSize: size,
          ArchivedMD5: 'probe-md5',
          LastUpdated: '2026-08-05T00:00:00Z',
          Uris: { ImageSizeDetails: { Uri: detailsPath } },
        },
      },
    })
    .get(detailsPath)
    .query((query) => typeof query['APIKey'] === 'string')
    .reply(200, {
      Response: {
        ImageSizeDetails: {
          ImageSizeOriginal: {
            Url: `${originalHost}/original`,
            Size: size,
            MimeType: 'image/jpeg',
          },
        },
      },
    })
}

function mockOriginalHead(size = 10): void {
  nock(ORIGINAL_HOST).head('/original').reply(200, '', {
    'content-length': String(size),
    'content-type': 'image/jpeg',
  })
}

function getProbeServer(extraEnv: Record<string, string | undefined> = {}) {
  return getServer({
    COMPANION_SMUGMUG_API_KEY: randomUUID(),
    COMPANION_SMUGMUG_RANGE_PROBE: 'true',
    COMPANION_SMUGMUG_RANGE_PROBE_MAX_BYTES: undefined,
    ...extraEnv,
  })
}

function probeRequest(server: Awaited<ReturnType<typeof getServer>>) {
  return request(server).get(`/smugmug/_range-probe/${imageId}`)
}

beforeEach(() => {
  vi.resetModules()
  setDefaultEnv()
  delete process.env['COMPANION_SMUGMUG_RANGE_PROBE_DEADLINE_MS']
})

afterEach(() => {
  nock.cleanAll()
  vi.restoreAllMocks()
  delete process.env['COMPANION_SMUGMUG_RANGE_PROBE_DEADLINE_MS']
})

describe('temporary public SmugMug range probe', () => {
  test('is absent unless explicitly enabled and fails closed in production', async () => {
    const disabled = await getProbeServer({
      COMPANION_SMUGMUG_RANGE_PROBE: undefined,
    })
    await probeRequest(disabled).expect(404)

    const previousNodeEnv = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    expect(isSmugMugRangeProbeEnabled()).toBe(false)
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = previousNodeEnv
  })

  test('does not require Uppy OAuth credentials and rejects other providers', async () => {
    mockImageMetadata()
    nock(ORIGINAL_HOST).head('/original').reply(200, '', {
      'content-length': '10',
      'content-type': 'image/jpeg',
    })
    const server = await getProbeServer()

    const response = await request(server).get(
      `/smugmug/_range-probe/${imageId}/metadata`,
    )
    expect(nock.pendingMocks()).toEqual([])
    expect(response.status).toBe(200)
    await request(server).get(`/drive/_range-probe/${imageId}`).expect(404)
  })

  test('returns normalized public-original metadata without returning its URL', async () => {
    mockImageMetadata()
    nock(ORIGINAL_HOST)
      .head('/original')
      .reply(200, '', {
        'content-length': '10',
        'content-type': 'image/jpeg',
        etag: 'probe-etag',
        'last-modified': 'Tue, 05 Aug 2026 00:00:00 GMT',
        'accept-ranges': 'bytes',
      })

    const server = await getProbeServer()
    const response = await request(server)
      .get(`/smugmug/_range-probe/${imageId}/metadata`)
      .expect(200)

    expect(response.body).toEqual({
      canonicalUri: imagePath,
      imageKey: 'probe-image',
      serial: 7,
      archivedSize: 10,
      archivedMd5: 'probe-md5',
      lastUpdated: '2026-08-05T00:00:00Z',
      size: 10,
      mimeType: 'image/jpeg',
      etag: 'probe-etag',
      lastModified: 'Tue, 05 Aug 2026 00:00:00 GMT',
      acceptRanges: 'bytes',
    })
    expect(response.text).not.toContain(ORIGINAL_HOST)
  })

  test('streams one exact public range without invoking destination upload code', async () => {
    mockImageMetadata()
    mockOriginalHead()
    nock(ORIGINAL_HOST)
      .get('/original')
      .matchHeader('range', 'bytes=2-5')
      .reply(206, '2345', {
        'content-range': 'bytes 2-5/10',
        'content-length': '4',
        'content-type': 'image/jpeg',
      })

    const server = await getProbeServer()
    const response = await probeRequest(server)
      .set('Range', 'bytes=2-5')
      .expect(206)

    expect(response.headers['content-range']).toBe('bytes 2-5/10')
    expect(response.headers['content-length']).toBe('4')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.equals(Buffer.from('2345'))).toBe(true)
    expect(upload.startDownUpload).not.toHaveBeenCalled()
  })

  test('rejects missing, malformed, oversized, and beyond-EOF ranges before returning bytes', async () => {
    const server = await getProbeServer({
      COMPANION_SMUGMUG_RANGE_PROBE_MAX_BYTES: '3',
    })

    await probeRequest(server).expect(400)
    await probeRequest(server).set('Range', 'bytes=2-').expect(400)
    await probeRequest(server).set('Range', 'bytes=-2').expect(400)
    await probeRequest(server).set('Range', 'bytes=2-3,5-6').expect(400)
    await probeRequest(server).set('Range', 'bytes=4-2').expect(400)
    await probeRequest(server).set('Range', 'bytes=0-3').expect(400)

    mockImageMetadata()
    mockOriginalHead()
    await probeRequest(server).set('Range', 'bytes=10-10').expect(416)
  })

  test('rejects an upstream response that silently returns a complete object', async () => {
    mockImageMetadata()
    mockOriginalHead()
    nock(ORIGINAL_HOST)
      .get('/original')
      .matchHeader('range', 'bytes=0-1')
      .reply(200, '0123456789', {
        'content-length': '10',
        'content-type': 'image/jpeg',
      })

    const server = await getProbeServer()
    const response = await probeRequest(server)
      .set('Range', 'bytes=0-1')
      .expect(502)

    expect(response.text).not.toContain(ORIGINAL_HOST)
  })

  test('rejects malformed image ids before constructing SmugMug API paths', async () => {
    const server = await getProbeServer()

    await request(server)
      .get('/smugmug/_range-probe/image:/metadata')
      .expect(400)
  })

  test('rejects a non-SMugMug original host without requesting it', async () => {
    mockImageMetadata({ originalHost: UNTRUSTED_HOST })
    nock(UNTRUSTED_HOST).head('/original').reply(200, '', {
      'content-length': '10',
      'content-type': 'image/jpeg',
    })

    const server = await getProbeServer()
    await probeRequest(server).set('Range', 'bytes=0-1').expect(502)
    expect(nock.pendingMocks()).toHaveLength(1)
  })

  test('rejects a HEAD redirect without following its target', async () => {
    mockImageMetadata()
    nock(ORIGINAL_HOST).head('/original').reply(302, '', {
      location: `${UNTRUSTED_HOST}/redirect-head`,
    })
    nock(UNTRUSTED_HOST).head('/redirect-head').reply(200, '', {
      'content-length': '10',
      'content-type': 'image/jpeg',
    })

    const server = await getProbeServer()
    await request(server)
      .get(`/smugmug/_range-probe/${imageId}/metadata`)
      .expect(502)
    expect(nock.pendingMocks()).toHaveLength(1)
  })

  test('rejects a range redirect without following its target', async () => {
    mockImageMetadata()
    mockOriginalHead()
    nock(ORIGINAL_HOST)
      .get('/original')
      .matchHeader('range', 'bytes=0-1')
      .reply(302, '', { location: `${UNTRUSTED_HOST}/redirect-get` })
    nock(UNTRUSTED_HOST).get('/redirect-get').reply(206, '01', {
      'content-range': 'bytes 0-1/10',
      'content-length': '2',
      'content-type': 'image/jpeg',
    })

    const server = await getProbeServer()
    await probeRequest(server).set('Range', 'bytes=0-1').expect(502)
    expect(nock.pendingMocks()).toHaveLength(1)
  })

  test('rejects a slow metadata setup at the probe deadline', async () => {
    process.env['COMPANION_SMUGMUG_RANGE_PROBE_DEADLINE_MS'] = '1'
    // Dynamic imports keep the controller's instanceof check aligned with the
    // controlled provider after vi.resetModules().
    const { default: smugMugRangeProbe } = await import(
      '../src/server/controllers/smugmug-range-probe.js'
    )
    const { default: SmugMug } = await import(
      '../src/server/provider/smugmug/index.js'
    )
    const provider = Object.create(SmugMug.prototype) as InstanceType<typeof SmugMug>
    vi.spyOn(SmugMug.prototype, 'getProbeSource').mockImplementation(
      () => new Promise<never>(() => { }),
    )
    const app = express()
    app.get('/:providerName/_range-probe/:id', (req, res, next) => {
      req.companion = { provider } as never
      void smugMugRangeProbe(req, res).catch(next)
    })

    await request(app)
      .get(`/smugmug/_range-probe/${imageId}`)
      .set('Range', 'bytes=0-1')
      .expect(504)
  })

  test('aborts pending metadata setup when the client disconnects', async () => {
    const { default: smugMugRangeProbe } = await import(
      '../src/server/controllers/smugmug-range-probe.js'
    )
    const { default: SmugMug } = await import(
      '../src/server/provider/smugmug/index.js'
    )
    const provider = Object.create(SmugMug.prototype) as InstanceType<typeof SmugMug>
    let setupSignal: AbortSignal | undefined
    let started!: () => void
    const setupStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.spyOn(SmugMug.prototype, 'getProbeSource').mockImplementation(
      ({ signal }: { signal?: AbortSignal }) => {
        setupSignal = signal
        started()
        return new Promise<never>(() => { })
      },
    )
    const app = express()
    app.get('/:providerName/_range-probe/:id', (req, res, next) => {
      req.companion = { provider } as never
      void smugMugRangeProbe(req, res).catch(next)
    })
    const listener = app.listen(0)
    await once(listener, 'listening')
    const address = listener.address()
    if (address == null || typeof address === 'string') {
      throw new Error('Probe test listener has no TCP address')
    }

    try {
      const client = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: `/smugmug/_range-probe/${imageId}`,
        headers: { Range: 'bytes=0-1' },
      })
      client.once('error', () => { })
      client.end()
      await setupStarted
      client.destroy()
      await vi.waitFor(() => {
        expect(setupSignal?.aborted).toBe(true)
      })
    } finally {
      listener.close()
      await once(listener, 'close')
    }
  })

  test('destroys the upstream stream exactly once when the client aborts', async () => {
    // Dynamic imports keep the controller's instanceof check on the same class
    // instance as this controlled provider after vi.resetModules().
    const { default: smugMugRangeProbe } = await import(
      '../src/server/controllers/smugmug-range-probe.js'
    )
    const { default: SmugMug } = await import(
      '../src/server/provider/smugmug/index.js'
    )
    const source = new PassThrough()
    const destroy = vi.spyOn(source, 'destroy')
    const provider = Object.create(SmugMug.prototype) as InstanceType<typeof SmugMug>
    vi.spyOn(SmugMug.prototype, 'getProbeSource').mockResolvedValue({
      metadata: { size: 10 },
    } as never)
    vi.spyOn(SmugMug.prototype, 'openProbeRange').mockResolvedValue({
      stream: source,
      contentRange: 'bytes 0-3/10',
      contentLength: 4,
      mimeType: 'image/jpeg',
    })
    const app = express()
    app.get('/:providerName/_range-probe/:id', (req, res, next) => {
      req.companion = { provider } as never
      void smugMugRangeProbe(req, res).catch(next)
    })

    const listener = app.listen(0)
    await once(listener, 'listening')
    const address = listener.address()
    if (address == null || typeof address === 'string') {
      throw new Error('Probe test listener has no TCP address')
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const client = httpRequest({
          host: '127.0.0.1',
          port: address.port,
          path: `/smugmug/_range-probe/${imageId}`,
          headers: { Range: 'bytes=0-3' },
        })
        client.once('response', (response) => {
          response.once('data', (chunk: Buffer) => {
            expect(chunk.equals(Buffer.from('01'))).toBe(true)
            client.destroy()
            resolve()
          })
        })
        client.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ECONNRESET') reject(error)
        })
        client.end()
        source.write('01')
      })

      await vi.waitFor(() => {
        expect(destroy).toHaveBeenCalledTimes(1)
      })
    } finally {
      listener.close()
      await once(listener, 'close')
    }
  })

  test('destroys the upstream stream exactly once after a mid-stream error', async () => {
    const { default: smugMugRangeProbe } = await import(
      '../src/server/controllers/smugmug-range-probe.js'
    )
    const { default: SmugMug } = await import(
      '../src/server/provider/smugmug/index.js'
    )
    const source = new PassThrough()
    const destroy = vi.spyOn(source, 'destroy')
    const provider = Object.create(SmugMug.prototype) as InstanceType<typeof SmugMug>
    vi.spyOn(SmugMug.prototype, 'getProbeSource').mockResolvedValue({
      metadata: { size: 10 },
    } as never)
    vi.spyOn(SmugMug.prototype, 'openProbeRange').mockResolvedValue({
      stream: source,
      contentRange: 'bytes 0-3/10',
      contentLength: 4,
      mimeType: 'image/jpeg',
    })
    const app = express()
    app.get('/:providerName/_range-probe/:id', (req, res, next) => {
      req.companion = { provider } as never
      void smugMugRangeProbe(req, res).catch(next)
    })
    const listener = app.listen(0)
    await once(listener, 'listening')
    const address = listener.address()
    if (address == null || typeof address === 'string') {
      throw new Error('Probe test listener has no TCP address')
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const client = httpRequest({
          host: '127.0.0.1',
          port: address.port,
          path: `/smugmug/_range-probe/${imageId}`,
          headers: { Range: 'bytes=0-3' },
        })
        client.once('response', (response) => {
          response.once('data', () => {
            source.emit('error', new Error('simulated upstream failure'))
            resolve()
          })
        })
        client.once('error', () => { })
        client.end()
        source.write('01')
      })
      await vi.waitFor(() => {
        expect(destroy).toHaveBeenCalledTimes(1)
      })
    } finally {
      listener.close()
      await once(listener, 'close')
    }
  })
})
