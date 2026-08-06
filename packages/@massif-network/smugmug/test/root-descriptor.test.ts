/* @vitest-environment jsdom */

import { tokenStorage } from '@uppy/companion-client'
import { Uppy } from '@uppy/core'
import { render } from 'preact'
import { describe, expect, test, vi } from 'vitest'
import { buildSourceRootFromPartialTree } from '../src/root-descriptor.js'
import SmugMug, { renderDescriptorModeFooter } from '../src/SmugMug.js'

const tree: PartialTree = [
  { type: 'root', id: null, cached: true, nextPagePath: null },
  {
    type: 'folder',
    id: 'node:R',
    cached: true,
    nextPagePath: null,
    status: 'unchecked',
    parentId: null,
    data: { name: 'Location Vault 2026', icon: 'folder', isFolder: true },
  },
  {
    type: 'folder',
    id: 'album:X',
    cached: true,
    nextPagePath: null,
    status: 'unchecked',
    parentId: 'node:R',
    data: { name: 'HD 1', icon: 'folder', isFolder: true },
  },
]

describe('buildSourceRootFromPartialTree', () => {
  test('returns null at the account root', () => {
    expect(buildSourceRootFromPartialTree(null, tree)).toBeNull()
  })

  test('returns null for an id not present in the tree', () => {
    expect(buildSourceRootFromPartialTree('node:ghost', tree)).toBeNull()
  })

  test('builds a folder root from a node: id', () => {
    expect(buildSourceRootFromPartialTree('node:R', tree)).toEqual({
      schemaVersion: 1,
      provider: 'smugmug',
      kind: 'folder',
      stableId: 'node:R',
      requestPath: 'node:R',
      name: 'Location Vault 2026',
    })
  })

  test('builds an album root from an album: id', () => {
    expect(buildSourceRootFromPartialTree('album:X', tree)).toEqual({
      schemaVersion: 1,
      provider: 'smugmug',
      kind: 'album',
      stableId: 'album:X',
      requestPath: 'album:X',
      name: 'HD 1',
    })
  })

  test('returns null for a file id (not a folder)', () => {
    const fileNode = {
      type: 'file',
      id: 'image:AAA',
      restrictionError: null,
      status: 'unchecked',
      parentId: 'album:X',
      data: { name: 'a.jpg', isFolder: false },
    } as unknown as PartialTreeFile
    expect(
      buildSourceRootFromPartialTree('image:AAA', [...tree, fileNode]),
    ).toBeNull()
  })
})

describe('descriptor-mode footer', () => {
  test('renders an import action that invokes the supplied root callback', () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const container = document.createElement('div')
    render(
      renderDescriptorModeFooter({
        canImport: true,
        onSelect,
        onCancel,
      }),
      container,
    )
    const importButton = container.querySelector('button')

    expect(container.textContent).toContain('Import this album/folder')
    expect(importButton).not.toBeNull()
    importButton?.click()
    expect(onSelect).toHaveBeenCalledOnce()
  })

  test('disables the action when no folder root is selected', () => {
    const container = document.createElement('div')
    render(
      renderDescriptorModeFooter({
        canImport: false,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      container,
    )
    const importButton = container.querySelector('button')

    expect(importButton).not.toBeNull()
    expect(importButton?.disabled).toBe(true)
  })
})

describe('SmugMug plugin storage and grant origin', () => {
  test('keeps tokenStorage for ordinary mode and memory storage for descriptor mode', () => {
    const ordinary = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
    })
    const descriptor = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
    })
    const explicit = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    const configured = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
      storage: explicit,
    })

    expect(ordinary.storage).toBe(tokenStorage)
    expect(descriptor.storage).not.toBe(tokenStorage)
    expect(configured.storage).not.toBe(explicit)
  })

  test('mints grants from the canonical companion host after remapping', async () => {
    const configuredHost = 'https://configured.example.com'
    const canonicalHost = 'https://canonical.example.com'
    const uppy = new Uppy()
    const plugin = new SmugMug(uppy, { companionUrl: configuredHost })
    vi.spyOn(plugin.provider, 'headers').mockResolvedValue({
      'uppy-auth-token': 'token',
    })

    uppy.setState({ companion: { [configuredHost]: canonicalHost } })

    const grant = await plugin.getServiceWorkerGrant()

    expect(grant.companionOrigin).toBe(canonicalHost)
  })
})

describe('SmugMug descriptor-mode render', () => {
  test('renders the root action and never calls donePicking', () => {
    const uppy = new Uppy()
    const onSourceRootSelected = vi.fn()
    const plugin = new SmugMug(uppy, {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
      onSourceRootSelected,
    })
    plugin.install()
    uppy.setState({
      plugins: {
        ...uppy.getState().plugins,
        [plugin.id]: {
          authenticated: true,
          partialTree: tree,
          currentFolderId: 'album:X',
          searchString: '',
          didFirstRender: true,
          username: null,
          loading: false,
        },
      },
    })
    const donePicking = vi.spyOn(plugin.view, 'donePicking')
    const container = document.createElement('div')
    render(plugin.render(uppy.getState()), container)
    const descriptorFooters = container.querySelectorAll(
      '.uppy-SmugMug-descriptor-footer',
    )
    const importButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Import this album/folder',
    )

    expect(descriptorFooters).toHaveLength(1)
    expect(importButton).not.toBeUndefined()
    importButton?.click()
    expect(onSourceRootSelected).toHaveBeenCalledWith(
      expect.objectContaining({ stableId: 'album:X' }),
    )
    expect(donePicking).not.toHaveBeenCalled()
  })

  test('does not render the descriptor footer before authentication', () => {
    const uppy = new Uppy()
    const plugin = new SmugMug(uppy, {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
    })
    plugin.install()
    uppy.setState({
      plugins: {
        ...uppy.getState().plugins,
        [plugin.id]: {
          ...plugin.getPluginState(),
          authenticated: false,
        },
      },
    })
    const container = document.createElement('div')

    render(plugin.render(uppy.getState()), container)

    expect(
      container.querySelectorAll('.uppy-SmugMug-descriptor-footer'),
    ).toHaveLength(0)
  })
})

describe('SmugMug storage and Service Worker grant', () => {
  test('uses persistent tokenStorage in ordinary mode and memory storage in descriptor mode', () => {
    const ordinary = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
    })
    const descriptor = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
    })
    const explicitStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const explicit = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      storage: explicitStorage,
    })
    const descriptorExplicit = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
      storage: explicitStorage,
    })

    expect(ordinary.storage).toBe(tokenStorage)
    expect(descriptor.storage).not.toBe(tokenStorage)
    expect(explicit.storage).toBe(explicitStorage)
    expect(descriptorExplicit.storage).not.toBe(explicitStorage)
    expect(descriptorExplicit.storage).not.toBe(tokenStorage)
  })

  test('omits browser cookies in descriptor mode while ordinary mode preserves the rule', () => {
    const descriptor = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      rootDescriptorMode: true,
      companionCookiesRule: 'include',
    })
    const ordinary = new SmugMug(new Uppy(), {
      companionUrl: 'https://companion.example.com',
      companionCookiesRule: 'include',
    })

    expect(descriptor.provider.opts.companionCookiesRule).toBe('omit')
    expect(ordinary.provider.opts.companionCookiesRule).toBe('include')
  })

  test('mints a grant for the canonical companion host discovered by Provider', async () => {
    const configuredHost = 'https://configured.example.com'
    const canonicalHost = 'https://canonical.example.com/'
    const uppy = new Uppy()
    const plugin = new SmugMug(uppy, { companionUrl: configuredHost })
    uppy.setState({ companion: { [configuredHost]: canonicalHost } })
    vi.spyOn(plugin.provider, 'headers').mockResolvedValue({
      'uppy-auth-token': 'token',
    })

    const grant = await plugin.getServiceWorkerGrant()

    expect(grant.companionOrigin).toBe('https://canonical.example.com')
  })
})
