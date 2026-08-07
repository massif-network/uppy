# @massif-network/smugmug

Uppy acquirer plugin for importing files from a user's [SmugMug](https://www.smugmug.com/)
account, via [Companion](https://uppy.io/docs/companion/). This is the client-side
Dashboard tab; the server-side logic lives in the Companion provider at
[`packages/@uppy/companion/src/server/provider/smugmug`](../@uppy/companion/src/server/provider/smugmug)
(see its README for the OAuth 1.0a design).

It's a thin wrapper around `@uppy/companion-client` + `@uppy/provider-views`
(mirrors `@uppy/box`). The Companion provider id is `smugmug`.

## Status: private workspace package

This package is **not published to any registry**. It's `"private": true` and
exists only as a workspace member. Two copies exist:

| Repo | Path | Consumed by |
| --- | --- | --- |
| this fork (`massif-network/uppy`) | `packages/smugmug` | `private/dev` (dev playground, via the vite alias in `private/dev/vite.config.js`) |
| `massif-network/massif` | `packages/smugmug` | `apps/web`, as a `workspace:*` dependency |

**The two copies are hand-mirrored.** There is no tooling keeping them in sync —
a change here must be copied into the massif repo (and vice versa) by hand. The
massif copy additionally commits its built `lib/` output; see its own README.

It used to be published to GitHub Packages under the `@massif-network` scope,
which is why it still carries that name. The scope is now vestigial — keeping it
avoids churning every import statement in both repos.

## Usage

```ts
import SmugMug from '@massif-network/smugmug'

uppy.use(SmugMug, {
  target: Dashboard,
  companionUrl: 'https://your-companion.example.com',
  companionAllowedHosts,
})
```

Requires a Companion instance with the `smugmug` provider enabled
(`COMPANION_SMUGMUG_API_KEY` / `COMPANION_SMUGMUG_API_SECRET`).

## Development

```sh
yarn workspace @massif-network/smugmug build
yarn workspace @massif-network/smugmug test
```

Note the root `yarn test` filter does not cover this package — run it by name.
