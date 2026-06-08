# @massif-network/smugmug

Uppy acquirer plugin for importing files from a user's [SmugMug](https://www.smugmug.com/)
account, via [Companion](https://uppy.io/docs/companion/). This is the client-side
Dashboard tab; the server-side logic lives in the Companion provider at
[`packages/@uppy/companion/src/server/provider/smugmug`](../../@uppy/companion/src/server/provider/smugmug)
(see its README for the OAuth 1.0a design).

It's a thin wrapper around `@uppy/companion-client` + `@uppy/provider-views`
(mirrors `@uppy/box`). It's named `@massif-network/smugmug` only so we can publish
it to a registry we control — the Companion provider id is still `smugmug`.

## Install

Published to **GitHub Packages** under the `@massif-network` scope. In the
consuming project, add an `.npmrc`:

```
@massif-network:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

(`GITHUB_TOKEN` needs `read:packages`.) Then:

```sh
yarn add @massif-network/smugmug
```

Its `@uppy/*` dependencies resolve from public npm as usual — only the
`@massif-network` scope hits GitHub Packages.

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

## Releasing

Published by `.github/workflows/publish-smugmug.yml` (manual **Run workflow**):

- Run it from **`main`** → publishes the exact `version` in `package.json` under
  the `latest` dist-tag. Bump `version` before merging to cut a release.
- Run it from **any other branch** → publishes `‹version›-rc.‹run-number›` under
  the `rc` dist-tag, so branch builds never clobber the stable release.
  Consume a prerelease with `yarn add @massif-network/smugmug@rc`.
