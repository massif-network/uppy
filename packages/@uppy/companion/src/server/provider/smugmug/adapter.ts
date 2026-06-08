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
const getNextPagePath = (nextPage: string | undefined): string | null => {
  if (!nextPage) return null
  return `?${querystring.stringify({ cursor: nextPage })}`
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
): ProviderListResponse {
  const nodes = res.Response?.Node ?? []

  const items = nodes
    .filter((node) => node.Type != null && NAVIGABLE_NODE_TYPES.has(node.Type))
    .map((node) => {
      const isAlbum = node.Type === 'Album'
      const albumKey = isAlbum ? getAlbumKey(node) : undefined
      const requestPath =
        isAlbum && albumKey ? `album:${albumKey}` : `node:${node.NodeID}`

      return {
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
      }
    })
    // An album whose key we couldn't resolve isn't navigable; drop it.
    .filter((item) => !item.requestPath.endsWith(':undefined'))

  return {
    username,
    items,
    nextPagePath: getNextPagePath(res.Response?.Pages?.NextPage),
  }
}

/**
 * Adapt an `/album/{key}!images` response into image list items.
 * Videos are filtered out (images-only for now).
 */
export function adaptAlbumImages(
  res: SmugMugAlbumImagesResponse,
  username: string | undefined,
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
      }
    })

  return {
    username,
    items,
    nextPagePath: getNextPagePath(res.Response?.Pages?.NextPage),
  }
}
