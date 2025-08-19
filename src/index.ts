export interface DatalyrConfig {
  apiKey: string;
  host?: string;
  flushAt?: number;
  flushInterval?: number;
  debug?: boolean;
  timeout?: number;
  retryLimit?: number;
  maxQueueSize?: number;
}

export interface TrackEvent {
  userId?: string;
  anonymousId?: string;
  event: string;
  properties?: Record<string, any>;
  context?: Record<string, any>;
  timestamp?: string;
}

export class Datalyr {
  private apiKey: string;
  private host: string;
  private debug: boolean;
  private queue: TrackEvent[] = [];
  private flushAt: number;
  private flushInterval: number;
  private timeout: number;
  private retryLimit: number;
  private maxQueueSize: number;
  private timer?: NodeJS.Timeout;
  private isFlushing: boolean = false;
  private isClosing: boolean = false;

  constructor(config: DatalyrConfig | string) {
    if (typeof config === 'string') {
      this.apiKey = config;
      this.host = 'https://api.datalyr.com';
      this.debug = false;
      this.flushAt = 20;
      this.flushInterval = 10000;
      this.timeout = 10000;
      this.retryLimit = 3;
      this.maxQueueSize = 1000;
    } else {
      this.apiKey = config.apiKey;
      this.host = config.host || 'https://api.datalyr.com';
      this.debug = config.debug || false;
      this.flushAt = config.flushAt || 20;
      this.flushInterval = config.flushInterval || 10000;
      this.timeout = config.timeout || 10000;
      this.retryLimit = config.retryLimit || 3;
      this.maxQueueSize = config.maxQueueSize || 1000;
    }

    if (!this.apiKey) {
      throw new Error('Datalyr API key is required');
    }

    if (!this.apiKey.startsWith('dk_')) {
      console.warn('[Datalyr] API key should start with "dk_"');
    }

    // Validate config values
    if (this.flushAt < 1) this.flushAt = 1;
    if (this.flushAt > 100) this.flushAt = 100;
    if (this.timeout < 1000) this.timeout = 1000;
    if (this.timeout > 60000) this.timeout = 60000;
    if (this.maxQueueSize < 100) this.maxQueueSize = 100;
    if (this.maxQueueSize > 10000) this.maxQueueSize = 10000;

    // Start flush timer
    this.startFlushTimer();
  }

  async track(userId: string | null, event: string, properties?: any): Promise<void> {
    if (this.isClosing) {
      if (this.debug) {
        console.warn('[Datalyr] SDK is closing, event dropped:', event);
      }
      return;
    }

    if (!event || typeof event !== 'string') {
      throw new Error('Event name is required and must be a string');
    }

    const trackEvent: TrackEvent = {
      userId: userId || undefined,
      anonymousId: userId ? undefined : this.generateAnonymousId(),
      event,
      properties: properties || {},
      context: {
        library: '@datalyr/api',
        version: '1.0.4',
        source: 'api'  // Explicitly set source for server-side API
      },
      timestamp: new Date().toISOString()
    };

    this.enqueue(trackEvent);
  }

  async identify(userId: string, traits?: any): Promise<void> {
    if (!userId) {
      throw new Error('userId is required for identify');
    }
    return this.track(userId, '$identify', { $set: traits });
  }

  async page(userId: string, name?: string, properties?: any): Promise<void> {
    return this.track(userId, '$pageview', { name, ...properties });
  }

  async group(userId: string, groupId: string, traits?: any): Promise<void> {
    if (!groupId) {
      throw new Error('groupId is required for group');
    }
    return this.track(userId, '$group', { groupId, traits });
  }

  private enqueue(event: TrackEvent): void {
    // Check queue size limit to prevent memory issues
    if (this.queue.length >= this.maxQueueSize) {
      if (this.debug) {
        console.warn(`[Datalyr] Queue full (${this.maxQueueSize}), dropping oldest event`);
      }
      this.queue.shift(); // Remove oldest event
    }

    this.queue.push(event);

    if (this.debug) {
      console.log('[Datalyr] Event queued:', event.event);
    }

    if (this.queue.length >= this.flushAt) {
      // Don't await to avoid blocking
      this.flush().catch(err => {
        if (this.debug) {
          console.error('[Datalyr] Auto-flush error:', err);
        }
      });
    }
  }

  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushing || this.queue.length === 0) {
      return;
    }

    this.isFlushing = true;

    try {
      // Take all events from queue
      const events = [...this.queue];
      this.queue = [];

      if (this.debug) {
        console.log(`[Datalyr] Flushing ${events.length} events`);
      }

      // Send events in parallel batches for better performance
      const batchSize = 10;
      const errors: Error[] = [];
      
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        const promises = batch.map(event => 
          this.sendEvent(event).catch(err => {
            errors.push(err);
            // Re-queue failed event at the front
            this.queue.unshift(event);
          })
        );
        
        await Promise.allSettled(promises);
      }

      if (errors.length > 0 && this.debug) {
        console.error(`[Datalyr] ${errors.length} events failed to send`);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private async sendEvent(event: TrackEvent, retryCount = 0): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(this.host, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          // Ignore body read errors
        }
        
        // Don't retry on 4xx errors (client errors)
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client error: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        // Retry on 5xx errors (server errors)
        throw new Error(`Server error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (this.debug) {
        // Only read response in debug mode
        try {
          const result = await response.json();
          console.log('[Datalyr] Event sent successfully:', result);
        } catch {
          console.log('[Datalyr] Event sent successfully');
        }
      }
    } catch (error: any) {
      // Don't retry client errors
      if (error.message?.startsWith('Client error:')) {
        if (this.debug) {
          console.error('[Datalyr] Permanent error, not retrying:', error.message);
        }
        throw error;
      }

      // Retry server errors with exponential backoff
      if (retryCount < this.retryLimit) {
        if (this.debug) {
          console.log(`[Datalyr] Retrying event (attempt ${retryCount + 1}/${this.retryLimit})`);
        }
        const backoffMs = Math.min(Math.pow(2, retryCount) * 1000, 10000); // Max 10s
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.sendEvent(event, retryCount + 1);
      }
      
      throw error;
    }
  }

  private startFlushTimer(): void {
    this.timer = setInterval(() => {
      if (!this.isClosing) {
        this.flush().catch(err => {
          if (this.debug) {
            console.error('[Datalyr] Timer flush error:', err);
          }
        });
      }
    }, this.flushInterval);

    // Prevent timer from keeping process alive
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  private generateAnonymousId(): string {
    return 'anon_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  // Cleanup
  async close(): Promise<void> {
    this.isClosing = true;
    
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    
    // Final flush with timeout
    const flushPromise = this.flush();
    const timeoutPromise = new Promise<void>((resolve) => 
      setTimeout(() => resolve(), 5000)
    );
    
    await Promise.race([flushPromise, timeoutPromise]);
    
    if (this.debug && this.queue.length > 0) {
      console.warn(`[Datalyr] Closing with ${this.queue.length} events still queued`);
    }
  }
}

export default Datalyr;