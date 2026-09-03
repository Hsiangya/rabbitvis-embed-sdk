import { type RabbitVisEmbedEvent } from './protocol.js';
import { type RabbitVisSessionProvider } from './session-provider.js';
export type { RabbitVisEmbedEvent, RabbitVisRunOutcome } from './protocol.js';
export type { RabbitVisEmbedSession, RabbitVisSessionProvider } from './session-provider.js';
export type RabbitVisEmbedOptions = RabbitVisSessionProvider & {
    container: HTMLElement;
    /** Exact RabbitVis origin expected in embedUrl and postMessage events. */
    rabbitVisOrigin: string;
    className?: string;
    title?: string;
    onEvent?(event: RabbitVisEmbedEvent): void;
};
export declare class RabbitVisEmbed {
    private readonly options;
    readonly iframe: HTMLIFrameElement;
    private readonly expectedOrigin;
    private currentInstanceId;
    private destroyed;
    private reloadInFlight;
    get instanceId(): string;
    constructor(options: RabbitVisEmbedOptions);
    mount(): Promise<this>;
    focus(): void;
    reloadSession(): Promise<void>;
    destroy(): void;
    private loadFreshSession;
    private post;
    private readonly onMessage;
}
export declare function mountRabbitVisEmbed(options: RabbitVisEmbedOptions): Promise<RabbitVisEmbed>;
//# sourceMappingURL=index.d.ts.map