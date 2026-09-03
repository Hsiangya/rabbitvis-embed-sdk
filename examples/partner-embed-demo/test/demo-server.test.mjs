import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  billingSignatureHeaders,
  createPartnerDemo,
} from '../src/demo-server.mjs'

const SDK_DIST_DIR = fileURLToPath(
  new URL('../../../sdk/dist/', import.meta.url),
)

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(() => resolve()))
}

async function rawBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function createRabbitStub() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const raw = await rawBody(req)
    requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: JSON.parse(raw || '{}'),
    })
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      embedSessionId: 'emb_demo_1',
      embedUrl: 'http://127.0.0.1:5174/embed/#code=boot_demo_1',
      expiresIn: 60,
    }))
  })
  return { server, baseUrl: await listen(server), requests }
}

function config(apiBaseUrl, overrides = {}) {
  return {
    port: 0,
    host: '127.0.0.1',
    apiBaseUrl,
    partnerApiKey: 'test-partner-key-never-in-browser',
    partnerId: 'partner_demo',
    tenantId: 'tenant_demo',
    externalProjectPrefix: 'demo_project',
    scopes: ['session:read', 'run:create'],
    publicOrigin: '',
    embedOrigin: 'http://127.0.0.1:5174',
    sdkUrl: '',
    sdkDir: SDK_DIST_DIR,
    billingSigningSecret: 'test-billing-signing-secret',
    signatureToleranceSeconds: 300,
    requestTimeoutMs: 500,
    initialPartnerPoints: 100,
    initialUses: 10,
    pointsPerOperation: 5,
    chargeFailedOperations: false,
    controlToken: 'test-control-token',
    secureCookie: false,
    ...overrides,
  }
}

async function startDemo(overrides = {}) {
  const rabbit = await createRabbitStub()
  const demoConfig = config(rabbit.baseUrl, overrides)
  const demo = createPartnerDemo({ config: demoConfig })
  const baseUrl = await demo.start()
  return {
    rabbit,
    demo,
    config: demoConfig,
    baseUrl,
    async close() {
      await demo.close()
      await close(rabbit.server)
    },
  }
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie')
  assert(setCookie, 'login response must set a cookie')
  return setCookie.split(';')[0]
}

async function signedPost(baseUrl, path, secret, payload, options = {}) {
  const body = JSON.stringify(payload)
  const idempotencyKey = options.idempotencyKey
    ?? payload.eventId
    ?? payload.operationId
    ?? payload.requestId
    ?? 'test_billing_request'
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: billingSignatureHeaders(secret, body, {
      target: path,
      idempotencyKey,
      partnerId: options.partnerId ?? 'partner_demo',
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.nonce ? { nonce: options.nonce } : {}),
    }),
    body,
  })
}

function authorization(operationId = 'op_demo_1', operation = 'run') {
  return {
    schemaVersion: '1',
    operationId,
    partnerId: 'partner_demo',
    tenantId: 'tenant_demo',
    sessionId: 'sess_demo_1',
    turnId: 'turn_demo_1',
    operation,
    billingSubjectRef: 'demo_billing_alice',
    estimate: { operation: 'run', rabbitvisUsageUnits: null },
  }
}

function finalization({ eventId, operationId = 'op_demo_1', authorizationId, outcome, units }) {
  return {
    schemaVersion: '1',
    eventId,
    operationId,
    partnerId: 'partner_demo',
    tenantId: 'tenant_demo',
    billingSubjectRef: 'demo_billing_alice',
    sessionId: 'sess_demo_1',
    turnId: 'turn_demo_1',
    kind: units === 0 ? 'RELEASE' : 'FINALIZE',
    authorizationId,
    outcome,
    actualUsage: { rabbitvisUsageUnits: units },
    occurredAt: new Date().toISOString(),
  }
}

test('embed-session identity comes only from the trusted partner cookie', async () => {
  const harness = await startDemo()
  try {
    const login = await fetch(`${harness.baseUrl}/login?user=alice`, { redirect: 'manual' })
    assert.equal(login.status, 302)
    const cookie = cookieFrom(login)

    const response = await fetch(`${harness.baseUrl}/api/rabbitvis/embed-session`, {
      method: 'POST',
      headers: {
        Origin: harness.baseUrl,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        externalUserId: 'attacker_selected_user',
        billingSubjectRef: 'attacker_selected_billing_subject',
      }),
    })
    assert.equal(response.status, 201)
    assert.equal(harness.rabbit.requests.length, 1)
    const upstream = harness.rabbit.requests[0]
    assert.equal(upstream.url, '/v1/partner/embed-sessions')
    assert.equal(upstream.headers.authorization, `Bearer ${harness.config.partnerApiKey}`)
    assert.equal(upstream.body.externalUserId, 'demo_user_alice')
    assert.equal(upstream.body.billingSubjectRef, 'demo_billing_alice')
    assert.equal(upstream.body.origin, harness.baseUrl)
    assert.notEqual(upstream.body.externalUserId, 'attacker_selected_user')

    const page = await fetch(harness.baseUrl, { headers: { Cookie: cookie } }).then((value) => value.text())
    assert.equal(page.includes(harness.config.partnerApiKey), false)
    assert.equal(page.includes(harness.config.billingSigningSecret), false)
    assert.equal(page.includes('demo_user_alice'), false)
  } finally {
    await harness.close()
  }
})

test('embed-session requires a logged-in user and the exact partner Origin', async () => {
  const harness = await startDemo()
  try {
    const anonymous = await fetch(`${harness.baseUrl}/api/rabbitvis/embed-session`, {
      method: 'POST',
      headers: { Origin: harness.baseUrl, 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(anonymous.status, 401)

    const login = await fetch(`${harness.baseUrl}/login?user=alice`, { redirect: 'manual' })
    const wrongOrigin = await fetch(`${harness.baseUrl}/api/rabbitvis/embed-session`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        Cookie: cookieFrom(login),
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(wrongOrigin.status, 403)
    assert.equal(harness.rabbit.requests.length, 0)
  } finally {
    await harness.close()
  }
})

test('partner page imports the real ESM SDK contract and serves its relative module graph', async () => {
  const harness = await startDemo()
  try {
    const login = await fetch(`${harness.baseUrl}/login?user=alice`, { redirect: 'manual' })
    const cookie = cookieFrom(login)
    const pageResponse = await fetch(harness.baseUrl, { headers: { Cookie: cookie } })
    assert.equal(pageResponse.status, 200)
    const page = await pageResponse.text()

    assert.match(page, /<script nonce="[^"]+" type="module">/)
    assert.ok(page.includes(
      'import { mountRabbitVisEmbed } from "/assets/rabbitvis-embed-sdk/index.js";',
    ))
    assert.match(page, /mountRabbitVisEmbed\(\{\s*container,\s*rabbitVisOrigin: config\.embedOrigin,\s*sessionEndpoint: config\.sessionEndpoint,/)
    assert.equal(page.includes('window.RabbitVisEmbed'), false)
    assert.equal(page.includes('fallbackMount'), false)
    assert.equal(page.includes('getEmbedSession'), false)
    assert.match(page, /id="partner-balance">合作方余额：100 积分 · 10 次/)
    assert.equal(page.includes('billing.changed'), false)

    const balanceResponse = await fetch(`${harness.baseUrl}/api/partner-balance`, {
      headers: { Cookie: cookie },
    })
    assert.equal(balanceResponse.status, 200)
    assert.deepEqual(await balanceResponse.json(), {
      availablePartnerPoints: 100,
      remainingUses: 10,
    })

    for (const moduleName of ['index.js', 'protocol.js', 'session-provider.js']) {
      const response = await fetch(`${harness.baseUrl}/assets/rabbitvis-embed-sdk/${moduleName}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/)
      assert.ok((await response.text()).length > 0)
    }
    const escaped = await fetch(
      `${harness.baseUrl}/assets/rabbitvis-embed-sdk/%2e%2e%2fserver.mjs`,
    )
    assert.equal(escaped.status, 404)
  } finally {
    await harness.close()
  }
})

test('authorize reserves partner points once and rejects conflicting reuse', async () => {
  const harness = await startDemo()
  try {
    const payload = authorization()
    const first = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      payload,
    )
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.decision, 'allow')
    assert.match(firstBody.authorizationId, /^authz_demo_/)
    assert.equal(firstBody.schemaVersion, '1')
    assert.deepEqual(Object.keys(firstBody).sort(), ['authorizationId', 'decision', 'schemaVersion'])

    const replay = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      payload,
    )
    assert.deepEqual(await replay.json(), firstBody)
    assert.equal(harness.demo.control.snapshot().billing.users[0].availablePartnerPoints, 95)

    const conflict = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorization('op_demo_1', 'artifact.export'),
    )
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error.code, 'operation_idempotency_conflict')
  } finally {
    await harness.close()
  }
})

test('finalize records RabbitVis usage units as facts and is event-idempotent', async () => {
  const harness = await startDemo()
  try {
    const authorizeResponse = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorization(),
    )
    const { authorizationId } = await authorizeResponse.json()
    const payload = finalization({
      eventId: 'evt_demo_1',
      authorizationId,
      outcome: 'succeeded',
      units: 18,
    })
    const first = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/finalize',
      harness.config.billingSigningSecret,
      payload,
    )
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.deepEqual(firstBody, {
      schemaVersion: '1',
      accepted: true,
      eventId: 'evt_demo_1',
    })

    const replay = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/finalize',
      harness.config.billingSigningSecret,
      payload,
    )
    assert.deepEqual(await replay.json(), firstBody)
    const snapshot = harness.demo.control.snapshot().billing
    assert.equal(snapshot.finalizations.length, 1)
    assert.equal(snapshot.reservations[0].actualUsage.rabbitvisUsageUnits, 18)
    assert.equal(snapshot.users[0].availablePartnerPoints, 95)
    assert.equal(snapshot.users[0].reservedPartnerPoints, 0)

    const conflict = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/finalize',
      harness.config.billingSigningSecret,
      { ...payload, actualUsage: { rabbitvisUsageUnits: 19 } },
    )
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error.code, 'event_idempotency_conflict')
  } finally {
    await harness.close()
  }
})

test('failed operation releases the partner reservation under the demo policy', async () => {
  const harness = await startDemo()
  try {
    const authorizeResponse = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorization(),
    )
    const { authorizationId } = await authorizeResponse.json()
    const response = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/finalize',
      harness.config.billingSigningSecret,
      finalization({
        eventId: 'evt_failed_1',
        authorizationId,
        outcome: 'failed',
        units: 3.5,
      }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.accepted, true)
    assert.equal(body.eventId, 'evt_failed_1')
    assert.equal('billingView' in body, false)
    assert.equal(harness.demo.control.snapshot().billing.users[0].availablePartnerPoints, 100)
    assert.equal(harness.demo.control.snapshot().billing.reservations[0].status, 'released')
  } finally {
    await harness.close()
  }
})

test('commit-then-drop retries do not duplicate reservation or settlement', async () => {
  const harness = await startDemo()
  try {
    const authorizePayload = authorization()
    harness.demo.control.setFault({ action: 'authorize', mode: 'commit_then_drop', times: 1 })
    await assert.rejects(
      signedPost(
        harness.baseUrl,
        '/rabbitvis/billing/authorize',
        harness.config.billingSigningSecret,
        authorizePayload,
      ),
    )
    const recoveredAuthorize = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorizePayload,
    )
    const authorizeBody = await recoveredAuthorize.json()
    assert.equal(authorizeBody.decision, 'allow')
    assert.equal(harness.demo.control.snapshot().billing.users[0].availablePartnerPoints, 95)

    const finalizePayload = finalization({
      eventId: 'evt_drop_1',
      authorizationId: authorizeBody.authorizationId,
      outcome: 'succeeded',
      units: 8,
    })
    harness.demo.control.setFault({ action: 'finalize', mode: 'commit_then_drop', times: 1 })
    await assert.rejects(
      signedPost(
        harness.baseUrl,
        '/rabbitvis/billing/finalize',
        harness.config.billingSigningSecret,
        finalizePayload,
      ),
    )
    const recoveredFinalize = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/finalize',
      harness.config.billingSigningSecret,
      finalizePayload,
    )
    const recoveredFinalizeBody = await recoveredFinalize.json()
    assert.equal(recoveredFinalizeBody.accepted, true)
    assert.equal(recoveredFinalizeBody.eventId, 'evt_drop_1')
    const snapshot = harness.demo.control.snapshot().billing
    assert.equal(snapshot.reservations.length, 1)
    assert.equal(snapshot.finalizations.length, 1)
    assert.equal(snapshot.users[0].availablePartnerPoints, 95)
    assert.equal(snapshot.users[0].reservedPartnerPoints, 0)
  } finally {
    await harness.close()
  }
})

test('deny, 500, and timeout faults do not create a billable reservation', async () => {
  const harness = await startDemo()
  try {
    harness.demo.control.setFault({ action: 'authorize', mode: 'deny', times: 1 })
    const denied = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorization('op_deny'),
    )
    assert.equal((await denied.json()).decision, 'deny')

    harness.demo.control.setFault({ action: 'authorize', mode: '500', times: 1 })
    const failed = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorization('op_500'),
    )
    assert.equal(failed.status, 500)

    harness.demo.control.setFault({ action: 'authorize', mode: 'timeout', times: 1, delayMs: 10 })
    const timedOut = await signedPost(
      harness.baseUrl,
      '/rabbitvis/billing/authorize',
      harness.config.billingSigningSecret,
      authorization('op_timeout'),
    )
    assert.equal(timedOut.status, 504)

    const snapshot = harness.demo.control.snapshot().billing
    assert.equal(snapshot.users[0].availablePartnerPoints, 100)
    assert.equal(snapshot.reservations.filter((value) => value.status === 'reserved').length, 0)
  } finally {
    await harness.close()
  }
})

test('billing endpoints reject missing, invalid, and stale signatures', async () => {
  const harness = await startDemo()
  try {
    const payload = JSON.stringify(authorization('op_signature_test'))
    const missing = await fetch(`${harness.baseUrl}/rabbitvis/billing/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    assert.equal(missing.status, 401)

    const invalid = await fetch(`${harness.baseUrl}/rabbitvis/billing/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...billingSignatureHeaders(harness.config.billingSigningSecret, payload, {
          target: '/rabbitvis/billing/authorize',
          idempotencyKey: 'op_signature_test',
          partnerId: 'partner_demo',
        }),
        'X-RabbitVis-Signature': `v1=${'A'.repeat(43)}`,
      },
      body: payload,
    })
    assert.equal(invalid.status, 401)

    const staleTimestamp = new Date(Date.now() - 1_000_000).toISOString()
    const stale = await fetch(`${harness.baseUrl}/rabbitvis/billing/authorize`, {
      method: 'POST',
      headers: billingSignatureHeaders(harness.config.billingSigningSecret, payload, {
        target: '/rabbitvis/billing/authorize',
        idempotencyKey: 'op_signature_test',
        partnerId: 'partner_demo',
        timestamp: staleTimestamp,
      }),
      body: payload,
    })
    assert.equal(stale.status, 401)
    assert.equal((await stale.json()).error.code, 'signature_expired')
  } finally {
    await harness.close()
  }
})

test('billing endpoints reject a replayed nonce inside the tolerance window', async () => {
  const harness = await startDemo()
  try {
    const secret = harness.config.billingSigningSecret
    const payload = authorization('op_nonce_replay')
    const first = await signedPost(harness.baseUrl, '/rabbitvis/billing/authorize', secret, payload, {
      nonce: 'nonce_replay_1',
    })
    assert.equal(first.status, 200)

    const replayed = await signedPost(harness.baseUrl, '/rabbitvis/billing/authorize', secret, payload, {
      nonce: 'nonce_replay_1',
    })
    assert.equal(replayed.status, 401)
    assert.equal((await replayed.json()).error.code, 'nonce_replayed')

    // An outbox retry of the same business event always carries a new nonce.
    const retried = await signedPost(harness.baseUrl, '/rabbitvis/billing/authorize', secret, payload, {
      nonce: 'nonce_replay_2',
    })
    assert.equal(retried.status, 200)
  } finally {
    await harness.close()
  }
})
