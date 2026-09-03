function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseSession(value) {
    if (!isRecord(value) || typeof value.embedUrl !== 'string' || !value.embedUrl.trim()) {
        throw new Error('Partner session response must include embedUrl');
    }
    return {
        embedUrl: value.embedUrl,
        ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
        ...(typeof value.expiresIn === 'number' && Number.isFinite(value.expiresIn)
            ? { expiresIn: value.expiresIn }
            : {}),
    };
}
export async function requestEmbedSession(provider) {
    if ('getEmbedSession' in provider && provider.getEmbedSession) {
        return parseSession(await provider.getEmbedSession());
    }
    const endpoint = new URL(provider.sessionEndpoint, window.location.href);
    if (endpoint.origin !== window.location.origin) {
        throw new Error('sessionEndpoint must be same-origin; use getEmbedSession for a custom gateway');
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
    });
    if (!response.ok)
        throw new Error(`Partner session endpoint failed (${response.status})`);
    const text = await response.text();
    if (text.length > 64 * 1024)
        throw new Error('Partner session response is too large');
    return parseSession(JSON.parse(text));
}
//# sourceMappingURL=session-provider.js.map