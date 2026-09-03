/**
 * Minimal partner stub for RabbitVis Hosted Embed.
 *
 * It implements exactly the three endpoints a partner must provide and
 * nothing else: no login, no balance, no signature verification.
 *
 *   POST /api/rabbitvis/embed-session   asks RabbitVis for a one-time launch code
 *   POST /rabbitvis/billing/authorize   answers allow or deny from a switch
 *   POST /rabbitvis/billing/finalize    logs the usage report and accepts it
 *
 * The full simulation with signature checks, balances and fault injection
 * lives in ../partner-embed-demo. Run with Node 20+, no dependencies.
 */
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
const HOST = env.HOST ?? '127.0.0.1'
const PORT = Number(env.PORT ?? 4182)
const PUBLIC_ORIGIN = env.PARTNER_STUB_PUBLIC_ORIGIN ?? `http://${HOST}:${PORT}`
const API_BASE = (env.RABBITVIS_API_BASE_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, '')
const EMBED_ORIGIN = env.RABBITVIS_EMBED_ORIGIN ?? 'http://127.0.0.1:5175'
const SDK_DIR = env.RABBITVIS_EMBED_SDK_DIR
  ?? path.resolve(here, '../../sdk/dist')
const PARTNER_API_KEY = env.RABBITVIS_PARTNER_API_KEY
if (!PARTNER_API_KEY) {
  console.error('[partner-stub] RABBITVIS_PARTNER_API_KEY is required')
  process.exit(1)
}

// The only "billing logic": a switch. Flip it from the page or with
// PARTNER_STUB_AUTHORIZE=deny.
let decision = env.PARTNER_STUB_AUTHORIZE === 'deny' ? 'deny' : 'allow'
const events = []

function log(kind, detail) {
  const entry = { at: new Date().toISOString(), kind, ...detail }
  events.push(entry)
  if (events.length > 500) events.shift()
  console.log(`[partner-stub] ${kind} ${JSON.stringify(detail)}`)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function safeUser(value) {
  return /^[a-z0-9_-]{1,32}$/.test(value ?? '') ? value : 'alice'
}

// 1. BFF: the browser never sees the Partner Key; identity is decided here.
async function createEmbedSession(user) {
  const response = await fetch(`${API_BASE}/v1/partner/embed-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PARTNER_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `stub_${randomUUID().replaceAll('-', '')}`,
    },
    body: JSON.stringify({
      tenantId: 'tenant_stub',
      externalUserId: `stub-user-${user}`,
      externalProjectId: `stub-project-${user}`,
      billingSubjectRef: `stub-billing-${user}`,
      origin: PUBLIC_ORIGIN,
      scopes: ['session:read', 'run:create'],
      sessionTitle: `Stub ${user}`,
    }),
  })
  const body = await response.json().catch(() => ({}))
  log('embed-session', { user, status: response.status, sessionId: body.sessionId, error: body.error?.code })
  return { status: response.status, body }
}

function page(user) {
  return `<!doctype html>
<meta charset="utf-8">
<title>Partner stub · ${user}</title>
<style>
  body{margin:0;font:14px system-ui,sans-serif;background:#f4f4f5;color:#111}
  header{display:flex;gap:14px;align-items:center;padding:12px 20px;background:#fff;border-bottom:1px solid #ddd}
  header b{font-size:16px}
  .pill{padding:4px 10px;border-radius:999px;background:#eee}
  .pill.allow{background:#e2f7e6;color:#060}
  .pill.deny{background:#fde2e2;color:#a00}
  a.btn{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;text-decoration:none}
  #embed{height:620px;margin:16px 20px;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden}
  #log{margin:0 20px 20px;padding:12px;background:#111;color:#9f9;font:12px/1.5 ui-monospace,monospace;height:220px;overflow:auto;white-space:pre-wrap;border-radius:8px}
</style>
<header>
  <b>合作方 Stub</b>
  <span>用户：${user}</span>
  <span id="decision" class="pill">AUTHORIZE: …</span>
  <a class="btn" href="/stub/decision?set=allow&user=${user}">设为 allow</a>
  <a class="btn" href="/stub/decision?set=deny&user=${user}">设为 deny</a>
  <a class="btn" href="/?user=${user === 'bob' ? 'alice' : 'bob'}">切到 ${user === 'bob' ? 'alice' : 'bob'}</a>
</header>
<div id="embed"></div>
<pre id="log">SDK 事件与三个合作方接口的调用会显示在这里。</pre>
<script type="module">
  import { mountRabbitVisEmbed } from '/sdk/index.js'
  const logEl = document.getElementById('log')
  const write = (line) => {
    logEl.textContent += '\\n' + new Date().toLocaleTimeString() + ' ' + line
    logEl.scrollTop = logEl.scrollHeight
  }
  let seen = 0
  async function poll() {
    try {
      const data = await fetch('/stub/events', { cache: 'no-store' }).then((r) => r.json())
      const pill = document.getElementById('decision')
      pill.textContent = 'AUTHORIZE: ' + data.decision
      pill.className = 'pill ' + data.decision
      for (const e of data.events.slice(seen)) write('[stub] ' + e.kind + ' ' + JSON.stringify(e))
      seen = data.events.length
    } catch {}
  }
  await poll()
  setInterval(poll, 1500)
  try {
    await mountRabbitVisEmbed({
      container: document.getElementById('embed'),
      rabbitVisOrigin: ${JSON.stringify(EMBED_ORIGIN)},
      sessionEndpoint: '/api/rabbitvis/embed-session?user=${user}',
      onEvent(event) { write('[sdk] ' + event.type + ' ' + JSON.stringify(event.payload)) },
    })
  } catch (error) {
    write('[sdk] mount failed: ' + (error && error.message))
  }
</script>
`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', PUBLIC_ORIGIN)
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(page(safeUser(url.searchParams.get('user'))))
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/sdk/')) {
      const name = url.pathname.slice('/sdk/'.length)
      if (!/^[a-z-]+\.js$/.test(name)) return sendJson(res, 404, { error: { code: 'not_found' } })
      const source = await readFile(path.join(SDK_DIR, name))
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(source)
      return
    }
    if (req.method === 'GET' && url.pathname === '/stub/events') {
      return sendJson(res, 200, { decision, events })
    }
    if (req.method === 'GET' && url.pathname === '/stub/decision') {
      const next = url.searchParams.get('set')
      if (next === 'allow' || next === 'deny') {
        decision = next
        log('decision', { decision })
      }
      res.writeHead(303, { Location: `/?user=${safeUser(url.searchParams.get('user'))}` })
      res.end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/rabbitvis/embed-session') {
      await readJson(req)
      const result = await createEmbedSession(safeUser(url.searchParams.get('user')))
      return sendJson(res, result.status, result.body)
    }
    // 2. AUTHORIZE: RabbitVis calls this synchronously before it runs anything.
    //    Responding deny, timing out or failing all mean "do not execute".
    if (req.method === 'POST' && url.pathname === '/rabbitvis/billing/authorize') {
      const input = await readJson(req)
      log('AUTHORIZE', {
        operationId: input.operationId,
        turnId: input.turnId,
        subject: input.billingSubjectRef,
        // 'run' = a conversation turn; 'image_action' = a canvas image service (estimate.action names it).
        operation: input.operation,
        action: input.estimate?.action ?? null,
        estimate: input.estimate?.rabbitvisUsageUnits ?? null,
        decision,
      })
      return sendJson(res, 200, decision === 'allow'
        ? { schemaVersion: '1', decision: 'allow', authorizationId: `stub_authz_${input.operationId}` }
        : { schemaVersion: '1', decision: 'deny', reason: 'stub_denied' })
    }
    // 3. FINALIZE: the actual RabbitVis usage for one operation. RabbitVis retries
    //    until it gets `accepted`, so a real partner must deduplicate by eventId.
    if (req.method === 'POST' && url.pathname === '/rabbitvis/billing/finalize') {
      const input = await readJson(req)
      log('FINALIZE', {
        eventId: input.eventId,
        operationId: input.operationId,
        // Same turnId the page saw in the SDK's run.settled event.
        turnId: input.turnId,
        kind: input.kind,
        outcome: input.outcome,
        units: input.actualUsage?.rabbitvisUsageUnits,
        authorizationId: input.authorizationId,
      })
      return sendJson(res, 200, { schemaVersion: '1', accepted: true, eventId: input.eventId })
    }
    sendJson(res, 404, { error: { code: 'not_found' } })
  } catch (error) {
    log('error', { path: url.pathname, message: error instanceof Error ? error.message : String(error) })
    if (!res.headersSent) sendJson(res, 500, { error: { code: 'stub_error' } })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[partner-stub] listening on ${PUBLIC_ORIGIN}  (RabbitVis API ${API_BASE}, embed ${EMBED_ORIGIN}, AUTHORIZE=${decision})`)
})
