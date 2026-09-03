import {
  EMBED_HOST_SOURCE,
  EMBED_PROTOCOL_VERSION,
  parseEmbedEvent,
  type RabbitVisEmbedCommand,
  type RabbitVisEmbedEvent,
} from './protocol.js'
import {
  requestEmbedSession,
  type RabbitVisEmbedSession,
  type RabbitVisSessionProvider,
} from './session-provider.js'

export type { RabbitVisEmbedEvent, RabbitVisRunOutcome } from './protocol.js'
export type { RabbitVisEmbedSession, RabbitVisSessionProvider } from './session-provider.js'

export type RabbitVisEmbedOptions = RabbitVisSessionProvider & {
  container: HTMLElement
  /** Exact RabbitVis origin expected in embedUrl and postMessage events. */
  rabbitVisOrigin: string
  className?: string
  title?: string
  onEvent?(event: RabbitVisEmbedEvent): void
}

function randomInstanceId(): string {
  const value = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `rv_${value}`
}

function exactHttpOrigin(raw: string): string {
  const url = new URL(raw)
  if (!/^https?:$/.test(url.protocol) || url.origin !== raw) {
    throw new Error('rabbitVisOrigin must be an exact http(s) origin')
  }
  return url.origin
}

function localHttpAllowed(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function prepareEmbedUrl(
  session: RabbitVisEmbedSession,
  expectedOrigin: string,
  instanceId: string,
): URL {
  const url = new URL(session.embedUrl)
  if (url.origin !== expectedOrigin) throw new Error('embedUrl origin does not match rabbitVisOrigin')
  if (url.protocol !== 'https:' && !localHttpAllowed(url)) {
    throw new Error('embedUrl must use HTTPS outside local development')
  }
  if (!/^\/embed\/?$/.test(url.pathname)) throw new Error('embedUrl must target /embed/')
  if (url.search) throw new Error('embedUrl must use the fixed /embed/#code=... shape')
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const launchCode = fragment.get('code')
  if (!launchCode) throw new Error('embedUrl is missing its launch code')
  if ([...fragment.keys()].some((key) => key !== 'code')) {
    throw new Error('embedUrl contains unsupported fragment fields')
  }
  fragment.set('instanceId', instanceId)
  fragment.set('parentOrigin', window.location.origin)
  url.hash = fragment.toString()
  return url
}

export class RabbitVisEmbed {
  readonly iframe: HTMLIFrameElement
  private readonly expectedOrigin: string
  private currentInstanceId = randomInstanceId()
  private destroyed = false
  private reloadInFlight: Promise<void> | null = null

  get instanceId(): string {
    return this.currentInstanceId
  }

  constructor(private readonly options: RabbitVisEmbedOptions) {
    if (!options.container) throw new Error('container is required')
    const hasEndpoint = 'sessionEndpoint' in options && typeof options.sessionEndpoint === 'string'
    const hasCallback = 'getEmbedSession' in options && typeof options.getEmbedSession === 'function'
    if (hasEndpoint === hasCallback) {
      throw new Error('Provide exactly one of sessionEndpoint or getEmbedSession')
    }
    this.expectedOrigin = exactHttpOrigin(options.rabbitVisOrigin)
    if (this.expectedOrigin === window.location.origin) {
      throw new Error('RabbitVis must be hosted on a separate origin from the partner page')
    }
    this.iframe = document.createElement('iframe')
    this.iframe.title = options.title ?? 'RabbitVis editor'
    this.iframe.className = options.className ?? 'rabbitvis-embed-frame'
    this.iframe.style.width = '100%'
    this.iframe.style.height = '100%'
    this.iframe.style.display = 'block'
    this.iframe.style.border = '0'
    this.iframe.referrerPolicy = 'origin'
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals')
    this.iframe.setAttribute('allow', 'clipboard-read; clipboard-write')
    this.iframe.setAttribute('loading', 'eager')
  }

  async mount(): Promise<this> {
    if (this.destroyed) throw new Error('RabbitVisEmbed has been destroyed')
    window.addEventListener('message', this.onMessage)
    this.options.container.replaceChildren(this.iframe)
    try {
      await this.loadFreshSession()
      return this
    } catch (error) {
      this.destroy()
      throw error
    }
  }

  focus(): void {
    this.iframe.focus()
    this.post({ type: 'focus', payload: {} })
  }

  reloadSession(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('RabbitVisEmbed has been destroyed'))
    if (!this.reloadInFlight) {
      this.reloadInFlight = this.loadFreshSession().finally(() => {
        this.reloadInFlight = null
      })
    }
    return this.reloadInFlight
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    window.removeEventListener('message', this.onMessage)
    this.iframe.remove()
    this.iframe.src = 'about:blank'
  }

  private async loadFreshSession(): Promise<void> {
    // Reconnect first unloads the old bearer-bearing document. It cannot emit
    // accepted stale events while the partner backend is minting a replacement
    // code: rotate the message nonce before starting that navigation.
    if (this.iframe.src && this.iframe.src !== 'about:blank') this.iframe.src = 'about:blank'
    this.currentInstanceId = randomInstanceId()
    const loadInstanceId = this.currentInstanceId
    const session = await requestEmbedSession(this.options)
    if (this.destroyed || loadInstanceId !== this.currentInstanceId) return
    this.iframe.src = prepareEmbedUrl(session, this.expectedOrigin, loadInstanceId).href
  }

  private post(command: RabbitVisEmbedCommand): void {
    if (this.destroyed || !this.iframe.contentWindow) return
    this.iframe.contentWindow.postMessage({
      source: EMBED_HOST_SOURCE,
      version: EMBED_PROTOCOL_VERSION,
      instanceId: this.currentInstanceId,
      type: command.type,
      payload: command.payload,
    }, this.expectedOrigin)
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.destroyed || event.origin !== this.expectedOrigin) return
    if (event.source !== this.iframe.contentWindow) return
    const parsed = parseEmbedEvent(event.data, this.currentInstanceId)
    if (!parsed) return
    this.options.onEvent?.(parsed)
    if (parsed.type === 'session.refresh-requested') {
      void this.reloadSession().catch(() => {
        this.options.onEvent?.({
          type: 'error',
          payload: { code: 'session-refresh-failed', recoverable: true },
        })
      })
    }
  }
}

export async function mountRabbitVisEmbed(options: RabbitVisEmbedOptions): Promise<RabbitVisEmbed> {
  return new RabbitVisEmbed(options).mount()
}
