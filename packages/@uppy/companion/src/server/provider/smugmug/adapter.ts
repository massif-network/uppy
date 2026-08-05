import querystring from 'node:querystring'
import mime from 'mime-types'
import type { ProviderListResponse } from '../Provider.js'

// SmugMug API v2 response shapes (only the fields we consume).
// Docs: https://api.smugmug.com/api/v2/doc/index.html

export type SmugMugRef = string | { Uri?: string }

export const getUri = (ref: SmugMugRef | undefined): string | undefined =>
  typeof ref === 'string' ? ref : ref?.Uri

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
  ArchivedMD5?: string
  IsVideo?: boolean
  ThumbnailUrl?: string
  DateTimeUploaded?: string
  LastUpdated?: string
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

// An Album node references its album as `/api/v2/album/<AlbumKey>`; pull the key out
// so we can hit the `!images` endpoint when the user opens it.
const getAlbumKey = (node: SmugMugNode): string | undefined => {
  const uri = getUri(node.Uris?.Album)
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
        modifiedDate: image.LastUpdated,
        // Approach A: hand the SmugMug CDN thumbnail straight to the client.
        thumbnail: image.ThumbnailUrl,
        size: image.ArchivedSize ?? null,
      }
    })

  return {
    username,
    items,
    nextPagePath: getNextPagePath(res.Response?.Pages?.NextPage, directory),
  }
}
