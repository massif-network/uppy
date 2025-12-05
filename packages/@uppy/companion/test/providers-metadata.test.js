const nock = require('nock')

const {
  getOauthProvider,
} = require('../src/server/controllers/connect.js')
const {
  getDriveClient,
} = require('../src/server/controllers/get.js')

const { providerManager } = require('../src/server/provider')
const Provider = require('../src/server/provider/Provider')
const { Drive } = require('../src/server/provider/google/drive')

const {
  getCompanionOptions,
  runTest,
} = require('./test-helpers')

const THUMBNAIL_URL = 'https://drive.google.com/thumbnail?id=file123&sz=w256'
const ITEM_ID = 'file123'

// Mock the Provider base class
class MockProvider extends Provider {}

afterAll(() => {
  nock.cleanAll()
  nock.restore()
})

describe('Provider getFileMetadata', () => {
  let companionOptions

  beforeEach(() => {
    companionOptions = getCompanionOptions()
  })

  describe('Google Drive getFileMetadata', () => {
    beforeEach(() => {
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${ITEM_ID}`)
        .query((query) => {
          return query.fields && query.supportsAllDrives === 'true'
        })
        .reply(200, {
          kind: 'drive#file',
          id: ITEM_ID,
          name: 'test-photo.jpg',
          mimeType: 'image/jpeg',
          size: '1024000',
          modifiedTime: '2024-01-01T12:00:00.000Z',
          iconLink: 'https://drive-thirdparty.googleusercontent.com/16/type/image/jpeg',
          thumbnailLink: THUMBNAIL_URL,
          imageMediaMetadata: {
            width: 3840,
            height: 2160,
            rotation: 0,
            location: {
              latitude: 37.7749,
              longitude: -122.4194,
              altitude: 10.0,
            },
            time: '2023-12-25T10:30:00.000Z',
            cameraMake: 'Canon',
            cameraModel: 'EOS R5',
            exposureTime: 0.005,
            aperture: 2.8,
            flashUsed: false,
            focalLength: 50.0,
            isoSpeed: 400,
            meteringMode: 'Pattern',
            sensor: 'Full frame',
            exposureMode: 'Auto',
            colorSpace: 'sRGB',
            whiteBalance: 'Auto',
            exposureBias: 0.0,
            maxApertureValue: 2.8,
            subjectDistance: 5,
            lens: 'Canon RF 50mm F1.2L USM',
          },
        })
    })

    it('should fetch file metadata with image EXIF data', async () => {
      const provider = new Drive({ providerGrantConfig: {} })
      const providerUserSession = { accessToken: 'test-token' }

      const metadata = await provider.getFileMetadata({
        fileId: ITEM_ID,
        providerUserSession,
      })

      expect(metadata).toMatchObject({
        id: ITEM_ID,
        name: 'test-photo.jpg',
        mimeType: 'image/jpeg',
        size: '1024000',
        thumbnailLink: THUMBNAIL_URL,
        imageMediaMetadata: expect.objectContaining({
          width: 3840,
          height: 2160,
          location: expect.objectContaining({
            latitude: 37.7749,
            longitude: -122.4194,
          }),
          time: '2023-12-25T10:30:00.000Z',
          cameraMake: 'Canon',
          cameraModel: 'EOS R5',
        }),
      })
    })

    it('should handle video metadata', async () => {
      nock.cleanAll()

      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${ITEM_ID}`)
        .query((query) => {
          return query.fields && query.supportsAllDrives === 'true'
        })
        .reply(200, {
          kind: 'drive#file',
          id: ITEM_ID,
          name: 'test-video.mp4',
          mimeType: 'video/mp4',
          size: '50000000',
          modifiedTime: '2024-01-01T12:00:00.000Z',
          videoMediaMetadata: {
            width: 1920,
            height: 1080,
            durationMillis: '120000', // 2 minutes
          },
        })

      const provider = new Drive({ providerGrantConfig: {} })
      const providerUserSession = { accessToken: 'test-token' }

      const metadata = await provider.getFileMetadata({
        fileId: ITEM_ID,
        providerUserSession,
      })

      expect(metadata).toMatchObject({
        id: ITEM_ID,
        name: 'test-video.mp4',
        mimeType: 'video/mp4',
        videoMediaMetadata: expect.objectContaining({
          width: 1920,
          height: 1080,
          durationMillis: '120000',
        }),
      })
    })

    it('should handle shortcuts by fetching target file metadata', async () => {
      const targetId = 'target-file-123'

      nock.cleanAll()

      // Mock the shortcut file
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${ITEM_ID}`)
        .query((query) => {
          return query.fields && query.supportsAllDrives === 'true'
        })
        .reply(200, {
          kind: 'drive#file',
          id: ITEM_ID,
          name: 'shortcut-to-photo',
          mimeType: 'application/vnd.google-apps.shortcut',
          shortcutDetails: {
            targetId: targetId,
            targetMimeType: 'image/jpeg',
          },
        })

      // Mock the target file
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${targetId}`)
        .query((query) => {
          return query.fields && query.supportsAllDrives === 'true'
        })
        .reply(200, {
          kind: 'drive#file',
          id: targetId,
          name: 'actual-photo.jpg',
          mimeType: 'image/jpeg',
          size: '2048000',
          imageMediaMetadata: {
            width: 4000,
            height: 3000,
          },
        })

      const provider = new Drive({ providerGrantConfig: {} })
      const providerUserSession = { accessToken: 'test-token' }

      const metadata = await provider.getFileMetadata({
        fileId: ITEM_ID,
        providerUserSession,
      })

      // Should return the target file's metadata, not the shortcut's
      expect(metadata).toMatchObject({
        id: targetId,
        name: 'actual-photo.jpg',
        mimeType: 'image/jpeg',
        size: '2048000',
        imageMediaMetadata: expect.objectContaining({
          width: 4000,
          height: 3000,
        }),
      })
    })

    it('should handle API errors gracefully', async () => {
      nock.cleanAll()

      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${ITEM_ID}`)
        .query(true)
        .reply(404, {
          error: {
            code: 404,
            message: 'File not found',
          },
        })

      const provider = new Drive({ providerGrantConfig: {} })
      const providerUserSession = { accessToken: 'test-token' }

      await expect(
        provider.getFileMetadata({
          fileId: ITEM_ID,
          providerUserSession,
        })
      ).rejects.toThrow()
    })
  })
})