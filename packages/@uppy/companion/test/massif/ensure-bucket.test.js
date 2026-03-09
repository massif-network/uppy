import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureBucket, clearBucketCache } from '../../src/massif/ensure-bucket.js'

vi.mock('@aws-sdk/client-s3', () => ({
  HeadBucketCommand: class HeadBucketCommand {
    constructor(input) { this.input = input }
  },
  CreateBucketCommand: class CreateBucketCommand {
    constructor(input) { this.input = input }
  },
}))

vi.mock('../../src/server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function createMockClient({ headBucketError } = {}) {
  return {
    send: vi.fn(async (command) => {
      if (command.constructor.name === 'HeadBucketCommand') {
        if (headBucketError) throw headBucketError
        return {}
      }
      if (command.constructor.name === 'CreateBucketCommand') {
        return {}
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    }),
  }
}

describe('ensureBucket', () => {
  afterEach(() => {
    clearBucketCache()
  })

  it('does nothing when bucket already exists', async () => {
    const client = createMockClient()
    await ensureBucket(client, 'existing-bucket')

    expect(client.send).toHaveBeenCalledTimes(1)
    const cmd = client.send.mock.calls[0][0]
    expect(cmd.constructor.name).toBe('HeadBucketCommand')
    expect(cmd.input.Bucket).toBe('existing-bucket')
  })

  it('creates bucket when HeadBucket returns 404', async () => {
    const notFound = new Error('Not Found')
    notFound.name = 'NotFound'
    const client = createMockClient({ headBucketError: notFound })

    await ensureBucket(client, 'new-bucket')

    expect(client.send).toHaveBeenCalledTimes(2)
    expect(client.send.mock.calls[0][0].constructor.name).toBe('HeadBucketCommand')
    expect(client.send.mock.calls[1][0].constructor.name).toBe('CreateBucketCommand')
    expect(client.send.mock.calls[1][0].input.Bucket).toBe('new-bucket')
  })

  it('creates bucket when HeadBucket returns httpStatusCode 404', async () => {
    const notFound = new Error('Not Found')
    notFound.$metadata = { httpStatusCode: 404 }
    const client = createMockClient({ headBucketError: notFound })

    await ensureBucket(client, 'new-bucket')

    expect(client.send).toHaveBeenCalledTimes(2)
  })

  it('caches known buckets — second call skips HeadBucket', async () => {
    const client = createMockClient()

    await ensureBucket(client, 'cached-bucket')
    await ensureBucket(client, 'cached-bucket')

    // Only 1 HeadBucket call, not 2
    expect(client.send).toHaveBeenCalledTimes(1)
  })

  it('caches after creation too', async () => {
    const notFound = new Error('Not Found')
    notFound.name = 'NotFound'
    const client = createMockClient({ headBucketError: notFound })

    await ensureBucket(client, 'created-and-cached')
    // Reset the mock to track only new calls
    client.send.mockClear()
    // Make head succeed now (bucket exists after creation)
    client.send.mockResolvedValue({})

    await ensureBucket(client, 'created-and-cached')

    // No calls at all — served from cache
    expect(client.send).toHaveBeenCalledTimes(0)
  })

  it('re-throws non-404 errors', async () => {
    const forbidden = new Error('Forbidden')
    forbidden.name = 'AccessDenied'
    forbidden.$metadata = { httpStatusCode: 403 }
    const client = createMockClient({ headBucketError: forbidden })

    await expect(ensureBucket(client, 'forbidden-bucket')).rejects.toThrow('Forbidden')
    // Should NOT attempt CreateBucket
    expect(client.send).toHaveBeenCalledTimes(1)
  })

  it('clearBucketCache resets the cache', async () => {
    const client = createMockClient()

    await ensureBucket(client, 'temp-bucket')
    expect(client.send).toHaveBeenCalledTimes(1)

    clearBucketCache()
    await ensureBucket(client, 'temp-bucket')
    // HeadBucket called again after cache clear
    expect(client.send).toHaveBeenCalledTimes(2)
  })
})
