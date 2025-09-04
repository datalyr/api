interface DatalyrConfig {
    apiKey: string;
    host?: string;
    flushAt?: number;
    flushInterval?: number;
    debug?: boolean;
    timeout?: number;
    retryLimit?: number;
    maxQueueSize?: number;
}
interface TrackEvent {
    userId?: string;
    anonymousId?: string;
    event: string;
    properties?: Record<string, any>;
    context?: Record<string, any>;
    timestamp?: string;
}
interface TrackOptions {
    userId?: string;
    anonymousId?: string;
    event: string;
    properties?: Record<string, any>;
}
declare class Datalyr {
    private apiKey;
    private host;
    private debug;
    private queue;
    private flushAt;
    private flushInterval;
    private timeout;
    private retryLimit;
    private maxQueueSize;
    private timer?;
    private isFlushing;
    private isClosing;
    private anonymousId?;
    constructor(config: DatalyrConfig | string);
    track(options: TrackOptions): Promise<void>;
    track(userId: string | null, event: string, properties?: any): Promise<void>;
    identify(userId: string, traits?: any): Promise<void>;
    page(userId: string, name?: string, properties?: any): Promise<void>;
    group(userId: string, groupId: string, traits?: any): Promise<void>;
    private enqueue;
    flush(): Promise<void>;
    private sendEvent;
    private startFlushTimer;
    private generateAnonymousId;
    private getOrCreateAnonymousId;
    getAnonymousId(): string;
    close(): Promise<void>;
}

export { Datalyr, type DatalyrConfig, type TrackEvent, type TrackOptions, Datalyr as default };
