import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import http from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { BillingProtocolError, createBillingStore } from './billing-store.mjs'

const JSON_LIMIT_BYTES = 64 * 1024
const SESSION_COOKIE = 'partner_demo_session'
const SDK_ASSET_PREFIX = '/assets/rabbitvis-embed-sdk/'
const DEFAULT_SDK_DIR = fileURLToPath(
  new URL('../../../sdk/dist/', import.meta.url),
)
const FAULT_ACTIONS = new Set(['authorize', 'finalize'])
const FAULT_MODES = new Set(['none', 'deny', '500', 'timeout', 'commit_then_drop'])

function integer(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected integer between ${minimum} and ${maximum}, received ${value}`)
  }
  return parsed
}

function required(value, name) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) throw new Error(`${name} is required`)
  return result
}

function normalizedBaseUrl(value, name) {
  const url = new URL(required(value, name))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }
  return url.toString().replace(/\/$/, '')
}

export function loadDemoConfig(env = process.env) {
  const port = integer(env.PORT ?? env.PARTNER_DEMO_PORT, 4180, { minimum: 0, maximum: 65535 })
  const host = env.HOST?.trim() || env.PARTNER_DEMO_HOST?.trim() || '127.0.0.1'
  const apiBaseUrl = normalizedBaseUrl(
    env.RABBITVIS_API_BASE_URL ?? 'http://127.0.0.1:3001',
    'RABBITVIS_API_BASE_URL',
  )
  const partnerApiKey = required(env.RABBITVIS_PARTNER_API_KEY, 'RABBITVIS_PARTNER_API_KEY')
  const billingSigningSecret = required(
    env.RABBITVIS_BILLING_SIGNING_SECRET,
    'RABBITVIS_BILLING_SIGNING_SECRET',
  )
  const publicOrigin = env.PARTNER_DEMO_PUBLIC_ORIGIN?.trim()
    ? new URL(env.PARTNER_DEMO_PUBLIC_ORIGIN.trim()).origin
    : ''
  const embedOrigin = new URL(
    env.RABBITVIS_EMBED_ORIGIN?.trim() || 'http://127.0.0.1:5174',
  ).origin
  const sdkUrl = env.RABBITVIS_EMBED_SDK_URL?.trim() || ''
  const configuredSdkDir = env.RABBITVIS_EMBED_SDK_DIR?.trim() || ''
  if (sdkUrl && configuredSdkDir) {
    throw new Error('Provide only one of RABBITVIS_EMBED_SDK_URL or RABBITVIS_EMBED_SDK_DIR')
  }
  if (sdkUrl) normalizedBaseUrl(sdkUrl, 'RABBITVIS_EMBED_SDK_URL')
  const sdkDir = sdkUrl ? '' : configuredSdkDir || DEFAULT_SDK_DIR

  return {
    port,
    host,
    apiBaseUrl,
    partnerApiKey,
    partnerId: env.RABBITVIS_PARTNER_ID?.trim() || 'partner_demo',
    tenantId: env.RABBITVIS_TENANT_ID?.trim() || 'tenant_demo',
    externalProjectPrefix: env.RABBITVIS_EXTERNAL_PROJECT_PREFIX?.trim() || 'demo_project',
    scopes: (env.RABBITVIS_EMBED_SCOPES ?? 'session:read,run:create')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    publicOrigin,
    embedOrigin,
    sdkUrl,
    sdkDir,
    billingSigningSecret,
    signatureToleranceSeconds: integer(env.RABBITVIS_SIGNATURE_TOLERANCE_SECONDS, 300, {
      minimum: 1,
      maximum: 3600,
    }),
    requestTimeoutMs: integer(env.RABBITVIS_REQUEST_TIMEOUT_MS, 5_000, {
      minimum: 50,
      maximum: 60_000,
    }),
    initialPartnerPoints: integer(env.PARTNER_DEMO_INITIAL_POINTS, 100),
    initialUses: integer(env.PARTNER_DEMO_INITIAL_USES, 10),
    pointsPerOperation: integer(env.PARTNER_DEMO_POINTS_PER_OPERATION, 5),
    chargeFailedOperations: env.PARTNER_DEMO_CHARGE_FAILED_OPERATIONS === '1',
    controlToken: env.PARTNER_DEMO_CONTROL_TOKEN?.trim() || '',
    secureCookie: env.PARTNER_DEMO_COOKIE_SECURE === '1',
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonForHtml(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function parseCookies(header) {
  const out = new Map()
  for (const item of String(header ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1) continue
    const key = item.slice(0, separator).trim()
    const value = item.slice(separator + 1).trim()
    try {
      out.set(key, decodeURIComponent(value))
    } catch {
      // A malformed cookie is ignored rather than becoming an auth bypass.
    }
  }
  return out
}

async function readRawBody(req, limit = JSON_LIMIT_BYTES) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > limit) {
      throw new BillingProtocolError(413, 'request_too_large', 'request body is too large')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw new BillingProtocolError(400, 'invalid_json', 'request body must be valid JSON')
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

function sendProtocolError(res, error) {
  if (error instanceof BillingProtocolError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  console.error('[partner-demo] request failed:', error)
  sendJson(res, 500, { error: { code: 'internal', message: 'partner demo request failed' } })
}

function safeEqualText(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function billingBodyDigest(rawBody) {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex')
}

export function signBillingBody(secret, input) {
  const canonical = [
    'v1',
    input.method,
    input.target,
    input.timestamp,
    input.nonce,
    input.idempotencyKey,
    input.bodyDigest,
  ].join('\n')
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url')
}

export function billingSignatureHeaders(secret, rawBody, options) {
  if (!options || typeof options !== 'object') throw new Error('billing signature options are required')
  const method = String(options.method ?? 'POST').toUpperCase()
  const target = required(options.target, 'billing signature target')
  const timestamp = options.timestamp ?? new Date().toISOString()
  const nonce = options.nonce ?? randomUUID()
  const idempotencyKey = required(options.idempotencyKey, 'billing idempotency key')
  const partnerId = required(options.partnerId, 'billing partner id')
  const bodyDigest = billingBodyDigest(rawBody)
  const signature = signBillingBody(secret, {
    method,
    target,
    timestamp,
    nonce,
    idempotencyKey,
    bodyDigest,
  })
  return {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'Idempotency-Key': idempotencyKey,
    'X-RabbitVis-Contract': 'partner-billing-v1',
    'X-RabbitVis-Partner-Id': partnerId,
    'X-RabbitVis-Timestamp': timestamp,
    'X-RabbitVis-Nonce': nonce,
    'X-RabbitVis-Body-SHA256': bodyDigest,
    'X-RabbitVis-Signature': `v1=${signature}`,
  }
}

function verifyBillingSignature(req, rawBody, config, nowMs, seenNonces) {
  const contract = String(req.headers['x-rabbitvis-contract'] ?? '')
  const partnerId = String(req.headers['x-rabbitvis-partner-id'] ?? '')
  const timestamp = String(req.headers['x-rabbitvis-timestamp'] ?? '')
  const nonce = String(req.headers['x-rabbitvis-nonce'] ?? '')
  const idempotencyKey = String(req.headers['idempotency-key'] ?? '')
  const claimedDigest = String(req.headers['x-rabbitvis-body-sha256'] ?? '')
  const signatureHeader = String(req.headers['x-rabbitvis-signature'] ?? '')
  const signature = signatureHeader.startsWith('v1=') ? signatureHeader.slice(3) : ''
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  const accept = String(req.headers.accept ?? '').toLowerCase()
  const acceptEncoding = String(req.headers['accept-encoding'] ?? '').toLowerCase()
  if (
    contract !== 'partner-billing-v1'
    || partnerId !== config.partnerId
    || req.method !== 'POST'
    || !contentType.startsWith('application/json')
    || accept !== 'application/json'
    || acceptEncoding !== 'identity'
    || !nonce
    || !idempotencyKey
  ) {
    throw new BillingProtocolError(401, 'invalid_signature', 'billing signature headers are incomplete')
  }
  const timestampMs = Date.parse(timestamp)
  if (!Number.isFinite(timestampMs)) {
    throw new BillingProtocolError(401, 'invalid_signature', 'billing timestamp is missing or invalid')
  }
  const skew = Math.abs(nowMs() - timestampMs) / 1000
  if (skew > config.signatureToleranceSeconds) {
    throw new BillingProtocolError(401, 'signature_expired', 'billing request timestamp is outside the replay window')
  }
  const bodyDigest = billingBodyDigest(rawBody)
  if (!/^[a-f0-9]{64}$/.test(claimedDigest) || !safeEqualText(bodyDigest, claimedDigest)) {
    throw new BillingProtocolError(401, 'invalid_signature', 'billing body digest is invalid')
  }
  const url = new URL(req.url ?? '/', 'http://partner-demo.invalid')
  const expected = signBillingBody(config.billingSigningSecret, {
    method: req.method,
    target: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    idempotencyKey,
    bodyDigest,
  })
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature) || !safeEqualText(expected, signature)) {
    throw new BillingProtocolError(401, 'invalid_signature', 'billing request signature is invalid')
  }
  // Only after the signature is proven: an unauthenticated caller must not be
  // able to fill the nonce cache and lock out RabbitVis.
  rememberNonce(seenNonces, nonce, nowMs(), config.signatureToleranceSeconds * 1000)
}

/**
 * A signed request is valid for +/- tolerance around its timestamp, so a
 * captured request could be replayed inside that window. Remembering each
 * nonce for twice the tolerance closes it. RabbitVis outbox retries carry a
 * fresh nonce every time; only Idempotency-Key deduplicates business events.
 * A multi-instance partner service needs a shared store here instead of a Map.
 */
function rememberNonce(seenNonces, nonce, now, toleranceMs) {
  for (const [seen, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(seen)
  }
  if (seenNonces.has(nonce)) {
    throw new BillingProtocolError(401, 'nonce_replayed', 'billing nonce was already used inside the replay window')
  }
  seenNonces.set(nonce, now + toleranceMs * 2)
}

function cspSource(urlString, fallback) {
  if (!urlString) return fallback
  try {
    return new URL(urlString, fallback).origin
  } catch {
    return fallback
  }
}

async function readSdkModule(sdkDir, requestPath) {
  let modulePath
  try {
    modulePath = decodeURIComponent(requestPath.slice(SDK_ASSET_PREFIX.length))
  } catch {
    throw new BillingProtocolError(404, 'not_found', 'SDK module not found')
  }
  if (
    !modulePath
    || modulePath.includes('\\')
    || modulePath.includes('\0')
    || !['.js', '.mjs'].includes(extname(modulePath))
  ) {
    throw new BillingProtocolError(404, 'not_found', 'SDK module not found')
  }

  const root = await realpath(sdkDir)
  const requested = resolve(root, modulePath)
  const lexicalRelative = relative(root, requested)
  if (!lexicalRelative || lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new BillingProtocolError(404, 'not_found', 'SDK module not found')
  }
  let canonical
  try {
    canonical = await realpath(requested)
  } catch {
    throw new BillingProtocolError(404, 'not_found', 'SDK module not found')
  }
  const canonicalRelative = relative(root, canonical)
  if (!canonicalRelative || canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
    throw new BillingProtocolError(404, 'not_found', 'SDK module not found')
  }
  return readFile(canonical)
}

function loginPage(users) {
  const choices = users
    .map((user) => `<a class="login" href="/login?user=${encodeURIComponent(user.username)}">以 ${escapeHtml(user.displayName)} 登录</a>`)
    .join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RabbitVis Partner Demo 登录</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f7fb;margin:0;display:grid;place-items:center;min-height:100vh}.card{background:#fff;padding:32px;border-radius:16px;box-shadow:0 12px 40px #17255418;width:min(420px,calc(100vw - 48px))}.login{display:block;margin-top:12px;padding:12px 16px;border-radius:10px;background:#172554;color:#fff;text-decoration:none}</style>
</head><body><main class="card"><h1>模拟合作方登录</h1><p>登录态只保存在合作方服务端，浏览器不会得到 externalUserId 或 Partner Key。</p>${choices}</main></body></html>`
}

function appPage({ user, sdkModuleUrl, sessionEndpoint, embedOrigin, nonce }) {
  const browserConfig = {
    sessionEndpoint,
    embedOrigin,
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RabbitVis Partner Embed Demo</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172033;background:#eef2f7}
    *{box-sizing:border-box}body{margin:0;min-height:100vh}.shell{display:grid;grid-template-rows:56px 1fr;min-height:100vh}
    header{display:flex;align-items:center;gap:16px;padding:0 20px;background:#fff;border-bottom:1px solid #dce3ec}
    header strong{margin-right:auto}.status{font-size:13px;color:#526174}.actions{display:flex;gap:8px}
    button,a.button{border:1px solid #cbd5e1;background:#fff;color:#172033;border-radius:8px;padding:8px 12px;text-decoration:none;cursor:pointer}
    main{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;padding:14px;min-height:0}
    #rabbitvis{min-height:720px;background:#fff;border:1px solid #dce3ec;border-radius:12px;overflow:hidden}
    #rabbitvis iframe{display:block;width:100%;height:100%;min-height:720px;border:0}
    aside{background:#fff;border:1px solid #dce3ec;border-radius:12px;padding:14px;overflow:auto}
    pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#526174}
    @media(max-width:880px){main{grid-template-columns:1fr}aside{display:none}}
  </style>
</head>
<body>
<div class="shell">
  <header>
    <strong>合作方工作台</strong>
    <span class="status">当前用户：${escapeHtml(user.displayName)}</span>
    <span class="status" id="partner-balance">合作方余额：${escapeHtml(user.availablePartnerPoints)} 积分 · ${escapeHtml(user.remainingUses)} 次</span>
    <div class="actions"><button id="reload" type="button">重新加载 Embed</button><a class="button" href="/logout">退出</a></div>
  </header>
  <main>
    <section id="rabbitvis" aria-label="RabbitVis Embed"><p style="padding:20px">正在加载 RabbitVis…</p></section>
    <aside><strong>受控业务事件</strong><pre id="events">等待 iframe ready…</pre></aside>
  </main>
</div>
<script nonce="${nonce}" type="module">
import { mountRabbitVisEmbed } from ${jsonForHtml(sdkModuleUrl)};

(() => {
  'use strict';
  const config = ${jsonForHtml(browserConfig)};
  const container = document.getElementById('rabbitvis');
  const eventView = document.getElementById('events');
  const balanceView = document.getElementById('partner-balance');
  let mounted = null;

  async function refreshPartnerBalance() {
    const response = await fetch('/api/partner-balance', {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const value = await response.json();
    if (Number.isInteger(value.availablePartnerPoints) && Number.isInteger(value.remainingUses)) {
      balanceView.textContent = '合作方余额：' + value.availablePartnerPoints + ' 积分 · ' + value.remainingUses + ' 次';
    }
  }

  function showEvent(value) {
    const safe = value && typeof value === 'object' ? value : { type: 'unknown' };
    eventView.textContent = JSON.stringify(safe, null, 2).slice(0, 4000);
    if (safe.type === 'run.settled') void refreshPartnerBalance();
  }

  async function mount() {
    mounted?.destroy?.();
    container.innerHTML = '<p style="padding:20px">正在加载 RabbitVis…</p>';
    try {
      mounted = await mountRabbitVisEmbed({
        container,
        rabbitVisOrigin: config.embedOrigin,
        sessionEndpoint: config.sessionEndpoint,
        onEvent: showEvent,
      });
    } catch (error) {
      container.textContent = error instanceof Error ? error.message : 'Embed 加载失败';
    }
  }

  document.getElementById('reload').addEventListener('click', mount);
  window.addEventListener('beforeunload', () => mounted?.destroy?.(), { once: true });
  void mount();
})();
</script>
</body>
</html>`
}

function publicSnapshot(state) {
  return {
    activeBrowserSessions: state.browserSessions.size,
    billing: state.billingStore.snapshot(),
    faults: Object.fromEntries(
      [...state.faults.entries()].map(([action, fault]) => [action, { ...fault }]),
    ),
    events: state.events.slice(-200),
  }
}

function consumeFault(state, action) {
  const fault = state.faults.get(action)
  if (!fault || fault.mode === 'none' || fault.remaining < 1) return null
  fault.remaining -= 1
  if (fault.remaining === 0) state.faults.delete(action)
  return { ...fault }
}

function setFault(state, input) {
  const action = String(input?.action ?? '')
  const mode = String(input?.mode ?? '')
  if (!FAULT_ACTIONS.has(action)) {
    throw new BillingProtocolError(400, 'invalid_fault_action', 'action must be authorize or finalize')
  }
  if (!FAULT_MODES.has(mode)) {
    throw new BillingProtocolError(
      400,
      'invalid_fault_mode',
      'mode must be none, deny, 500, timeout, or commit_then_drop',
    )
  }
  if (mode === 'none') {
    state.faults.delete(action)
    return
  }
  const remaining = integer(input.times, 1, { minimum: 1, maximum: 100 })
  const delayMs = integer(input.delayMs, 250, { minimum: 1, maximum: 30_000 })
  state.faults.set(action, { mode, remaining, delayMs })
}

function requireControl(req, config) {
  if (!config.controlToken) {
    throw new BillingProtocolError(404, 'not_found', 'demo control API is disabled')
  }
  if (req.headers.authorization !== `Bearer ${config.controlToken}`) {
    throw new BillingProtocolError(401, 'control_unauthorized', 'invalid demo control token')
  }
}

async function applyPreCommitFault(res, fault) {
  if (!fault) return false
  if (fault.mode === '500') {
    sendJson(res, 500, { error: { code: 'fault_injected', message: 'injected partner failure' } })
    return true
  }
  if (fault.mode === 'timeout') {
    await new Promise((resolve) => setTimeout(resolve, fault.delayMs))
    sendJson(res, 504, { error: { code: 'fault_timeout', message: 'injected partner timeout' } })
    return true
  }
  return false
}

function recordEvent(state, type, details = {}) {
  state.events.push({
    sequence: state.events.length + 1,
    type,
    at: new Date().toISOString(),
    ...details,
  })
  if (state.events.length > 1_000) state.events.splice(0, state.events.length - 1_000)
}

/**
 * Creates an in-memory partner system. No production secrets or test controls
 * are ever serialized into HTML or the observable state endpoint.
 */
export function createPartnerDemo(options) {
  const config = options.config
  if (!config) throw new Error('config is required')
  if (Boolean(config.sdkDir) === Boolean(config.sdkUrl)) {
    throw new Error('Exactly one Embed SDK source (sdkDir or sdkUrl) is required')
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const nowMs = options.nowMs ?? Date.now
  const seenNonces = new Map()
  const billingStore = options.billingStore ?? createBillingStore({
    initialPartnerPoints: config.initialPartnerPoints,
    initialUses: config.initialUses,
    pointsPerOperation: config.pointsPerOperation,
    chargeFailedOperations: config.chargeFailedOperations,
    now: () => new Date(nowMs()),
  })
  const state = {
    billingStore,
    browserSessions: new Map(),
    faults: new Map(),
    events: [],
    publicOrigin: config.publicOrigin,
  }
  const sockets = new Set()

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    const username = token ? state.browserSessions.get(token) : null
    return username ? billingStore.userByUsername(username) : null
  }

  function expectedOrigin() {
    return state.publicOrigin
  }

  function validateBrowserPost(req) {
    const origin = String(req.headers.origin ?? '')
    if (!origin || origin !== expectedOrigin()) {
      throw new BillingProtocolError(403, 'origin_not_allowed', 'request Origin is not the partner demo origin')
    }
    const mediaType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      throw new BillingProtocolError(415, 'unsupported_media_type', 'Content-Type must be application/json')
    }
  }

  async function handleEmbedSession(req, res) {
    validateBrowserPost(req)
    const user = currentUser(req)
    if (!user) {
      sendJson(res, 401, { error: { code: 'partner_login_required', message: '请先登录合作方平台' } })
      return
    }
    // Read and discard the browser body deliberately. Identity and billing
    // subject are selected only from the trusted server-side session.
    await readRawBody(req)
    const requestId = `demo_embed_${randomUUID().replaceAll('-', '')}`
    const externalProjectId = `${config.externalProjectPrefix}_${user.username}`
    const payload = {
      tenantId: config.tenantId,
      externalUserId: user.externalUserId,
      externalProjectId,
      billingSubjectRef: user.billingSubjectRef,
      origin: expectedOrigin(),
      scopes: config.scopes,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
    let upstream
    try {
      upstream = await fetchImpl(`${config.apiBaseUrl}/v1/partner/embed-sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.partnerApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': requestId,
          'X-RabbitVis-Partner-Id': config.partnerId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError'
      sendJson(res, 502, {
        error: {
          code: timedOut ? 'rabbitvis_timeout' : 'rabbitvis_unavailable',
          message: timedOut ? 'RabbitVis 创建会话超时' : 'RabbitVis 服务暂时不可用',
        },
      })
      return
    } finally {
      clearTimeout(timer)
    }
    const raw = await upstream.text()
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = { error: { code: 'invalid_upstream_response', message: 'RabbitVis 返回了无效响应' } }
    }
    recordEvent(state, 'embed_session_requested', {
      requestId,
      username: user.username,
      billingSubjectRef: user.billingSubjectRef,
      upstreamStatus: upstream.status,
    })
    sendJson(res, upstream.status, body)
  }

  async function handleBilling(req, res, action) {
    const raw = await readRawBody(req)
    verifyBillingSignature(req, raw, config, nowMs, seenNonces)
    const input = parseJson(raw)
    const fault = consumeFault(state, action)
    if (await applyPreCommitFault(res, fault)) {
      recordEvent(state, 'fault_injected', { action, mode: fault.mode })
      return
    }

    let response
    if (action === 'authorize') {
      response = billingStore.authorize(input, { forceDeny: fault?.mode === 'deny' })
    } else {
      response = billingStore.finalize(input)
    }
    recordEvent(state, `billing_${action}`, {
      operationId: typeof input.operationId === 'string' ? input.operationId : undefined,
      eventId: typeof input.eventId === 'string' ? input.eventId : undefined,
      decision: response.decision,
      accepted: response.accepted,
      fault: fault?.mode,
    })
    if (fault?.mode === 'commit_then_drop') {
      req.socket.destroy()
      return
    }
    sendJson(res, 200, response)
  }

  async function dispatch(req, res) {
    const requestUrl = new URL(req.url ?? '/', state.publicOrigin || 'http://127.0.0.1')
    const path = requestUrl.pathname
    try {
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true, service: 'partner-embed-demo' })
        return
      }

      if (req.method === 'GET' && path === '/login') {
        const username = requestUrl.searchParams.get('user') ?? ''
        const user = billingStore.userByUsername(username)
        if (!user) {
          sendJson(res, 400, { error: { code: 'unknown_demo_user', message: 'unknown demo user' } })
          return
        }
        const token = randomBytes(32).toString('base64url')
        state.browserSessions.set(token, username)
        res.writeHead(302, {
          Location: '/',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${config.secureCookie ? '; Secure' : ''}`,
        })
        res.end()
        return
      }

      if (req.method === 'GET' && path === '/logout') {
        const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
        if (token) state.browserSessions.delete(token)
        res.writeHead(302, {
          Location: '/',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookie ? '; Secure' : ''}`,
        })
        res.end()
        return
      }

      if (req.method === 'GET' && path.startsWith(SDK_ASSET_PREFIX)) {
        if (!config.sdkDir) {
          res.writeHead(404).end()
          return
        }
        const bytes = await readSdkModule(config.sdkDir, path)
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(bytes)
        return
      }

      if (req.method === 'GET' && path === '/') {
        const user = currentUser(req)
        const html = user
          ? appPage({
              user,
              sdkModuleUrl: config.sdkDir
                ? `${SDK_ASSET_PREFIX}index.js`
                : config.sdkUrl,
              sessionEndpoint: '/api/rabbitvis/embed-session',
              embedOrigin: config.embedOrigin,
              nonce: randomBytes(18).toString('base64'),
            })
          : loginPage(billingStore.snapshot().users)
        const nonceMatch = html.match(/<script nonce="([^"]+)"/)
        const nonce = nonceMatch?.[1] ?? ''
        const sdkModuleUrl = config.sdkDir ? `${SDK_ASSET_PREFIX}index.js` : config.sdkUrl
        const sdkSource = cspSource(sdkModuleUrl, expectedOrigin())
        const scriptSources = [`'self'`, ...(nonce ? [`'nonce-${nonce}'`] : []), ...(sdkSource !== expectedOrigin() ? [sdkSource] : [])]
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': [
            `default-src 'self'`,
            `script-src ${scriptSources.join(' ')}`,
            `style-src 'self' 'unsafe-inline'`,
            `connect-src 'self'`,
            `frame-src ${config.embedOrigin}`,
            `img-src 'self' data:`,
            `base-uri 'none'`,
            `form-action 'self'`,
          ].join('; '),
        })
        res.end(html)
        return
      }

      if (req.method === 'POST' && path === '/api/rabbitvis/embed-session') {
        await handleEmbedSession(req, res)
        return
      }

      if (req.method === 'GET' && path === '/api/partner-balance') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: { code: 'partner_login_required', message: '请先登录合作方平台' } })
          return
        }
        sendJson(res, 200, {
          availablePartnerPoints: user.availablePartnerPoints,
          remainingUses: user.remainingUses,
        })
        return
      }
      if (req.method === 'POST' && path === '/rabbitvis/billing/authorize') {
        await handleBilling(req, res, 'authorize')
        return
      }
      if (req.method === 'POST' && path === '/rabbitvis/billing/finalize') {
        await handleBilling(req, res, 'finalize')
        return
      }

      if (path === '/__demo/state' && req.method === 'GET') {
        requireControl(req, config)
        sendJson(res, 200, publicSnapshot(state))
        return
      }
      if (path === '/__demo/faults' && req.method === 'POST') {
        requireControl(req, config)
        setFault(state, parseJson(await readRawBody(req)))
        sendJson(res, 200, { ok: true, faults: publicSnapshot(state).faults })
        return
      }
      if (path === '/__demo/reset' && req.method === 'POST') {
        requireControl(req, config)
        billingStore.reset()
        state.faults.clear()
        state.events.length = 0
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
    } catch (error) {
      sendProtocolError(res, error)
    }
  }

  const server = http.createServer((req, res) => void dispatch(req, res))
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  async function start(port = config.port, host = config.host) {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('partner demo did not bind a TCP address')
    if (!state.publicOrigin) {
      const urlHost = address.address.includes(':') ? `[${address.address}]` : address.address
      state.publicOrigin = `http://${urlHost}:${address.port}`
    }
    return state.publicOrigin
  }

  async function close() {
    for (const socket of sockets) socket.destroy()
    if (!server.listening) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  return {
    server,
    start,
    close,
    control: {
      setFault: (input) => setFault(state, input),
      reset: () => {
        billingStore.reset()
        state.faults.clear()
        state.events.length = 0
      },
      snapshot: () => publicSnapshot(state),
    },
  }
}
