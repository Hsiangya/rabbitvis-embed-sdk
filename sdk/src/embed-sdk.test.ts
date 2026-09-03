import { afterEach, describe, expect, it, vi } from 'vitest'

import { RabbitVisEmbed } from './index.js'

describe('RabbitVisEmbed', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('gets a launch URL from the partner backend and mounts a hardened iframe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      embedUrl: 'https://rabbitvis.example/embed/#code=one-time-code',
      sessionId: 'partner-visible-correlation',
      expiresIn: 60,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const container = document.createElement('div')
    document.body.append(container)
    const embed = new RabbitVisEmbed({
      container,
      rabbitVisOrigin: 'https://rabbitvis.example',
      sessionEndpoint: '/api/rabbitvis/embed-session',
    })

    await embed.mount()

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/api/rabbitvis/embed-session', window.location.href),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    const src = new URL(embed.iframe.src)
    expect(src.origin).toBe('https://rabbitvis.example')
    expect(src.pathname).toBe('/embed/')
    expect(new URLSearchParams(src.hash.slice(1)).get('code')).toBe('one-time-code')
    expect(new URLSearchParams(src.hash.slice(1)).get('instanceId')).toBe(embed.instanceId)
    expect(new URLSearchParams(src.hash.slice(1)).get('parentOrigin')).toBe(window.location.origin)
    expect(embed.iframe.getAttribute('sandbox')).toContain('allow-scripts')
    embed.destroy()
  })

  it('rejects a session endpoint that would send partner cookies cross-origin', async () => {
    const container = document.createElement('div')
    const embed = new RabbitVisEmbed({
      container,
      rabbitVisOrigin: 'https://rabbitvis.example',
      sessionEndpoint: 'https://evil.example/embed-session',
    })
    await expect(embed.mount()).rejects.toThrow('same-origin')
  })

  it('ignores forged events and accepts only its own iframe window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      embedUrl: 'https://rabbitvis.example/embed/#code=once',
    }), { status: 200 })))
    const onEvent = vi.fn()
    const container = document.createElement('div')
    const embed = new RabbitVisEmbed({
      container,
      rabbitVisOrigin: 'https://rabbitvis.example',
      sessionEndpoint: '/embed-session',
      onEvent,
    })
    await embed.mount()
    const event = {
      source: 'rabbitvis-embed',
      version: 1,
      instanceId: embed.instanceId,
      type: 'ready',
      payload: {},
    }

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example',
      source: embed.iframe.contentWindow,
      data: event,
    }))
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://rabbitvis.example',
      source: window,
      data: event,
    }))
    expect(onEvent).not.toHaveBeenCalled()

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://rabbitvis.example',
      source: embed.iframe.contentWindow,
      data: {
        ...event,
        type: 'billing.changed',
        payload: { billingView: { displayValue: '88' }, cached: false },
      },
    }))
    expect(onEvent).not.toHaveBeenCalled()

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://rabbitvis.example',
      source: embed.iframe.contentWindow,
      data: event,
    }))
    expect(onEvent).toHaveBeenCalledWith({ type: 'ready', payload: {} })
    embed.destroy()
  })

  it('delivers run lifecycle facts only with a valid turn id and outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      embedUrl: 'https://rabbitvis.example/embed/#code=once',
    }), { status: 200 })))
    const onEvent = vi.fn()
    const container = document.createElement('div')
    const embed = new RabbitVisEmbed({
      container,
      rabbitVisOrigin: 'https://rabbitvis.example',
      sessionEndpoint: '/embed-session',
      onEvent,
    })
    await embed.mount()
    const send = (type: string, payload: unknown) => window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://rabbitvis.example',
      source: embed.iframe.contentWindow,
      data: { source: 'rabbitvis-embed', version: 1, instanceId: embed.instanceId, type, payload },
    }))

    send('run.started', {})
    send('run.settled', { turnId: 'turn_1' })
    send('run.settled', { turnId: 'turn_1', outcome: 'exploded' })
    send('run.settled', { turnId: '../etc', outcome: 'succeeded' })
    expect(onEvent).not.toHaveBeenCalled()

    send('run.started', { turnId: 'turn_1' })
    send('run.settled', { turnId: 'turn_1', outcome: 'rejected', code: 'partner.usage_denied', extra: 'dropped' })
    expect(onEvent).toHaveBeenNthCalledWith(1, { type: 'run.started', payload: { turnId: 'turn_1' } })
    expect(onEvent).toHaveBeenNthCalledWith(2, {
      type: 'run.settled',
      payload: { turnId: 'turn_1', outcome: 'rejected', code: 'partner.usage_denied' },
    })
    embed.destroy()
  })

  it('rotates the instance id before reconnecting so stale frame events are ignored', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      embedUrl: 'https://rabbitvis.example/embed/#code=once',
    }), { status: 200 })))
    const onEvent = vi.fn()
    const container = document.createElement('div')
    const embed = new RabbitVisEmbed({
      container,
      rabbitVisOrigin: 'https://rabbitvis.example',
      sessionEndpoint: '/embed-session',
      onEvent,
    })
    await embed.mount()
    const oldInstanceId = embed.instanceId
    await embed.reloadSession()

    expect(embed.instanceId).not.toBe(oldInstanceId)
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://rabbitvis.example',
      source: embed.iframe.contentWindow,
      data: {
        source: 'rabbitvis-embed',
        version: 1,
        instanceId: oldInstanceId,
        type: 'ready',
        payload: {},
      },
    }))
    expect(onEvent).not.toHaveBeenCalled()
    embed.destroy()
  })
})
