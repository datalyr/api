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
    constructor(config: DatalyrConfig | string);
    track(userId: string | null, event: string, properties?: any): Promise<void>;
    identify(userId: string, traits?: any): Promise<void>;
    page(userId: string, name?: string, properties?: any): Promise<void>;
    group(userId: string, groupId: string, traits?: any): Promise<void>;
    private enqueue;
    flush(): Promise<void>;
    private sendEvent;
    private startFlushTimer;
    private generateAnonymousId;
    close(): Promise<void>;
}

export { Datalyr, type DatalyrConfig, type TrackEvent, Datalyr as default };
