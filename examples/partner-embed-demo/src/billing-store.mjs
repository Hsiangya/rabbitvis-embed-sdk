import { createHash, randomUUID } from 'node:crypto'

export class BillingProtocolError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'BillingProtocolError'
    this.status = status
    this.code = code
  }
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BillingProtocolError(400, 'invalid_request', `${field} must be a non-empty string`)
  }
  return value.trim()
}

function safeCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return value
}

function safeNumber(value, field) {
  if (!Number.isFinite(value) || value < 0) {
    throw new BillingProtocolError(
      400,
      'invalid_request',
      `${field} must be a non-negative finite number`,
    )
  }
  return value
}

function clone(value) {
  return structuredClone(value)
}

/**
 * A deliberately small partner-owned billing system.
 *
 * RabbitVis usage units are recorded as audit facts only. This demo's partner
 * policy charges a fixed number of partner points and one partner use per
 * authorized operation; no RabbitVis pricing decision leaks into the policy.
 */
export function createBillingStore(options = {}) {
  const initialPartnerPoints = safeCount(options.initialPartnerPoints ?? 100, 'initialPartnerPoints')
  const initialUses = safeCount(options.initialUses ?? 10, 'initialUses')
  const pointsPerOperation = safeCount(options.pointsPerOperation ?? 5, 'pointsPerOperation')
  const chargeFailedOperations = options.chargeFailedOperations === true
  const now = options.now ?? (() => new Date())
  const users = new Map()
  const reservations = new Map()
  const finalizations = new Map()

  const configuredUsers = options.users ?? [
    {
      username: 'alice',
      displayName: 'Alice（演示用户）',
      externalUserId: 'demo_user_alice',
      billingSubjectRef: 'demo_billing_alice',
    },
    {
      username: 'bob',
      displayName: 'Bob（演示用户）',
      externalUserId: 'demo_user_bob',
      billingSubjectRef: 'demo_billing_bob',
    },
  ]

  for (const configured of configuredUsers) {
    const username = requiredString(configured.username, 'username')
    const billingSubjectRef = requiredString(configured.billingSubjectRef, 'billingSubjectRef')
    if (users.has(billingSubjectRef)) throw new Error(`duplicate billingSubjectRef: ${billingSubjectRef}`)
    users.set(billingSubjectRef, {
      username,
      displayName: requiredString(configured.displayName, 'displayName'),
      externalUserId: requiredString(configured.externalUserId, 'externalUserId'),
      billingSubjectRef,
      availablePartnerPoints: safeCount(
        configured.initialPartnerPoints ?? initialPartnerPoints,
        'user.initialPartnerPoints',
      ),
      remainingUses: safeCount(configured.initialUses ?? initialUses, 'user.initialUses'),
      reservedPartnerPoints: 0,
      reservedUses: 0,
      version: 1,
    })
  }

  function asOf() {
    const value = now()
    return (value instanceof Date ? value : new Date(value)).toISOString()
  }

  function userForSubject(raw) {
    const billingSubjectRef = requiredString(raw, 'billingSubjectRef')
    const user = users.get(billingSubjectRef)
    if (!user) {
      throw new BillingProtocolError(404, 'billing_subject_not_found', 'billing subject not found')
    }
    return user
  }

  function authorize(input, options = {}) {
    if (input?.schemaVersion !== '1') {
      throw new BillingProtocolError(400, 'unsupported_schema', 'schemaVersion must be "1"')
    }
    const operationId = requiredString(input.operationId, 'operationId')
    const operation = requiredString(input.operation, 'operation')
    const user = userForSubject(input.billingSubjectRef)
    const requestHash = canonicalHash({
      operationId,
      operation,
      billingSubjectRef: user.billingSubjectRef,
    })
    const existing = reservations.get(operationId)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new BillingProtocolError(
          409,
          'operation_idempotency_conflict',
          'operationId was already used with different authorization input',
        )
      }
      return clone(existing.authorizeResponse)
    }

    const forceDeny = options.forceDeny === true
    const enoughPoints = user.availablePartnerPoints >= pointsPerOperation
    const enoughUses = user.remainingUses >= 1
    if (forceDeny || !enoughPoints || !enoughUses) {
      const reason = forceDeny
        ? 'fault_injected'
        : !enoughPoints
          ? 'insufficient_balance'
          : 'usage_limit_reached'
      const response = {
        schemaVersion: '1',
        decision: 'deny',
        reason,
      }
      reservations.set(operationId, {
        operationId,
        operation,
        billingSubjectRef: user.billingSubjectRef,
        requestHash,
        authorizationId: null,
        status: 'denied',
        reservedPartnerPoints: 0,
        reservedUses: 0,
        authorizeResponse: clone(response),
        authorizedAt: asOf(),
        finalizedEventId: null,
      })
      return response
    }

    const authorizationId = `authz_demo_${randomUUID().replaceAll('-', '')}`
    user.availablePartnerPoints -= pointsPerOperation
    user.remainingUses -= 1
    user.reservedPartnerPoints += pointsPerOperation
    user.reservedUses += 1
    user.version += 1
    const response = {
      schemaVersion: '1',
      decision: 'allow',
      authorizationId,
    }
    reservations.set(operationId, {
      operationId,
      operation,
      billingSubjectRef: user.billingSubjectRef,
      requestHash,
      authorizationId,
      status: 'reserved',
      reservedPartnerPoints: pointsPerOperation,
      reservedUses: 1,
      authorizeResponse: clone(response),
      authorizedAt: asOf(),
      finalizedEventId: null,
      outcome: null,
      actualUsage: null,
    })
    return response
  }

  function finalize(input) {
    if (input?.schemaVersion !== '1') {
      throw new BillingProtocolError(400, 'unsupported_schema', 'schemaVersion must be "1"')
    }
    const eventId = requiredString(input.eventId, 'eventId')
    const operationId = requiredString(input.operationId, 'operationId')
    const kind = requiredString(input.kind, 'kind')
    if (!['FINALIZE', 'RELEASE'].includes(kind)) {
      throw new BillingProtocolError(400, 'invalid_kind', 'kind must be FINALIZE or RELEASE')
    }
    const authorizationId = input.authorizationId === null
      ? null
      : requiredString(input.authorizationId, 'authorizationId')
    const outcome = requiredString(input.outcome, 'outcome')
    if (!['succeeded', 'failed', 'cancelled', 'no_delivery'].includes(outcome)) {
      throw new BillingProtocolError(
        400,
        'invalid_outcome',
        'outcome must be succeeded, failed, cancelled, or no_delivery',
      )
    }
    const rabbitvisUsageUnits = safeNumber(
      input.actualUsage?.rabbitvisUsageUnits,
      'actualUsage.rabbitvisUsageUnits',
    )
    const requestHash = canonicalHash({
      eventId,
      operationId,
      kind,
      authorizationId,
      outcome,
      rabbitvisUsageUnits,
    })
    const priorEvent = finalizations.get(eventId)
    if (priorEvent) {
      if (priorEvent.requestHash !== requestHash) {
        throw new BillingProtocolError(
          409,
          'event_idempotency_conflict',
          'eventId was already used with different finalization input',
        )
      }
      return clone(priorEvent.response)
    }

    const reservation = reservations.get(operationId)
    if (!reservation || reservation.status === 'denied') {
      throw new BillingProtocolError(404, 'authorization_not_found', 'authorization not found')
    }
    if (kind === 'FINALIZE' && reservation.authorizationId !== authorizationId) {
      throw new BillingProtocolError(409, 'authorization_mismatch', 'authorization does not match operation')
    }
    if (kind === 'RELEASE' && rabbitvisUsageUnits !== 0) {
      throw new BillingProtocolError(400, 'release_requires_zero_usage', 'RELEASE requires zero usage')
    }
    if (reservation.finalizedEventId) {
      throw new BillingProtocolError(
        409,
        'operation_already_finalized',
        'operation was already finalized with another eventId',
      )
    }
    const user = userForSubject(reservation.billingSubjectRef)
    const charged = kind === 'FINALIZE'
      && (outcome === 'succeeded' || (outcome !== 'no_delivery' && chargeFailedOperations))
    user.reservedPartnerPoints -= reservation.reservedPartnerPoints
    user.reservedUses -= reservation.reservedUses
    if (!charged) {
      user.availablePartnerPoints += reservation.reservedPartnerPoints
      user.remainingUses += reservation.reservedUses
    }
    user.version += 1
    reservation.status = charged ? 'settled' : 'released'
    reservation.finalizedEventId = eventId
    reservation.outcome = outcome
    reservation.actualUsage = { rabbitvisUsageUnits }
    reservation.finalizedAt = asOf()

    const response = {
      schemaVersion: '1',
      accepted: true,
      eventId,
    }
    finalizations.set(eventId, {
      eventId,
      operationId,
      authorizationId,
      requestHash,
      response: clone(response),
      receivedAt: asOf(),
    })
    return response
  }

  function userByUsername(username) {
    for (const user of users.values()) {
      if (user.username === username) return clone(user)
    }
    return null
  }

  function reset() {
    reservations.clear()
    finalizations.clear()
    for (const user of users.values()) {
      user.availablePartnerPoints = initialPartnerPoints
      user.remainingUses = initialUses
      user.reservedPartnerPoints = 0
      user.reservedUses = 0
      user.version += 1
    }
  }

  function snapshot() {
    return {
      policy: {
        pointsPerOperation,
        chargeFailedOperations,
        note: 'rabbitvisUsageUnits are audit facts and do not determine partner points',
      },
      users: [...users.values()].map((user) => ({
        username: user.username,
        displayName: user.displayName,
        externalUserId: user.externalUserId,
        billingSubjectRef: user.billingSubjectRef,
        availablePartnerPoints: user.availablePartnerPoints,
        remainingUses: user.remainingUses,
        reservedPartnerPoints: user.reservedPartnerPoints,
        reservedUses: user.reservedUses,
        version: user.version,
      })),
      reservations: [...reservations.values()].map((value) => clone(value)),
      finalizations: [...finalizations.values()].map((value) => clone(value)),
    }
  }

  return {
    authorize,
    finalize,
    reset,
    snapshot,
    userByUsername,
  }
}
