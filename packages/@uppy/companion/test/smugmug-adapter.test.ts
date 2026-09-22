import querystring from 'node:querystring'
import { describe, expect, test } from 'vitest'
import {
  adaptAlbumImages,
  adaptNodeChildren,
  extractAlbumDescription,
  normalizeCaption,
  type SmugMugAlbumImage,
  type SmugMugAlbumImagesResponse,
  type SmugMugNodeChildrenResponse,
} from '../src/server/provider/smugmug/adapter.js'
import {
  albumListParams,
  nodeListParams,
} from '../src/server/provider/smugmug/index.js'

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

// Captions feed `mediaFiles.caption`, whose only consumer is the search index —
// escaped plain text. Anything that doesn't survive normalisation must come out
// as `undefined`, not `''`, so the column ends up null.
describe('SmugMug caption normalisation', () => {
  test('keeps a plain-text caption verbatim', () => {
    expect(normalizeCaption('Amazing scenery all day.', 'IMG_8128.jpg')).toBe(
      'Amazing scenery all day.',
    )
  })

  test('strips markup and decodes entities', () => {
    expect(
      normalizeCaption(
        '<strong style="font-size:14px;">Big monitor?&nbsp;&nbsp;Widen your browser.</strong>',
        'a.jpg',
      ),
    ).toBe('Big monitor? Widen your browser.')
    expect(
      normalizeCaption(
        'See <a href="https://example.com/x?a=1&amp;b=2">the blog</a>.',
        'a.jpg',
      ),
    ).toBe('See the blog.')
  })

  test('turns tags into a separator rather than concatenating words', () => {
    expect(normalizeCaption('first<br>second', 'a.jpg')).toBe('first second')
  })

  test('reattaches punctuation stranded by an inline tag', () => {
    expect(normalizeCaption('Shot in <em>Vík</em>, at dawn.', 'a.jpg')).toBe(
      'Shot in Vík, at dawn.',
    )
    expect(normalizeCaption('A day out (<b>Vík</b>) in June', 'a.jpg')).toBe(
      'A day out (Vík) in June',
    )
  })

  test('decodes numeric entities and leaves malformed ones alone', () => {
    expect(normalizeCaption('caf&#233; &#x41;', 'a.jpg')).toBe('café A')
    expect(normalizeCaption('&#0; &#xZZ; &bogus;', 'a.jpg')).toBe(
      '&#0; &#xZZ; &bogus;',
    )
  })

  test('drops empty, whitespace-only and markup-only captions', () => {
    expect(normalizeCaption(undefined, 'a.jpg')).toBeUndefined()
    expect(normalizeCaption('', 'a.jpg')).toBeUndefined()
    expect(normalizeCaption('   \n\t ', 'a.jpg')).toBeUndefined()
    expect(normalizeCaption('<p>&nbsp;</p>', 'a.jpg')).toBeUndefined()
  })

  test('drops captions that merely echo the filename', () => {
    // SmugMug auto-fills these on some upload paths.
    expect(normalizeCaption('batman', 'batman.jpg')).toBeUndefined()
    expect(normalizeCaption('IMG_8176', 'IMG_8176.jpg')).toBeUndefined()
    expect(normalizeCaption('img_8176', 'IMG_8176.jpg')).toBeUndefined()
    expect(normalizeCaption('batman.jpg', 'batman.jpg')).toBeUndefined()
    expect(
      normalizeCaption('11393-059-007f', '11393-059-007f.jpg'),
    ).toBeUndefined()
    // A caption that merely starts with the filename is still a real caption.
    expect(normalizeCaption('batman on set', 'batman.jpg')).toBe(
      'batman on set',
    )
  })

  test('survives an image with no filename', () => {
    expect(normalizeCaption('A real caption', undefined)).toBe('A real caption')
  })
})

describe('adaptAlbumImages caption mapping', () => {
  const adapt = (images: SmugMugAlbumImage[]) =>
    adaptAlbumImages(
      { Response: { AlbumImage: images } },
      undefined,
      'album:abc',
    ).items

  test('maps Caption onto the item and omits it when absent', () => {
    const [withCaption, withoutCaption] = adapt([
      { ImageKey: 'k1', FileName: 'a.jpg', Caption: 'Tyler at the start.' },
      { ImageKey: 'k2', FileName: 'b.jpg', Caption: '' },
    ])

    expect(withCaption?.caption).toBe('Tyler at the start.')
    expect(withoutCaption?.caption).toBeUndefined()
  })

  test('never maps Title', () => {
    const [item] = adapt([
      { ImageKey: 'k1', FileName: 'a.jpg', Title: 'Some title' },
    ])

    expect(item?.caption).toBeUndefined()
    // Title still participates in the display name fallback, unchanged.
    expect(item?.name).toBe('a.jpg')
  })
})

// A gallery is a folder item, and folders never become Uppy files — so the
// album's description is denormalised onto every image and the app recovers it
// per folder group. Shape verified against the live API: `_expand=Album` puts
// the album under `Expansions`, keyed by its URI.
describe('album description', () => {
  const expanded = (
    description: string | undefined,
  ): SmugMugAlbumImagesResponse => ({
    Response: { AlbumImage: [{ ImageKey: 'k1', FileName: 'a.jpg' }] },
    Expansions: {
      '/api/v2/album/C2Jd35': { Album: { Description: description } },
    },
  })

  test('extracts the description from the expansion', () => {
    expect(
      extractAlbumDescription(
        expanded('More time in the med tent than swimming.'),
      ),
    ).toBe('More time in the med tent than swimming.')
  })

  test('strips markup, matching the caption contract', () => {
    expect(
      extractAlbumDescription(
        expanded(
          '<strong style="font-size:14px;">Big monitor?&nbsp;Widen your browser.</strong>',
        ),
      ),
    ).toBe('Big monitor? Widen your browser.')
    // Link text survives; the href does not — an accepted trade for a column
    // rendered through a markdown parser and edited as plain text.
    expect(
      extractAlbumDescription(
        expanded('Details in <a href="https://example.com/x">the blog</a>.'),
      ),
    ).toBe('Details in the blog.')
  })

  test('returns undefined when there is no description to take', () => {
    expect(extractAlbumDescription(expanded(undefined))).toBeUndefined()
    expect(extractAlbumDescription(expanded(''))).toBeUndefined()
    expect(extractAlbumDescription(expanded('  '))).toBeUndefined()
    expect(extractAlbumDescription(expanded('<p>&nbsp;</p>'))).toBeUndefined()
    // No `_expand` on the request (e.g. an un-patched cursor page).
    expect(
      extractAlbumDescription({ Response: { AlbumImage: [] } }),
    ).toBeUndefined()
    expect(extractAlbumDescription({ Expansions: {} })).toBeUndefined()
  })

  test('stamps the description on every image in the album', () => {
    const { items } = adaptAlbumImages(
      {
        Response: {
          AlbumImage: [
            { ImageKey: 'k1', FileName: 'a.jpg' },
            { ImageKey: 'k2', FileName: 'b.jpg', Caption: 'Its own caption.' },
            // Videos are still filtered out.
            { ImageKey: 'k3', FileName: 'c.mov', IsVideo: true },
          ],
        },
        Expansions: {
          '/api/v2/album/C2Jd35': { Album: { Description: 'Shot at dawn.' } },
        },
      },
      undefined,
      'album:C2Jd35',
    )

    expect(items).toHaveLength(2)
    expect(items.map((i) => i.albumDescription)).toEqual([
      'Shot at dawn.',
      'Shot at dawn.',
    ])
    // The album description and the per-image caption are independent.
    expect(items[1]?.caption).toBe('Its own caption.')
  })

  test('leaves albumDescription undefined when the album has none', () => {
    const { items } = adaptAlbumImages(
      { Response: { AlbumImage: [{ ImageKey: 'k1', FileName: 'a.jpg' }] } },
      undefined,
      'album:C2Jd35',
    )

    expect(items[0]?.albumDescription).toBeUndefined()
  })
})

// Regression coverage for the list-request pagination parameters.
//
// The original bug was a wrong parameter NAME, not a wrong value: the provider
// sent `_count`, which SmugMug does not recognise. It does not error — it
// silently ignores the parameter and applies the endpoint default (10 for
// node!children), so every large import degraded into thousands of sequential
// round trips with nothing in the logs to show for it.
//
// Values verified against the live SmugMug API:
//   node!children  no param -> 10   count=500 -> RequestedCount clamps to 200
//   album!images   no param -> 100  count=1000 -> returned all 669 of an album
describe('SmugMug list pagination params', () => {
  test('paginates with `count`, never the underscore-prefixed form', () => {
    for (const params of [nodeListParams(), albumListParams()]) {
      const keys = Object.keys(params)
      expect(keys).toContain('count')
      expect(keys).not.toContain('_count')
    }
  })

  test("node listing stays within SmugMug's 200 clamp", () => {
    expect(nodeListParams().count).toBeGreaterThan(10) // the ignored-param default
    expect(nodeListParams().count).toBeLessThanOrEqual(200)
  })

  test('album listing beats the 100 default and needs no clamp', () => {
    // album!images imposes no observed ceiling, so this only has to beat the
    // default we were accidentally relying on.
    expect(albumListParams().count).toBeGreaterThan(100)
  })

  test('album listing still requests the Album expansion', () => {
    // `_expand` rides along on the same request so the album description costs
    // no extra round trip; losing it would silently drop descriptions.
    expect(albumListParams()._expand).toBe('Album')
  })
})
