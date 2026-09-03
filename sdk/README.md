# RabbitVis Embed SDK

The SDK mounts the RabbitVis-hosted editor. Partner user identity and secrets
stay on the partner backend; the browser only asks that backend for a one-time
`embedUrl`.

```ts
import { mountRabbitVisEmbed } from '@rabbitvis/embed-sdk'

const embed = await mountRabbitVisEmbed({
  container: document.querySelector('#rabbitvis')!,
  rabbitVisOrigin: 'https://embed.rabbitvis.com',
  sessionEndpoint: '/api/rabbitvis/embed-session',
  onEvent(event) {
    if (event.type === 'run.settled') {
      // RabbitVis iframe 不负责余额 UI；在合作方页面中自行刷新余额/次数。
      // event.payload.turnId 与合作方后端收到的 FINALIZE/RELEASE 里的 turnId 一致。
      if (event.payload.outcome === 'succeeded') void refreshPartnerBalance()
      if (event.payload.outcome === 'rejected') showRejection(event.payload.code)
    }
  },
})

// Optional commands:
embed.focus()
// embed.destroy()
```

`sessionEndpoint` is always called with same-origin cookies using `POST` and
must return `{ "embedUrl": "https://embed.rabbitvis.com/embed/#code=..." }`.
Because that call is cookie-authenticated, the endpoint needs the partner's
usual CSRF protection (an `Origin`/`Referer` check or a CSRF token); the SDK
sends `Content-Type: application/json`, so plain cross-site form posts are
already rejected by browsers, but do not rely on that alone.
For a custom auth or networking stack, provide `getEmbedSession` instead of
`sessionEndpoint`; the two options are mutually exclusive.

## Events

| type | payload | when |
|---|---|---|
| `ready` | `{}` | the iframe finished its token handshake |
| `run.started` | `{ turnId }` | a generation turn was submitted |
| `run.settled` | `{ turnId, outcome, code? }` | the turn reached a terminal state; `outcome` is `succeeded`, `failed`, `cancelled` or `rejected`, and `code` names the server refusal for `rejected`, e.g. `partner.usage_denied` |
| `session.refresh-requested` | `{ reason }` | the embed session expired or became invalid; the SDK reloads it automatically |
| `error` | `{ code, recoverable }` | launch or session refresh failed |

`turnId` is the correlation key with the partner backend: FINALIZE and RELEASE
callbacks carry the same value, so a page can match what the user saw with
what was billed.

The SDK validates the iframe origin, window source, protocol version and
instance id for every message. It never accepts a partner user id or secret,
and it never exposes RabbitVis access/refresh tokens or internal run payloads.
