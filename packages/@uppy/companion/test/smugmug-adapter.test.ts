import querystring from 'node:querystring'
import { describe, expect, test } from 'vitest'
import {
  adaptAlbumImages,
  adaptNodeChildren,
  type SmugMugAlbumImagesResponse,
  type SmugMugNodeChildrenResponse,
} from '../src/server/provider/smugmug/adapter.js'
import { getCanonicalSourceVersion } from '../src/server/provider/smugmug/source-version.js'

// Regression coverage for album/folder pagination: the client pages by feeding
// `nextPagePath` straight back in as the next `directory`, so the directory MUST
// be preserved as the path prefix. Without it, page 2+ falls through to the root
// branch and album images past the first 100 are silently dropped.
describe('SmugMug adapter pagination', () => {
  test('adaptAlbumImages keeps the album directory in nextPagePath', () => {
    const nextPage = '/api/v2/album/abc!images?start=101&count=100'
    const res: SmugMugAlbumImagesResponse = {
      Response: {
        AlbumImage: [
          { ImageKey: 'k1', FileName: 'a.jpg' },
          // videos are filtered out (images-only for now)
          { ImageKey: 'k2', FileName: 'b.mov', IsVideo: true },
        ],
        Pages: { NextPage: nextPage },
      },
    }

    const { items, nextPagePath } = adaptAlbumImages(
      res,
      undefined,
      'album:abc',
    )

    expect(items.map((i) => i.id)).toEqual(['image:k1'])
    // Must re-route to the `album:` branch on the next page, not the root branch.
    const [path, qs] = (nextPagePath as string).split('?')
    expect(path).toBe('album:abc')
    expect(querystring.parse(qs ?? '')['cursor']).toBe(nextPage)
  })

  test('adaptNodeChildren keeps the node directory in nextPagePath', () => {
    const nextPage = '/api/v2/node/n1!children?start=101'
    const res: SmugMugNodeChildrenResponse = {
      Response: {
        Node: [
          {
            Type: 'Album',
            Name: 'My album',
            NodeID: 'n2',
            Uris: { Album: { Uri: '/api/v2/album/xyz' } },
          },
        ],
        Pages: { NextPage: nextPage },
      },
    }

    const { nextPagePath } = adaptNodeChildren(res, undefined, 'node:n1')

    const [path, qs] = (nextPagePath as string).split('?')
    expect(path).toBe('node:n1')
    expect(querystring.parse(qs ?? '')['cursor']).toBe(nextPage)
  })

  test('root listing (no directory) paginates back into the root branch', () => {
    const res: SmugMugNodeChildrenResponse = {
      Response: {
        Node: [],
        Pages: { NextPage: '/api/v2/node/root!children?start=101' },
      },
    }

    const { nextPagePath } = adaptNodeChildren(res, 'user', undefined)

    // No directory prefix: the next request re-enters the root branch, which also
    // adapts node children, so root pagination stays correct.
    expect(nextPagePath?.startsWith('?')).toBe(true)
  })

  test('a final page (no NextPage) yields a null nextPagePath', () => {
    expect(
      adaptAlbumImages({ Response: { AlbumImage: [] } }, undefined, 'album:abc')
        .nextPagePath,
    ).toBeNull()
    expect(
      adaptNodeChildren({ Response: { Node: [] } }, undefined, undefined)
        .nextPagePath,
    ).toBeNull()
  })
})

describe('SmugMug adapter source identity', () => {
  test('uses LastUpdated rather than DateTimeUploaded for image modification', () => {
    const { items } = adaptAlbumImages(
      {
        Response: {
          AlbumImage: [
            {
              ImageKey: 'k1',
              DateTimeUploaded: '2020-01-01T00:00:00Z',
              LastUpdated: '2026-08-05T00:00:00Z',
            },
          ],
        },
      } as SmugMugAlbumImagesResponse,
      undefined,
      'album:abc',
    )

    expect(items[0]?.modifiedDate).toBe('2026-08-05T00:00:00Z')
  })
})

describe('SmugMug adapter canonical list metadata', () => {
  test('carries an internally consistent source identity tuple', () => {
    const { items } = adaptAlbumImages(
      {
        Response: {
          AlbumImage: [
            {
              Uri: '/api/v2/image/k1',
              ImageKey: 'k1',
              Serial: 7,
              ArchivedSize: 1234,
              ArchivedMD5: 'md5-k1',
              LastUpdated: '2026-08-05T00:00:00Z',
              FileName: 'a.jpg',
            },
          ],
        },
      },
      undefined,
      'album:abc',
    )

    expect(items[0]).toMatchObject({
      imageKey: 'k1',
      serial: 7,
      canonicalUri: '/api/v2/image/k1',
      archivedSize: 1234,
      archivedMd5: 'md5-k1',
      lastUpdated: '2026-08-05T00:00:00Z',
      sourceVersion: '/api/v2/image/k1|7|2026-08-05T00:00:00Z|1234|md5-k1',
    })
  })
})

describe('SmugMug canonical source-version helper', () => {
  test('matches the list identity tuple used by source preparation', () => {
    expect(
      getCanonicalSourceVersion({
        canonicalUri: '/api/v2/image/k1',
        serial: 7,
        lastUpdated: '2026-08-05T00:00:00Z',
        size: 1234,
        archivedMd5: 'md5-k1',
      }),
    ).toBe('/api/v2/image/k1|7|2026-08-05T00:00:00Z|1234|md5-k1')
  })
})
