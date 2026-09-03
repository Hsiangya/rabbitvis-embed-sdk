export interface RabbitVisEmbedSession {
    embedUrl: string;
    /** Opaque partner-visible correlation fields; the SDK never sends them to the iframe. */
    sessionId?: string;
    expiresIn?: number;
}
export type RabbitVisSessionProvider = {
    sessionEndpoint: string;
    getEmbedSession?: never;
} | {
    sessionEndpoint?: never;
    getEmbedSession(): Promise<RabbitVisEmbedSession>;
};
export declare function requestEmbedSession(provider: RabbitVisSessionProvider): Promise<RabbitVisEmbedSession>;
//# sourceMappingURL=session-provider.d.ts.map