import { randomUUID, createHash } from 'node:crypto';

/** Why an event was dropped, passed to the onDrop hook (9.D.7). */
export type DropReason =
  | 'validation_error'   // track/identify/alias/group called with invalid args (9.D.4)
  | 'queue_overflow'     // maxQueueSize reached; oldest evicted (NODE-5)
  | 'permanent_client_error' // non-retryable 4xx (≠408/429), e.g. 401/403/400 (9.D.8)
  | 'max_flush_attempts' // transient failures exceeded MAX_FLUSH_ATTEMPTS cycles (NODE-8)
  | 'close_timeout'      // still queued when close()'s closeTimeout budget expired (NODE-1)
  | 'closed';            // track() called after close() (9.D.3)

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
  /** 9.D.7: called for every send failure (before any retry/requeue/drop decision), so you
   *  can log/alert on delivery problems. Never throws into the SDK — exceptions are swallowed. */
  onError?: (event: TrackEvent, error: Error) => void;
  /** 9.D.7: called whenever event(s) are permanently dropped, with the reason. Covers ALL
   *  drop paths (overflow, permanent 4xx, max-attempts, post-close, validation). Never
   *  throws into the SDK — exceptions are swallowed. Use this to persist to your own DLQ. */
  onDrop?: (events: TrackEvent[], reason: DropReason) => void;
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

/** 9.D.6: the revenue payload for trackPurchase(). `value` is required and must be a finite
 *  number (the server reads value ?? revenue ?? amount — value is the canonical field). */
export interface PurchaseProperties {
  value: number;
  currency?: string;
  [key: string]: any;
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

// B-4: cap the caller-supplied eventId. Longer ids become pathological Redis keys server-side;
// overflow is hash-collapsed (deterministic, so redeliveries still dedup) below.
const MAX_EVENT_ID_LENGTH = 256;

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
  private currentFlush?: Promise<void>;  // the in-flight drain — callers/close() await this instead of getting a no-op (NODE-3/TR-25)
  private closePromise?: Promise<void>;  // memoized so close() is idempotent under repeat/concurrent calls (9.D.3)
  private warnedNoId = false;            // one-time warn for calls with neither userId nor anonymousId (NODE-6)
  private warnedQueueFull = false;       // one-time prod warn when the queue overflows (NODE-5)
  private warnedClosed = false;          // one-time loud error for track() after close() (9.D.3)
  private warnedAuthFailure = false;     // one-time loud error for 401/403 (9.D.8)
  private flushAttempts = new WeakMap<TrackEvent, number>(); // failed-flush-cycle count per event (NODE-8); WeakMap → no payload pollution
  private exitHook?: () => void;         // the beforeExit listener (stored so close() can remove it — review M2)
  private onError?: (event: TrackEvent, error: Error) => void; // 9.D.7
  private onDrop?: (events: TrackEvent[], reason: DropReason) => void; // 9.D.7

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
      this.onError = typeof config.onError === 'function' ? config.onError : undefined;
      this.onDrop = typeof config.onDrop === 'function' ? config.onDrop : undefined;
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

  // 9.D.7: fan a drop/error out to the caller's observability hook. A hook that throws must
  // never crash the SDK (the whole point is defensive delivery), so swallow its exceptions.
  private notifyDrop(events: TrackEvent[], reason: DropReason): void {
    if (!this.onDrop) return;
    try { this.onDrop(events, reason); } catch { /* a hook must never break the SDK */ }
  }

  private notifyError(event: TrackEvent, error: Error): void {
    if (!this.onError) return;
    try { this.onError(event, error); } catch { /* a hook must never break the SDK */ }
  }

  // Overloaded track method that accepts TrackOptions
  async track(options: TrackOptions): Promise<void>;
  async track(userId: string | null, event: string, properties?: any): Promise<void>;
  async track(userIdOrOptions: string | null | TrackOptions, event?: string, properties?: any): Promise<void> {
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

    // 9.D.4: NEVER throw. An invalid event name from deep in caller business logic used to
    // throw out of this fire-and-forget promise → an ERR_UNHANDLED_REJECTION that crashed
    // the host process (exit 1). Warn, hand it to onDrop, and resolve.
    if (!eventName || typeof eventName !== 'string') {
      console.warn('[Datalyr] track() requires a non-empty string event name; event dropped.');
      this.notifyDrop([{ event: String(eventName ?? ''), userId } as TrackEvent], 'validation_error');
      return;
    }

    // 9.D.3: close() is terminal. Post-close track() used to drop silently (debug-only). Emit
    // ONE loud, un-gated error so a mis-ordered shutdown (close() before the last track) is
    // visible in prod; every dropped event still reaches onDrop for programmatic handling.
    // For serverless, prefer `await flush()` per invocation and reserve close() for shutdown.
    if (this.isClosing) {
      if (!this.warnedClosed) {
        this.warnedClosed = true;
        console.error('[Datalyr] track() called after close() — event dropped. close() is terminal; use flush() per invocation (e.g. serverless) and close() only at shutdown.');
      }
      this.notifyDrop([{ event: eventName, userId } as TrackEvent], 'closed');
      return;
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
        source: 'api',
        schema_version: 1 // A3-25: versioned-envelope stamp
      },
      // 9.D.5: honor a caller-supplied timestamp (ingest reads `event.timestamp || now`),
      // so delayed webhook replays land on the day the event happened, not the replay day.
      timestamp: this.resolveTimestamp(providedTimestamp)
    };

    this.enqueue(trackEvent);
  }

  async identify(userId: string, traits?: any, anonymousId?: string): Promise<void> {
    // 9.D.4: warn-and-drop, never throw (see track()).
    if (!userId) {
      console.warn('[Datalyr] identify() requires a userId; call dropped.');
      this.notifyDrop([{ event: '$identify' } as TrackEvent], 'validation_error');
      return;
    }
    // Route through the options form so a caller-provided anonymousId is honored (NODE-6).
    // track() stamps anonymous_id itself — no need to inject the (formerly shared) one.
    // Traits stay flat (not wrapped in $set) so the user-properties-updater extracts them.
    return this.track({ userId, anonymousId, event: '$identify', properties: { ...traits } });
  }

  async alias(newUserId: string, previousId?: string, anonymousId?: string): Promise<void> {
    // 9.D.4: warn-and-drop, never throw.
    if (!newUserId) {
      console.warn('[Datalyr] alias() requires a newUserId; call dropped.');
      this.notifyDrop([{ event: '$alias' } as TrackEvent], 'validation_error');
      return;
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
    const props: Record<string, any> = { name, ...properties };
    // P3: ingest derives page_url ONLY from props.url, so a name-only page() call left
    // page_url blank server-side. When the caller gives no url, fall back to the page name
    // so the pageview is at least addressable (callers who want a real URL should pass one).
    if (props.url == null && name != null) props.url = name;
    return this.track({ userId: userId || undefined, anonymousId, event: '$pageview', properties: props });
  }

  /**
   * NOTE: `$group` currently has NO server-side semantics — the ingest pipeline does not
   * build account/group associations from it, so this records a plain event with the group
   * traits in properties and nothing more. Kept for API compatibility; don't rely on it for
   * B2B account rollups yet.
   */
  async group(userId: string, groupId: string, traits?: any, anonymousId?: string): Promise<void> {
    // 9.D.4: warn-and-drop, never throw.
    if (!groupId) {
      console.warn('[Datalyr] group() requires a groupId; call dropped.');
      this.notifyDrop([{ event: '$group', userId } as TrackEvent], 'validation_error');
      return;
    }
    return this.track({ userId, anonymousId, event: '$group', properties: { groupId, ...traits } });
  }

  /**
   * 9.D.6: purchase helper with a validated revenue amount. The ingest revenue pipeline
   * reads `value ?? revenue ?? amount` (in that order) — `value` is the canonical field —
   * so this stamps `value` and (defensively) requires it to be a FINITE number. A NaN /
   * Infinity / non-number value would land as $0 or corrupt revenue rollups, so it is
   * warned-and-dropped rather than sent. `opts` forwards eventId (webhook idempotency) and
   * timestamp (backdating) exactly like track().
   */
  async trackPurchase(
    userId: string | null,
    purchase: PurchaseProperties,
    opts?: { anonymousId?: string; eventId?: string; timestamp?: string | Date | number }
  ): Promise<void> {
    const value = purchase?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      console.warn('[Datalyr] trackPurchase() requires a finite numeric `value` (revenue amount); event dropped.');
      this.notifyDrop([{ event: 'purchase', userId: userId || undefined } as TrackEvent], 'validation_error');
      return;
    }
    return this.track({
      userId: userId || undefined,
      anonymousId: opts?.anonymousId,
      event: 'purchase',
      eventId: opts?.eventId,
      timestamp: opts?.timestamp,
      properties: { ...purchase, value, currency: (purchase.currency || 'USD').toUpperCase() }
    });
  }

  // 9.D.1 + B-4: caller-supplied idempotency key. Defensive by design — this SDK must never
  // crash the host — so anything that isn't a non-empty string is IGNORED (fresh uuid, same
  // as omitting it) with a debug warning, never a throw. An over-long id (pathological Redis
  // key server-side) is collapsed to a DETERMINISTIC sha256-based value so redeliveries of
  // the same id still map to the same key and dedup.
  private resolveEventId(provided: unknown): string {
    if (typeof provided === 'string' && provided.trim().length > 0) {
      if (provided.length > MAX_EVENT_ID_LENGTH) {
        // Keep a readable prefix for debugging, append a full sha256 (64 hex) so the result
        // is deterministic and unique per input, total 191 + 1 + 64 = 256 chars.
        const digest = createHash('sha256').update(provided).digest('hex');
        return provided.slice(0, MAX_EVENT_ID_LENGTH - 65) + '-' + digest;
      }
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
      const dropped = this.queue.shift(); // Remove oldest event
      // 9.D.7: overflow is a drop path — surface it so callers can persist to their own DLQ.
      if (dropped) this.notifyDrop([dropped], 'queue_overflow');
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
    // NODE-3 / TR-25: if a drain is already running, AWAIT it (return the in-flight promise)
    // rather than no-op'ing. Because the drain LOOPS until the queue empties, awaiting it now
    // also guarantees events enqueued AFTER it started are sent — fixing the serverless
    // `track(); track(); await flush(); return` bug where the second event stranded.
    if (this.isFlushing) {
      return this.currentFlush ?? Promise.resolve();
    }

    this.isFlushing = true;
    this.currentFlush = this._drain();
    try {
      await this.currentFlush;
    } finally {
      this.isFlushing = false;
      this.currentFlush = undefined;
    }
  }

  // TR-25: a single _flush pass snapshots the queue, so events enqueued during the pass — or
  // failures it re-queues — would strand on `await flush()`. Loop passes until the queue is
  // empty or a pass DELIVERS NOTHING (every event failed: a down endpoint re-queued/dropped
  // them all). Progress must be measured by successful sends, NOT queue length — a pass that
  // sends e1 while e2 arrives leaves the length unchanged yet clearly made progress. The
  // zero-progress break stops us hot-spinning against a down endpoint (the flush timer /
  // close() budget retries later); the hard cap is a belt-and-suspenders termination
  // guarantee if a producer keeps enqueuing during the drain.
  private async _drain(): Promise<void> {
    for (let pass = 0; this.queue.length > 0 && pass < MAX_FLUSH_ATTEMPTS + 2; pass++) {
      const sent = await this._flush();
      if (sent === 0) break;
    }
  }

  // Returns the number of events SUCCESSFULLY sent this pass (events.length − failed), so
  // _drain can tell real progress from a fully-failing endpoint (see _drain).
  private async _flush(): Promise<number> {
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
        this.sendEvent(event).catch((err: any) => {
          failed++;
          // 9.D.7: every send failure reaches onError before any drop/requeue decision.
          this.notifyError(event, err instanceof Error ? err : new Error(String(err)));

          // 9.D.8: a permanent client error (4xx ≠ 408/429 — bad key, malformed, forbidden)
          // will NEVER succeed on retry, so drop it IMMEDIATELY instead of cycling it 10
          // times. A wrong API key (401/403) black-holes everything, so raise it loudly ONCE
          // as an auth failure — the single most common "no data" support case.
          if (err && err.permanent) {
            if ((err.status === 401 || err.status === 403) && !this.warnedAuthFailure) {
              this.warnedAuthFailure = true;
              console.error(`[Datalyr] Authentication failing (HTTP ${err.status}) — check your API key ("dk_..."). Events are being dropped.`);
            }
            this.notifyDrop([event], 'permanent_client_error');
            return;
          }

          // NODE-8 / NODE-9 / NODE-10: bound re-queue attempts so a permanently-failing
          // (transient) event can't cycle at the front forever (re-failing every flush).
          // Count failed flush-cycles per event (WeakMap, no payload pollution); drop with a
          // VISIBLE warn after MAX_FLUSH_ATTEMPTS cycles. Re-queue at the front so failures
          // retry first.
          const n = (this.flushAttempts.get(event) || 0) + 1;
          this.flushAttempts.set(event, n);
          if (n >= MAX_FLUSH_ATTEMPTS) {
            console.warn(`[Datalyr] Dropping event after ${n} failed flush attempts: ${event.event}`);
            this.notifyDrop([event], 'max_flush_attempts');
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

    return events.length - failed;
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

        // 9.D.8: 408 (Request Timeout) and 429 (Too Many Requests) are TRANSIENT — retry
        // them like 5xx. Every other 4xx is a permanent client error: tag it so the flush
        // layer drops it immediately instead of cycling it MAX_FLUSH_ATTEMPTS times.
        if (response.status !== 408 && response.status !== 429 &&
            response.status >= 400 && response.status < 500) {
          const err: any = new Error(`Client error: ${response.status} ${response.statusText} - ${errorText}`);
          err.status = response.status;
          err.permanent = true;
          throw err;
        }

        // Retry on 5xx / 408 / 429 (transient)
        const err: any = new Error(`Server error: ${response.status} ${response.statusText} - ${errorText}`);
        err.status = response.status;
        throw err;
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
      // Don't retry permanent client errors (bad key/forbidden/malformed).
      if (error && error.permanent) {
        if (this.debug) {
          console.error('[Datalyr] Permanent error, not retrying:', error.message);
        }
        throw error;
      }

      // Retry server errors / network failures with exponential backoff
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

  // A cancelable delay: TR-09. Returns the promise AND a cancel() that clears the underlying
  // timer, so a Promise.race that settles via the OTHER arm doesn't leave a live (non-unref'd)
  // timer holding the event loop open until it fires — the exact hang the 1.3.0 unref work
  // fixed and the close() race timer had reintroduced.
  private delay(ms: number): { promise: Promise<void>; cancel: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
  }

  // Cleanup
  async close(): Promise<void> {
    // 9.D.3: idempotent — repeat or concurrent close() calls share ONE drain and never
    // restart it (a second close() must not re-run the loop or double-remove the exit hook).
    if (this.closePromise) return this.closePromise;
    this.closePromise = this._close();
    return this.closePromise;
  }

  private async _close(): Promise<void> {
    this.isClosing = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // NODE-1/2/4: actually DRAIN the queue. The old close() flushed ONCE and raced a hard
    // 5s timeout — one flush isn't enough (it re-queues failures), a no-op flush won if one
    // was in flight, and 5s < worst-case retry (~7s) dropped mid-retry events. Loop flush()
    // (which now drains until the queue empties instead of no-op'ing) until the queue drains
    // or the configurable closeTimeout budget expires.
    //
    // review H1/H2: each flush() runs the FULL per-event retry chain (retryLimit × timeout
    // + backoff) before returning, which would overshoot closeTimeout by multiples and hang
    // on a slow/unresponsive endpoint. So race each flush against the REMAINING budget — a
    // real wall-clock bound. An in-flight flush whose budget expires keeps running in the
    // background (best-effort delivery; it has its own .catch), so close() never blocks past
    // its budget.
    //
    // TR-09: the budget + pause timers are CANCELED when their race settles (this.delay), so
    // a won race never leaves a live timer pinning the event loop for up to closeTimeout ms
    // after close() resolved (proven: close resolved 14ms, process exited 8016ms).
    const start = Date.now();
    const deadline = start + this.closeTimeout;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const budget = this.delay(remaining);
      try {
        await Promise.race([
          this.flush().catch(() => {}),
          budget.promise,
        ]);
      } finally {
        budget.cancel();
      }
      // If events remain (failed + re-queued) and no flush is in flight, pause briefly so
      // we don't hot-loop against a still-failing endpoint (bounded by the deadline).
      if (this.queue.length > 0 && !this.isFlushing && Date.now() < deadline) {
        const pause = this.delay(Math.min(100, Math.max(0, deadline - Date.now())));
        try {
          await pause.promise;
        } finally {
          pause.cancel();
        }
      }
    }

    // review M2: stop leaking the beforeExit listener (+ the instance/queue it pins).
    if (this.exitHook) {
      try { process.removeListener('beforeExit', this.exitHook); } catch { /* noop */ }
      this.exitHook = undefined;
    }

    if (this.queue.length > 0) {
      const undelivered = [...this.queue];
      console.warn(`[Datalyr] close(): ${undelivered.length} event(s) undelivered after ~${Date.now() - start}ms (budget ${this.closeTimeout}ms).`);
      // 9.D.7: hand the survivors to onDrop so callers can persist them (their durability is
      // now the caller's — close() has given up on them).
      this.notifyDrop(undelivered, 'close_timeout');
    }
  }
}

export default Datalyr;
