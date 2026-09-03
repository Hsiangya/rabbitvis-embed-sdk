export declare const EMBED_PROTOCOL_VERSION: 1;
export declare const EMBED_EVENT_SOURCE: "rabbitvis-embed";
export declare const EMBED_HOST_SOURCE: "rabbitvis-embed-host";
export type RabbitVisRunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'rejected';
export type RabbitVisEmbedEvent = {
    type: 'ready';
    payload: Record<string, never>;
} | {
    type: 'run.started';
    payload: {
        turnId: string;
    };
}
/**
 * One terminal fact per turn. `turnId` is the same value the partner backend
 * receives in FINALIZE/RELEASE; `code` is only present for `rejected` and
 * names the server refusal, e.g. `partner.usage_denied`.
 */
 | {
    type: 'run.settled';
    payload: {
        turnId: string;
        outcome: RabbitVisRunOutcome;
        code?: string;
    };
} | {
    type: 'session.refresh-requested';
    payload: {
        reason: 'expired' | 'invalid';
    };
} | {
    type: 'error';
    payload: {
        code: string;
        recoverable: boolean;
    };
};
export type RabbitVisEmbedCommand = {
    type: 'focus';
    payload: Record<string, never>;
};
export declare function parseEmbedEvent(value: unknown, instanceId: string): RabbitVisEmbedEvent | null;
//# sourceMappingURL=protocol.d.ts.map