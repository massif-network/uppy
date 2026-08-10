import querystring from 'node:querystring'
import mime from 'mime-types'
import type { ProviderListResponse } from '../Provider.js'

// SmugMug API v2 response shapes (only the fields we consume).
// Docs: https://api.smugmug.com/api/v2/doc/index.html

type SmugMugRef = { Uri?: string }

export type SmugMugNode = {
  Name?: string
  NodeID?: string
  // 'Folder' | 'Album' | 'Page' (and a few rarer types we ignore)
  Type?: string
  DateModified?: string
  Uris?: { Album?: SmugMugRef }
}

export type SmugMugNodeChildrenResponse = {
  Response?: {
    Node?: SmugMugNode[]
    Pages?: { NextPage?: string }
  }
}

export type SmugMugAlbumImage = {
  Title?: string
  Caption?: string
  FileName?: string
  ImageKey?: string
  ArchivedSize?: number
  IsVideo?: boolean
  ThumbnailUrl?: string
  DateTimeUploaded?: string
}

export type SmugMugAlbumImagesResponse = {
  Response?: {
    AlbumImage?: SmugMugAlbumImage[]
    Pages?: { NextPage?: string }
  }
}

// Only Folder and Album nodes are navigable; everything else (Page, System, …) is skipped.
const NAVIGABLE_NODE_TYPES = new Set(['Folder', 'Album'])

// SmugMug paginates with a ready-made `NextPage` URI; carry it forward as our cursor.
// The directory MUST be preserved as the path prefix: the client feeds `nextPagePath`
// back in as the next `directory` (ProviderView pages with `list(nextPagePath)`), so
// dropping it makes page 2+ fall through to the root branch and get adapted with the
// wrong shape — e.g. album images past the first 100 would silently vanish. Mirrors the
// `${directory}?${query}` shape the other providers (OneDrive, Drive, …) use.
const getNextPagePath = (
  nextPage: string | undefined,
  directory: string | undefined,
): string | null => {
  if (!nextPage) return null
  return `${directory ?? ''}?${querystring.stringify({ cursor: nextPage })}`
}

// Captions come back as HTML — real galleries contain `<strong style="…">`,
// `<a href="…">` and `&nbsp;`. Downstream renders escaped plain text, so markup
// would show up literally; strip it here rather than at every consumer.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const MAX_CODE_POINT = 0x10ffff

const decodeEntities = (value: string): string =>
  value.replace(
    /&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi,
    (match, entity: string) => {
      if (!entity.startsWith('#')) {
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match
      }
      const isHex = entity[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(
        isHex ? entity.slice(2) : entity.slice(1),
        isHex ? 16 : 10,
      )
      return Number.isInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= MAX_CODE_POINT
        ? String.fromCodePoint(codePoint)
        : match
    },
  )

// Tags become a space so `a<br>b` doesn't collapse into `ab`; runs of
// whitespace are then squashed back down. Inline tags leave a space stranded
// before the punctuation that follows them (`See <a>the blog</a>.` → `blog .`),
// so reattach it — cheaper and more predictable than classifying tags as
// inline vs block.
const stripHtml = (value: string): string =>
  decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim()

const withoutExtension = (fileName: string): string =>
  fileName.replace(/\.[^./\\]+$/, '')

// SmugMug auto-fills Caption from the filename on some upload paths
// (`batman.jpg` → "batman"), which is pure noise for the only consumer we have
// — the search index, which already indexes the key.
const echoesFileName = (
  caption: string,
  fileName: string | undefined,
): boolean => {
  if (!fileName) return false
  const normalized = caption.toLowerCase()
  return (
    normalized === fileName.toLowerCase() ||
    normalized === withoutExtension(fileName).toLowerCase()
  )
}

/**
 * Normalise a SmugMug image caption for downstream consumption: HTML stripped,
 * whitespace collapsed, filename echoes dropped.
 *
 * Returns `undefined` rather than `''` for anything that doesn't survive, so
 * the column ends up null instead of an empty string.
 */
export function normalizeCaption(
  caption: string | undefined,
  fileName: string | undefined,
): string | undefined {
  if (!caption) return undefined
  const text = stripHtml(caption)
  if (!text || echoesFileName(text, fileName)) return undefined
  return text
}

// An Album node references its album as `/api/v2/album/<AlbumKey>`; pull the key out
// so we can hit the `!images` endpoint when the user opens it.
const getAlbumKey = (node: SmugMugNode): string | undefined => {
  const uri = node.Uris?.Album?.Uri
  if (!uri) return undefined
  return uri.split('/').pop() || undefined
}

/**
 * Adapt a `/node/{id}!children` response into folder/album list items.
 */
export function adaptNodeChildren(
  res: SmugMugNodeChildrenResponse,
  username: string | undefined,
  directory: string | undefined,
): ProviderListResponse {
  const nodes = res.Response?.Node ?? []

  const items = nodes.flatMap((node) => {
    if (node.Type == null || !NAVIGABLE_NODE_TYPES.has(node.Type)) return []

    const isAlbum = node.Type === 'Album'
    const albumKey = isAlbum ? getAlbumKey(node) : undefined
    // Skip nodes we can't navigate to: albums without a resolvable AlbumKey
    // (opening them would hit /node/{id}!children and list nothing), and
    // folders without a NodeID.
    if (isAlbum ? albumKey == null : node.NodeID == null) return []
    const requestPath = isAlbum ? `album:${albumKey}` : `node:${node.NodeID}`

    return [
      {
        // Folders and albums are both navigable containers; render the folder
        // glyph (provider-views' ItemIcon only understands 'file'/'folder'/'video',
        // anything else is treated as an <img> URL).
        isFolder: true,
        icon: 'folder',
        name: node.Name || '',
        mimeType: null,
        id: requestPath,
        requestPath,
        modifiedDate: node.DateModified,
        thumbnail: undefined,
        size: null,
      },
    ]
  })

  return {
    username,
    items,
    nextPagePath: getNextPagePath(res.Response?.Pages?.NextPage, directory),
  }
}

/**
 * Adapt an `/album/{key}!images` response into image list items.
 * Videos are filtered out (images-only for now).
 */
export function adaptAlbumImages(
  res: SmugMugAlbumImagesResponse,
  username: string | undefined,
  directory: string | undefined,
): ProviderListResponse {
  const images = res.Response?.AlbumImage ?? []

  const items = images
    .filter((image) => !image.IsVideo && image.ImageKey != null)
    .map((image) => {
      const name = image.FileName || image.Title || image.ImageKey || ''
      const mimeType = mime.lookup(name)
      const requestPath = `image:${image.ImageKey}`

      return {
        isFolder: false,
        // Falls back to the file glyph when an image has no thumbnail URL.
        icon: image.ThumbnailUrl ?? 'file',
        name,
        mimeType: typeof mimeType === 'string' ? mimeType : null,
        id: requestPath,
        requestPath,
        modifiedDate: image.DateTimeUploaded,
        // Approach A: hand the SmugMug CDN thumbnail straight to the client.
        thumbnail: image.ThumbnailUrl,
        size: image.ArchivedSize ?? null,
        // `Title` is deliberately not mapped: it defaults to the filename on
        // many accounts, and downstream falls back to alt_text for display.
        caption: normalizeCaption(image.Caption, image.FileName),
      }
    })

  return {
    username,
    items,
    nextPagePath: getNextPagePath(res.Response?.Pages?.NextPage, directory),
  }
}
