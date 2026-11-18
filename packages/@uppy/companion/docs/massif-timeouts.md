# Massif fork: remote-upload timers and their logging

Every timer that can abort a remote upload (provider to Companion to destination),
its value, and the log line written when it fires. Reference: massif-network/massif#2136, #2139.

## Timers

| Timer | Where | Value | Env / option |
| --- | --- | --- | --- |
| `socket-wait` | `Uploader.awaitReady` (`src/server/Uploader.ts`), `AbortSignal.timeout` | `60000` ms | `COMPANION_CLIENT_SOCKET_CONNECT_TIMEOUT` / `clientSocketConnectTimeout` (default in `src/config/companion.ts`) |
| `download-or-upload` | provider download and the upload to the destination (Mux, tus, multipart, S3) | none configured: `got` and tus defaults apply | n/a |

`socket-wait` is the only Companion-side timer in the remote upload path. Companion
returns the upload token to the client, then waits up to `clientSocketConnectTimeout`
for the client to open the websocket for that token before it starts the download.
If the client does not connect in time, `once()` rejects with
`AbortError: The operation was aborted` whose `cause` is
`DOMException [TimeoutError]`. This is what #2136 saw.

The client has its own, separate wait: `@uppy/core` `RequestClient`
`socketActivityTimeoutMs` (5 min) and `uploadRemoteFile` retries.

Other timers in the package are not part of a remote upload: the S3 multipart
`withTimeout` (`controllers/s3.ts`) and the periodic ping `requestTimeout`
(`jobs.ts`). Dropbox and SmugMug retry only on HTTP 429, honouring `retry-after`.

## Log line

One line at level `error`, tag `uploader.abort`, trace id = the short token:

```
companion: 2026-11-18T10:00:00.000Z [error] a1b2c3d4 uploader.abort remote upload aborted: timer=socket-wait timeoutMs=60000 token=a1b2c3d4 provider=dropbox fileId="id:AAAA" fileName="holiday.mov" error=AbortError(cause=TimeoutError)
```

- `token` is the first 8 characters of the upload token (`Uploader.shortToken`), the
  same id every other Uploader log line uses. The full token is never logged.
- `provider` is the route's provider name (`/url` and `/google-picker` use the mount name).
- `fileId` is the provider's file id (route `:id`), `fileName` is `metadata.name`; both
  JSON-quoted, `null` when absent.
- `timer` is `socket-wait` or `download-or-upload`. For `download-or-upload`,
  `timeoutMs=none-configured`: the abort came from the HTTP client or a stream, not from a
  Companion timer.
- Never logged: file contents, access tokens, headers, query, request body, URLs.

The line is logging only. The error is rethrown and handled as before; no timeout or retry changed.
