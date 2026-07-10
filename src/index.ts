import { randomUUID } from 'node:crypto';

export interface DatalyrConfig {
  apiKey: string;
  host?: string;
  flushAt?: number;
  flushInterval?: number;
  debug?: boolean;
  timeout?: number;
  retryLimit?: number;
  maxQueueSize?: number;
  /** Max ms close() will spend draining the queue before giving up. Default 30000.
   *  Must be >= worst-case retry time (sendEvent backoff is up to ~7s for 3 retries),
   *  or close() drops events still mid-retry. */
  closeTimeout?: number;
}

export interface TrackEvent {
  userId?: string;
  anonymousId?: string;
  eventId?: string;
  event: string;
  properties?: Record<string, any>;
  context?: Record<string, any>;
  timestamp?: string;
}

export interface TrackOptions {
  userId?: string;
  anonymousId?: string;
  event: string;
  properties?: Record<string, any>;
  /** Idempotency key for this event. The ingest server de-duplicates on it (6h window),
   *  so pass a stable id from your source system — e.g. the Stripe webhook `event.id` —
   *  and at-least-once webhook redeliveries won't double-count. Must be a non-empty
   *  string; anything else is ignored (a random UUID is generated, as when omitted). */
  eventId?: string;
  /** When the event actually happened. Accepts an ISO-8601 string, a Date, or a numeric
   *  epoch (milliseconds; values < 1e12 are interpreted as epoch SECONDS, e.g. Stripe's
   *  `event.created`). Defaults to now. Invalid values are ignored (defaults to now) —
   *  pass this on delayed webhook replays so the event lands on the right day. */
  timestamp?: string | Date | number;
}

// NODE-13: use node:crypto randomUUID unconditionally (GA since Node 14.17). The old
// global-`crypto` guard fell back to a weak Math.random id on Node <19, and eventId is
// the SERVER dedup key — a collision there is silent data loss.
function generateEventId(): string {
  return randomUUID();
}

// A FRESH anonymous id, generated PER CALL — never a shared instance value. This is the
// fix for NODE-6: a single long-lived server process tracking many distinct end-users
// must not stamp them all with one anonymous_id (which the ingest identity-resolution
// then cross-links into one merged identity, leaking traits across users).
function generateAnonymousId(): string {
  return 'anon_' + randomUUID();
}

const SDK_VERSION = '1.3.0';

// NODE-8: max FAILED flush-cycles before an event is dropped (DLQ-lite). Separate from —
// and more generous than — retryLimit (the per-send retry count): a brief outage spans a
// few flush cycles before recovering, so this must be high enough to survive that, while
// still preventing a permanently-failing "poison" event from cycling at the queue front
// forever.
const MAX_FLUSH_ATTEMPTS = 10;

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
  private closeTimeout: number;
  private timer?: NodeJS.Timeout;
  private isFlushing: boolean = false;
  private isClosing: boolean = false;
  private currentFlush?: Promise<void>;  // the in-flight flush — callers/close() await this instead of getting a no-op (NODE-3)
  private warnedNoId = false;            // one-time warn for calls with neither userId nor anonymousId (NODE-6)
  private flushAttempts = new WeakMap<TrackEvent, number>(); // failed-flush-cycle count per event (NODE-8); WeakMap → no payload pollution
  private warnedQueueFull = false;       // one-time prod warn when the queue overflows (NODE-5)
  private exitHook?: () => void;         // the beforeExit listener (stored so close() can remove it — review M2)

  constructor(config: DatalyrConfig | string) {
    if (typeof config === 'string') {
      this.apiKey = config;
      this.host = 'https://ingest.datalyr.com/track';
      this.debug = false;
      this.flushAt = 20;
      this.flushInterval = 10000;
      this.timeout = 10000;
      this.retryLimit = 3;
      this.maxQueueSize = 1000;
      this.closeTimeout = 30000;
    } else {
      this.apiKey = config.apiKey;
      this.host = config.host || 'https://ingest.datalyr.com/track';
      this.debug = config.debug || false;
      this.flushAt = config.flushAt || 20;
      this.flushInterval = config.flushInterval || 10000;
      this.timeout = config.timeout || 10000;
      this.retryLimit = config.retryLimit ?? 3;
      this.maxQueueSize = config.maxQueueSize || 1000;
      this.closeTimeout = config.closeTimeout ?? 30000;
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
    // NODE-12: flushInterval was never validated — 0/negative/NaN makes setInterval
    // busy-loop. (The `|| 10000` above only catches 0/undefined, not negatives.)
    if (!(this.flushInterval >= 1000)) this.flushInterval = 10000;
    if (this.flushInterval > 3_600_000) this.flushInterval = 3_600_000;
    if (!(this.closeTimeout >= 1000)) this.closeTimeout = 30000;
    if (this.closeTimeout > 120_000) this.closeTimeout = 120_000;
    // retryLimit: `?? 3` above preserves an explicit 0 (no retries); clamp negatives/NaN.
    if (!(this.retryLimit >= 0)) this.retryLimit = 3;
    if (this.retryLimit > 10) this.retryLimit = 10;

    // NODE-11: best-effort drain on process exit (short scripts/cron/serverless that
    // finish before flushAt would otherwise lose buffered events — the timer is unref'd
    // and track() doesn't await the network). Does NOT replace `await close()`.
    this.registerExitHook();

    // Start flush timer
    this.startFlushTimer();
  }

  private registerExitHook(): void {
    if (typeof process === 'undefined' || typeof process.once !== 'function') return;
    // Stored on the instance so close() can removeListener it (review M2: `once` without
    // removal leaks the instance + its queue for the process lifetime when close() is
    // called and the hook never fires — bad for per-request client construction).
    this.exitHook = () => {
      if (this.isClosing || this.queue.length === 0) return;
      // beforeExit lets the loop run async work; best-effort (use close() for guarantees).
      this.flush().catch(() => {});
    };
    process.once('beforeExit', this.exitHook);
  }

  // Overloaded track method that accepts TrackOptions
  async track(options: TrackOptions): Promise<void>;
  async track(userId: string | null, event: string, properties?: any): Promise<void>;
  async track(userIdOrOptions: string | null | TrackOptions, event?: string, properties?: any): Promise<void> {
    if (this.isClosing) {
      if (this.debug) {
        console.warn('[Datalyr] SDK is closing, event dropped');
      }
      return;
    }

    // Handle both signatures
    let userId: string | undefined;
    let eventName: string;
    let eventProperties: any;
    let providedAnonymousId: string | undefined;
    let providedEventId: string | undefined;
    let providedTimestamp: string | Date | number | undefined;

    if (typeof userIdOrOptions === 'object' && userIdOrOptions !== null) {
      // TrackOptions signature
      userId = userIdOrOptions.userId;
      eventName = userIdOrOptions.event;
      eventProperties = userIdOrOptions.properties || {};
      providedAnonymousId = userIdOrOptions.anonymousId;
      providedEventId = userIdOrOptions.eventId;
      providedTimestamp = userIdOrOptions.timestamp;
    } else {
      // Legacy signature: (userId, event, properties)
      userId = userIdOrOptions || undefined;
      eventName = event!;
      eventProperties = properties || {};
    }

    if (!eventName || typeof eventName !== 'string') {
      throw new Error('Event name is required and must be a string');
    }

    // NODE-6: use the caller-provided anonymousId, else a FRESH one per call — NEVER a
    // shared instance value (that merged distinct end-users tracked from one server
    // process into a single identity). A call with neither userId nor anonymousId can't
    // be stitched to a user server-side; warn once so the integrator passes an id.
    if (!userId && !providedAnonymousId && !this.warnedNoId) {
      this.warnedNoId = true;
      console.warn('[Datalyr] track() called with neither userId nor anonymousId. Pass one per end-user — anonymous server-side events can\'t be stitched across calls, and a shared id would merge users.');
    }
    const anonymousId = providedAnonymousId || generateAnonymousId();

    // Include anonymous_id in properties for attribution
    const enrichedProperties = {
      ...eventProperties,
      anonymous_id: anonymousId
    };

    const trackEvent: TrackEvent = {
      userId: userId || undefined,
      anonymousId: anonymousId,  // Always include for identity resolution
      // 9.D.1: honor a caller-supplied eventId VERBATIM — it is the ingest server's dedup
      // key (6h window), so webhook handlers can pass the source event id (e.g. Stripe
      // `event.id`) and at-least-once redeliveries no longer double-count revenue. A fresh
      // uuid per call (the old unconditional behavior) made every redelivery look new.
      eventId: this.resolveEventId(providedEventId),
      event: eventName,
      properties: enrichedProperties,
      context: {
        library: '@datalyr/api',
        version: SDK_VERSION,
        source: 'api'
      },
      // 9.D.5: honor a caller-supplied timestamp (ingest reads `event.timestamp || now`),
      // so delayed webhook replays land on the day the event happened, not the replay day.
      timestamp: this.resolveTimestamp(providedTimestamp)
    };

    this.enqueue(trackEvent);
  }

  async identify(userId: string, traits?: any, anonymousId?: string): Promise<void> {
    if (!userId) {
      throw new Error('userId is required for identify');
    }
    // Route through the options form so a caller-provided anonymousId is honored (NODE-6).
    // track() stamps anonymous_id itself — no need to inject the (formerly shared) one.
    // Traits stay flat (not wrapped in $set) so the user-properties-updater extracts them.
    return this.track({ userId, anonymousId, event: '$identify', properties: { ...traits } });
  }

  async alias(newUserId: string, previousId?: string, anonymousId?: string): Promise<void> {
    if (!newUserId) {
      throw new Error('newUserId is required for alias');
    }
    // Resolve the anon up front so the event's anonymousId and previous_id line up
    // (and so previous_id isn't a different freshly-generated id than the event carries).
    const anon = anonymousId || generateAnonymousId();
    const prev = previousId || anon;
    return this.track({
      userId: newUserId,
      anonymousId: anon,
      event: '$alias',
      // Emit BOTH snake_case AND camelCase: the ingest $alias link builder reads
      // eventData.previousId / eventData.userId (camelCase), so without these keys the
      // alias has ALWAYS written zero visitor_user_links rows (pre-existing server bug).
      properties: { new_user_id: newUserId, previous_id: prev, userId: newUserId, previousId: prev }
    });
  }

  async page(userId: string, name?: string, properties?: any, anonymousId?: string): Promise<void> {
    return this.track({ userId: userId || undefined, anonymousId, event: '$pageview', properties: { name, ...properties } });
  }

  async group(userId: string, groupId: string, traits?: any, anonymousId?: string): Promise<void> {
    if (!groupId) {
      throw new Error('groupId is required for group');
    }
    return this.track({ userId, anonymousId, event: '$group', properties: { groupId, ...traits } });
  }

  // 9.D.1: caller-supplied idempotency key. Defensive by design — this SDK must never
  // crash the host — so anything that isn't a non-empty string is IGNORED (fresh uuid,
  // same as omitting it) with a debug warning, never a throw.
  private resolveEventId(provided: unknown): string {
    if (typeof provided === 'string' && provided.trim().length > 0) {
      return provided; // verbatim — must match exactly across redeliveries to dedup
    }
    if (provided !== undefined && provided !== null && this.debug) {
      console.warn('[Datalyr] Ignoring invalid eventId (must be a non-empty string); using a random UUID — redeliveries of this event will NOT be deduplicated.');
    }
    return generateEventId();
  }

  // 9.D.5: caller-supplied event time, normalized to ISO-8601. Accepts ISO string, Date,
  // or numeric epoch. Numbers < 1e12 are treated as epoch SECONDS (webhook payloads like
  // Stripe's `event.created` are seconds; 1e12 ms is Sep 2001, so real ms timestamps are
  // always above it). Invalid input → now, with a debug warning — never a throw.
  private resolveTimestamp(provided: unknown): string {
    if (provided !== undefined && provided !== null) {
      let date: Date | undefined;
      if (provided instanceof Date) {
        date = provided;
      } else if (typeof provided === 'number' && Number.isFinite(provided)) {
        date = new Date(provided < 1e12 ? provided * 1000 : provided);
      } else if (typeof provided === 'string' && provided.trim().length > 0) {
        date = new Date(provided);
      }
      if (date && Number.isFinite(date.getTime())) {
        return date.toISOString();
      }
      if (this.debug) {
        console.warn('[Datalyr] Ignoring invalid timestamp (expected ISO string, Date, or epoch number); using current time.');
      }
    }
    return new Date().toISOString();
  }

  private enqueue(event: TrackEvent): void {
    // Check queue size limit to prevent memory issues. NODE-5: surface the drop in PROD
    // (once) — it was debug-only, so silent data loss under sustained overload.
    if (this.queue.length >= this.maxQueueSize) {
      if (!this.warnedQueueFull) {
        this.warnedQueueFull = true;
        console.warn(`[Datalyr] Queue full (${this.maxQueueSize}) — dropping oldest events. Increase maxQueueSize, or flush()/close() more often.`);
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
    if (this.queue.length === 0) return;
    // NODE-3: if a flush is already running, AWAIT it (return the in-flight promise)
    // rather than no-op'ing — otherwise callers (and close()) get a silently-resolved
    // promise while their events sit unsent.
    if (this.isFlushing) {
      return this.currentFlush ?? Promise.resolve();
    }

    this.isFlushing = true;
    this.currentFlush = this._flush();
    try {
      await this.currentFlush;
    } finally {
      this.isFlushing = false;
      this.currentFlush = undefined;
    }
  }

  private async _flush(): Promise<void> {
    // Take all events from queue
    const events = [...this.queue];
    this.queue = [];

    if (this.debug) {
      console.log(`[Datalyr] Flushing ${events.length} events`);
    }

    // NODE-7: this is a CONCURRENCY window (10 events in parallel), NOT a single batched
    // HTTP request — one POST per event. (Real payload batching is gated on the ingest
    // `/batch` endpoint, currently disabled.)
    const batchSize = 10;
    let failed = 0;

    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      const promises = batch.map(event =>
        this.sendEvent(event).catch(() => {
          failed++;
          // NODE-8 / NODE-9 / NODE-10: bound re-queue attempts so a permanently-failing
          // event can't cycle at the front forever (re-failing every flush). Count failed
          // flush-cycles per event (WeakMap, no payload pollution); drop with a VISIBLE
          // warn after retryLimit cycles. Re-queue at the front so failures retry first.
          const n = (this.flushAttempts.get(event) || 0) + 1;
          this.flushAttempts.set(event, n);
          if (n >= MAX_FLUSH_ATTEMPTS) {
            console.warn(`[Datalyr] Dropping event after ${n} failed flush attempts: ${event.event}`);
          } else {
            this.queue.unshift(event);
          }
        })
      );
      await Promise.allSettled(promises);
    }

    if (failed > 0 && this.debug) {
      console.error(`[Datalyr] ${failed} events failed to send this flush`);
    }
  }

  private async sendEvent(event: TrackEvent, retryCount = 0): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // NODE-15: clear the abort timer on settle (success OR reject). A fetch rejection
      // (DNS / ECONNRESET / TLS) used to skip clearTimeout, leaving a non-unref'd timer
      // pending up to `timeout` ms that can delay process exit.
      const response = await fetch(this.host, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': `@datalyr/api/${SDK_VERSION}`
        },
        body: JSON.stringify(event),
        signal: controller.signal
      }).finally(() => clearTimeout(timeoutId));

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
        // NODE-8: full jitter so many SDK instances don't retry in lockstep against a
        // recovering server.
        const backoffMs = Math.min(Math.pow(2, retryCount) * 1000, 10000); // Max 10s
        const jittered = backoffMs * (0.5 + Math.random() * 0.5);
        await new Promise(resolve => setTimeout(resolve, jittered));
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

  /**
   * Generate a NEW anonymous id. NODE-6: there is no longer a shared process-wide anon
   * (that merged distinct users). Each call returns a fresh id — persist it in YOUR
   * per-user/session store and pass it back as `anonymousId` to stitch that user's
   * events. (Behavior change from <=1.2.3, which returned one shared id.)
   */
  getAnonymousId(): string {
    return generateAnonymousId();
  }

  // Cleanup
  async close(): Promise<void> {
    this.isClosing = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // NODE-1/2/4: actually DRAIN the queue. The old close() flushed ONCE and raced a hard
    // 5s timeout — one flush isn't enough (it re-queues failures), a no-op flush won if one
    // was in flight, and 5s < worst-case retry (~7s) dropped mid-retry events. Loop flush()
    // (which now awaits an in-flight flush instead of no-op'ing) until the queue drains or
    // the configurable closeTimeout budget expires.
    //
    // review H1/H2: each flush() runs the FULL per-event retry chain (retryLimit × timeout
    // + backoff) before returning, which would overshoot closeTimeout by multiples and hang
    // on a slow/unresponsive endpoint. So race each flush against the REMAINING budget — a
    // real wall-clock bound. An in-flight flush whose budget expires keeps running in the
    // background (best-effort delivery; it has its own .catch), so close() never blocks past
    // its budget.
    const start = Date.now();
    const deadline = start + this.closeTimeout;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await Promise.race([
        this.flush().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
      // If events remain (failed + re-queued) and no flush is in flight, pause briefly so
      // we don't hot-loop against a still-failing endpoint (bounded by the deadline).
      if (this.queue.length > 0 && !this.isFlushing && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      }
    }

    // review M2: stop leaking the beforeExit listener (+ the instance/queue it pins).
    if (this.exitHook) {
      try { process.removeListener('beforeExit', this.exitHook); } catch { /* noop */ }
      this.exitHook = undefined;
    }

    if (this.queue.length > 0) {
      console.warn(`[Datalyr] close(): ${this.queue.length} event(s) undelivered after ~${Date.now() - start}ms (budget ${this.closeTimeout}ms).`);
    }
  }
}

export default Datalyr;
