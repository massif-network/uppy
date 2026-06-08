# SmugMug Companion provider

Imports files from a user's [SmugMug](https://www.smugmug.com/) account.

SmugMug is the **only OAuth 1.0a** provider in Companion — every other provider
is OAuth 2.0. That single fact drives most of the design decisions below.

## Authentication (OAuth 1.0a)

- Grant ships a built-in `smugmug` config (request/authorize/access URLs,
  `oauth: 1`), so `config/grant.ts` only layers on `callback` + `custom_params`.
- **`state: true` is required** (we spread `defaults`). It looks like an OAuth2
  CSRF concept, but Companion uses Grant's state mechanism to carry its own
  encrypted state (origin + `authCallbackToken`) through the flow; `send-token`
  reads it back to deliver the auth token to the client. Grant's OAuth1 access
  step does not validate `state`, so enabling it is safe. Without it, the auth
  token is never delivered and the client hangs on the login screen.
- `custom_params: { Access: 'Full', Permissions: 'Read' }` — `Full` lets users
  pick from **private** albums; `Read` keeps it read-only.

### Capturing the token secret

OAuth1 signs every request with a `consumer_key`/`consumer_secret` **and** an
`oauth_token`/`oauth_token_secret`. The shared callback controller only persists
`access_token`/`refresh_token` (OAuth2 shape), so the `access_secret` would be
lost. We added a generic `Provider.grantResponseToUserSession()` hook (defaults
to `{}`; called from `controllers/callback.ts`) and override it here to persist
`accessTokenSecret`. This is the one shared-code touchpoint outside this folder.

### Request signing

Every API call (and the `ArchivedUri` download) is HMAC-SHA1 signed via the
`oauth-1.0a` package, attached in a `got` `beforeRequest` hook. The OAuth1 base
string must include query params, so they are passed as `data` (oauth-1.0a also
re-derives them from the URL — identical keys collapse, no double counting).
Consumer key/secret come from `providerOptions.smugmug` (env
`COMPANION_SMUGMUG_API_KEY` / `COMPANION_SMUGMUG_API_SECRET`).

## Browsing model

SmugMug's tree has three node kinds that don't map 1:1 onto the flat
`list({ directory })` interface, so `requestPath` uses a `type:id` scheme:

| requestPath        | endpoint                  | items                         |
| ------------------ | ------------------------- | ----------------------------- |
| _(root, no dir)_   | `!authuser` → root node   | resolves nickname → children  |
| `node:<NodeID>`    | `/node/{id}!children`     | Folders + Albums (`isFolder`) |
| `album:<AlbumKey>` | `/album/{key}!images`     | Images (`!isFolder`)          |
| `image:<ImageKey>` | `/image/{key}` (download) | the original file             |

- Folder **and** Album nodes are surfaced as `isFolder: true`; `Page` and other
  node types are skipped. Album keys are parsed from the node's `Uris.Album`.
- Both folders and albums render the **`folder`** icon — provider-views'
  `ItemIcon` only understands `'file'`/`'folder'`/`'video'`; any other string is
  treated as an `<img src>` (which is why `'album'` produced a broken image).
- Pagination is driven off the response's `Pages.NextPage` URI, carried forward
  as the `cursor` query param.

## Downloads, thumbnails, size

- **Download** streams the original via the image's `ArchivedUri` (OAuth1-signed).
- **Size** comes from `ArchivedSize` (returned by `download()`); we don't
  override `size()` because the controller doesn't pass `companion` there (no
  way to obtain consumer creds to sign), and `ArchivedUri` returns a
  `Content-Length` anyway.
- **Thumbnails** use the image's CDN `ThumbnailUrl` directly (approach A). If
  private-album thumbnails ever fail to render, the fallback is to proxy them
  through Companion (approach B) with signing.

## Logout

SmugMug has no token-revoke API. `logout()` returns
`{ revoked: false, manual_revoke_url: '…/account/authorizedservices' }` so the
client can point the user at the right place.

## Scope / deferred

- **Images only.** Videos are filtered out in the adapter (their original isn't
  exposed via `ArchivedUri`). Tracked in massif-network/massif#599.
- **No `search()`.** Inherits the base "not implemented". Tracked in
  massif-network/massif#600.
