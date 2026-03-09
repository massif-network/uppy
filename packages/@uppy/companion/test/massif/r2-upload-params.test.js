import { describe, expect, it, vi } from 'vitest'
import { getPresignedPutParams } from '../../src/massif/r2-upload-params.js'

// Mock getSignedUrl — we don't need real AWS creds for unit tests
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, command, _opts) => {
    const { Bucket, Key } = command.input
    return `https://${Bucket}.s3.us-east-1.amazonaws.com/${Key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fake`
  }),
}))

// Mock PutObjectCommand to capture its input
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class PutObjectCommand {
    constructor(input) {
      this.input = input
    }
  },
  HeadBucketCommand: class HeadBucketCommand {
    constructor(input) { this.input = input }
  },
}))

// Client mock needs send() for ensureBucket's HeadBucketCommand
const fakeClient = /** @type {any} */ ({ send: vi.fn(async () => ({})) })

describe('getPresignedPutParams', () => {
  it('returns method PUT with a signed URL', async () => {
    const result = await getPresignedPutParams(fakeClient, {
      bucket: 'test-bucket',
      key: 'uploads/photo.png',
      type: 'image/png',
      expires: 800,
    })

    expect(result.method).toBe('PUT')
    expect(result.url).toContain('test-bucket')
    expect(result.url).toContain('X-Amz-Algorithm')
    expect(result.fields.key).toBe('uploads/photo.png')
    expect(result.expires).toBe(800)
    expect(result.headers['Content-Type']).toBe('image/png')
  })

  it('includes ACL when provided', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    await getPresignedPutParams(fakeClient, {
      bucket: 'test-bucket',
      key: 'file.txt',
      type: 'text/plain',
      acl: 'public-read',
      expires: 300,
    })

    const command = getSignedUrl.mock.calls.at(-1)[1]
    expect(command.input.ACL).toBe('public-read')
  })

  it('omits ACL when null', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    await getPresignedPutParams(fakeClient, {
      bucket: 'test-bucket',
      key: 'file.txt',
      type: 'text/plain',
      acl: null,
      expires: 300,
    })

    const command = getSignedUrl.mock.calls.at(-1)[1]
    expect(command.input.ACL).toBeUndefined()
  })

  it('encodes metadata using rfc2047', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    await getPresignedPutParams(fakeClient, {
      bucket: 'test-bucket',
      key: 'file.txt',
      type: 'text/plain',
      metadata: { author: 'Test User', source: 'uppy' },
      expires: 300,
    })

    const command = getSignedUrl.mock.calls.at(-1)[1]
    expect(command.input.Metadata).toBeDefined()
    expect(command.input.Metadata.author).toBeDefined()
    expect(command.input.Metadata.source).toBeDefined()
  })

  it('skips metadata when empty', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    await getPresignedPutParams(fakeClient, {
      bucket: 'test-bucket',
      key: 'file.txt',
      type: 'text/plain',
      metadata: {},
      expires: 300,
    })

    const command = getSignedUrl.mock.calls.at(-1)[1]
    expect(command.input.Metadata).toBeUndefined()
  })

  it('uses the correct Content-Type in the command', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    await getPresignedPutParams(fakeClient, {
      bucket: 'test-bucket',
      key: 'doc.pdf',
      type: 'application/pdf',
      expires: 600,
    })

    const command = getSignedUrl.mock.calls.at(-1)[1]
    expect(command.input.ContentType).toBe('application/pdf')
    expect(command.input.Bucket).toBe('test-bucket')
    expect(command.input.Key).toBe('doc.pdf')
  })
})
