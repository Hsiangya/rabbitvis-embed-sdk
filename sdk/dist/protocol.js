export const EMBED_PROTOCOL_VERSION = 1;
export const EMBED_EVENT_SOURCE = 'rabbitvis-embed';
export const EMBED_HOST_SOURCE = 'rabbitvis-embed-host';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function emptyPayload(value) {
    return isRecord(value) && Object.keys(value).length === 0;
}
const TURN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REJECTION_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const RUN_OUTCOMES = ['succeeded', 'failed', 'cancelled', 'rejected'];
function turnId(value) {
    return typeof value === 'string' && TURN_ID.test(value) ? value : null;
}
function runOutcome(value) {
    return typeof value === 'string' && RUN_OUTCOMES.includes(value)
        ? value
        : null;
}
export function parseEmbedEvent(value, instanceId) {
    if (!isRecord(value)
        || value.source !== EMBED_EVENT_SOURCE
        || value.version !== EMBED_PROTOCOL_VERSION
        || value.instanceId !== instanceId
        || typeof value.type !== 'string'
        || !isRecord(value.payload))
        return null;
    if (value.type === 'ready' && emptyPayload(value.payload)) {
        return { type: 'ready', payload: {} };
    }
    if (value.type === 'run.started') {
        const id = turnId(value.payload.turnId);
        return id ? { type: 'run.started', payload: { turnId: id } } : null;
    }
    if (value.type === 'run.settled') {
        const id = turnId(value.payload.turnId);
        const outcome = runOutcome(value.payload.outcome);
        if (!id || !outcome)
            return null;
        const code = typeof value.payload.code === 'string' && REJECTION_CODE.test(value.payload.code)
            ? value.payload.code
            : undefined;
        return { type: 'run.settled', payload: { turnId: id, outcome, ...(code ? { code } : {}) } };
    }
    if (value.type === 'session.refresh-requested'
        && (value.payload.reason === 'expired' || value.payload.reason === 'invalid')) {
        return { type: value.type, payload: { reason: value.payload.reason } };
    }
    if (value.type === 'error'
        && typeof value.payload.code === 'string'
        && typeof value.payload.recoverable === 'boolean') {
        return {
            type: 'error',
            payload: { code: value.payload.code, recoverable: value.payload.recoverable },
        };
    }
    return null;
}
//# sourceMappingURL=protocol.js.map