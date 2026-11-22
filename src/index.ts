import { randomUUID, createHash } from 'node:crypto';

/** Why an event was dropped, passed to the onDrop hook. */
export type DropReason =
  | 'validation_error'   // track/identify/alias/group called with invalid args
  | 'queue_overflow'     // queued + in flight reached maxQueueSize; oldest queued evicted
  | 'permanent_client_error' // a final 4xx other than 401/403 (400, 413, ...), dropped at once
  | 'auth_refused'       // 401/403: the key was refused (final; counted apart from other 4xx, )
  | 'max_flush_attempts' // temporary failures lasted longer than maxRetryDuration (; the name is kept for compatibility)
  | 'close_timeout'      // still queued when close()'s closeTimeout budget expired
  | 'closed';            // track() called after close()

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
  /** max ms an explicit `await flush()` waits for sends and their retries. Default
   *  30000. Events not delivered by then stay queued and are retried later; flush() resolves
   *  with `{ unsent }`. */
  flushTimeout?: number;
  /** how long (ms) an event that keeps failing with a temporary error (5xx, 503,
   *  429, 408, timeout, network error) is kept and retried before it is dropped with reason
   *  `max_flush_attempts`. Default 3600000 (1 hour); at most 24 hours. */
  maxRetryDuration?: number;
  /** called for every send failure (before any retry/requeue/drop decision), so you
   *  can log/alert on delivery problems. Never throws into the SDK — exceptions are swallowed. */
  onError?: (event: TrackEvent, error: Error) => void;
  /** called whenever event(s) are permanently dropped, with the reason. Covers ALL
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
  externalIds?: Record<string, string>;
}

export interface TrackOptions {
  userId?: string;
  anonymousId?: string;
  event: string;
  properties?: Record<string, any>;
  /** Idempotency key for this event. The ingest server de-duplicates on it (7-day window),
   *  so pass a stable id from your source system — e.g. the Stripe webhook `event.id` —
   *  and at-least-once webhook redeliveries won't double-count. Must be a non-empty
   *  string; anything else is ignored (a random UUID is generated, as when omitted). */
  eventId?: string;
  /** When the event actually happened. Accepts an ISO-8601 string, a Date, or a numeric
   *  epoch (milliseconds; values < 1e12 are interpreted as epoch SECONDS, e.g. Stripe's
   *  `event.created`). Defaults to now. Invalid values are ignored (defaults to now) —
   *  pass this on delayed webhook replays so the event lands on the right day. */
  timestamp?: string | Date | number;
  /** Declared external identity namespaces (Datalyr person contract ):
   *  `{ namespace: id }`, e.g. `{ stripe: 'cus_123', crm: 'acct_9' }`. Use this for
   *  ANY identifier that is not the same userId your client-side identify() uses —
   *  internal database ids, provider customer ids, private namespaces. Declared ids
   *  join the customer journey the moment the same namespace value is bound to an
   *  account identifier from any producer. Do NOT put private ids in `userId` or
   *  `anonymousId` — they cannot join there and the workspace health surface will
   *  flag them as an unjoined namespace. */
  externalIds?: Record<string, string>;
}

/** what flush() and close() report. `unsent` = events queued or still in flight
 *  when the call returned (for close(), these are the events it gave up on). */
export interface FlushResult {
  unsent: number;
}

/** delivery counters, read with `getStats()`. Counts are since construction. */
export interface DatalyrStats {
  /** Events waiting in memory, including those waiting out a backoff. */
  queued: number;
  /** Events taken by a send that has not settled yet. */
  inFlight: number;
  /** Every event dropped so far, all reasons. */
  dropped: number;
  droppedByReason: Record<DropReason, number>;
}

/** the revenue payload for trackPurchase(). `value` is required and must be a finite
 *  number (the server reads value ?? revenue ?? amount — value is the canonical field). */
export interface PurchaseProperties {
  value: number;
  currency?: string;
  [key: string]: any;
}

// use node:crypto randomUUID unconditionally (GA since Node 14.17). The old
// global-`crypto` guard fell back to a weak Math.random id on Node <19, and eventId is
// the SERVER dedup key — a collision there is silent data loss.
function generateEventId(): string {
  return randomUUID();
}

// A FRESH anonymous id, generated PER CALL — never a shared instance value. This is the
// fix for a single long-lived server process tracking many distinct end-users
// must not stamp them all with one anonymous_id (which the ingest identity-resolution
// then cross-links into one merged identity, leaking traits across users).
function generateAnonymousId(): string {
  return 'anon_' + randomUUID();
}

const SDK_VERSION = '1.3.4'; // keep in sync with package.json

// Hard cap on drain passes per flush (a producer that keeps enqueuing during a drain must
// not keep one flush running forever).
const MAX_DRAIN_PASSES = 12;

// what the ingest worker's answers mean (datalyr-v2 infra/cloudflare/ingest,
// handleServerTrack). 2xx = stored (or a duplicate of an id it already has). 400, 405, 413,
// 415 = this exact request can never succeed: final. 401/403 = a key a healthy lookup refused:
// final too, because the worker answers 503 (not 401) when its own key check fails
// (INGEST_OWN_FAULT_503). 408, 429, every 5xx (503 + Retry-After is the worker's "my own
// fault, send it again"), a timeout or a network error = temporary: keep the event and retry.
// Backoff between failed cycles for one event: 1s, 2s, 4s ... capped at 60s, jittered.
const MAX_CYCLE_BACKOFF_MS = 60_000;
// A Retry-After longer than this is not waited out inside one send's quick retries; the event
// goes back to the queue and is not sent again before the time the server named.
const MAX_INLINE_WAIT_MS = 10_000;
// Never wait longer than this for one Retry-After, whatever the server says.
const MAX_RETRY_AFTER_MS = 5 * 60_000;

const ALL_DROP_REASONS: DropReason[] = [
  'validation_error', 'queue_overflow', 'permanent_client_error', 'auth_refused', 'max_flush_attempts', 'close_timeout', 'closed',
];
// Reasons the periodic summary line reports. The others already log at the call
// (validation_error, closed) or in close()'s own line (close_timeout).
const SUMMARY_REASONS: DropReason[] = ['queue_overflow', 'permanent_client_error', 'auth_refused', 'max_flush_attempts'];

// Spread retries that a Retry-After would otherwise line up on the same instant.
function jitterUp(ms: number): number {
  return ms * (1 + Math.random() * 0.2);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d+$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    const at = Date.parse(v);
    if (!Number.isFinite(at)) return undefined;
    ms = at - Date.now();
  }
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

/** A 4xx the server means as final (everything except 408 and 429). */
function isFinalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

interface RetryState {
  firstFailedAt: number;
  failures: number;
  notBefore: number;
}

// cap the caller-supplied eventId. Longer ids become pathological Redis keys server-side;
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
  private flushTimeout: number;
  private maxRetryDuration: number;
  private timer?: NodeJS.Timeout;
  private isFlushing: boolean = false;
  private isClosing: boolean = false;
  private closeFinished = false;         // close() has given up; a late transient failure is dropped, not re-queued
  private currentFlush?: Promise<void>;  // the in-flight drain — callers/close() await this instead of getting a no-op
  private closePromise?: Promise<FlushResult>;  // memoized so close() is idempotent under repeat/concurrent calls
  private warnedNoId = false;            // one-time warn for calls with neither userId nor anonymousId
  private warnedClosed = false;          // one-time loud error for track() after close()
  private warnedAuthFailure = false;     // one-time loud error for 401/403
  private retryState = new WeakMap<TrackEvent, RetryState>(); // per-event retry clock; WeakMap → no payload pollution
  private inFlight = 0;                  // events taken from the queue by a pass and not settled yet
  private nextSeq = 0;                   // arrival order, so the cap always evicts the oldest
  private seqOf = new WeakMap<TrackEvent, number>();
  private droppedByReason: Record<DropReason, number> = Object.fromEntries(ALL_DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>;
  private reportedByReason: Record<DropReason, number> = Object.fromEntries(ALL_DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>;
  private exitHook?: () => void;         // the beforeExit listener (stored so close() can remove it — review M2)
  private onError?: (event: TrackEvent, error: Error) => void; // 
  private onDrop?: (events: TrackEvent[], reason: DropReason) => void; // 

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
      this.flushTimeout = 30000;
      this.maxRetryDuration = 3_600_000;
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
      this.flushTimeout = config.flushTimeout ?? 30000;
      this.maxRetryDuration = config.maxRetryDuration ?? 3_600_000;
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
    // flushInterval was never validated — 0/negative/NaN makes setInterval
    // busy-loop. (The `|| 10000` above only catches 0/undefined, not negatives.)
    if (!(this.flushInterval >= 1000)) this.flushInterval = 10000;
    if (this.flushInterval > 3_600_000) this.flushInterval = 3_600_000;
    if (!(this.closeTimeout >= 1000)) this.closeTimeout = 30000;
    if (this.closeTimeout > 120_000) this.closeTimeout = 120_000;
    if (!(this.flushTimeout >= 1000)) this.flushTimeout = 30000;
    if (this.flushTimeout > 120_000) this.flushTimeout = 120_000;
    if (!(this.maxRetryDuration >= 60_000)) this.maxRetryDuration = this.maxRetryDuration < 60_000 ? 60_000 : 3_600_000;
    // At most 24 h, well inside the server's dedup window (DEDUP_TTL_SECONDS, 7 days): a retry
    // after it could store twice an event whose earlier attempt the server did accept.
    if (this.maxRetryDuration > 86_400_000) this.maxRetryDuration = 86_400_000;
    // retryLimit: `?? 3` above preserves an explicit 0 (no retries); clamp negatives/NaN.
    if (!(this.retryLimit >= 0)) this.retryLimit = 3;
    if (this.retryLimit > 10) this.retryLimit = 10;

    // best-effort drain on process exit (short scripts/cron/serverless that
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
      this.startDrain()?.catch(() => {});
    };
    process.once('beforeExit', this.exitHook);
  }

  // fan a drop/error out to the caller's observability hook. A hook that throws must
  // never crash the SDK (the whole point is defensive delivery), so swallow its exceptions.
  private notifyDrop(events: TrackEvent[], reason: DropReason): void {
    this.droppedByReason[reason] += events.length; // every drop is counted, hook or not
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
    let providedExternalIds: Record<string, string> | undefined;

    if (typeof userIdOrOptions === 'object' && userIdOrOptions !== null) {
      // TrackOptions signature
      userId = userIdOrOptions.userId;
      eventName = userIdOrOptions.event;
      eventProperties = userIdOrOptions.properties || {};
      providedAnonymousId = userIdOrOptions.anonymousId;
      providedEventId = userIdOrOptions.eventId;
      providedTimestamp = userIdOrOptions.timestamp;
      providedExternalIds = userIdOrOptions.externalIds;
    } else {
      // Legacy signature: (userId, event, properties)
      userId = userIdOrOptions || undefined;
      eventName = event!;
      eventProperties = properties || {};
    }

    // NEVER throw. An invalid event name from deep in caller business logic used to
    // throw out of this fire-and-forget promise → an ERR_UNHANDLED_REJECTION that crashed
    // the host process (exit 1). Warn, hand it to onDrop, and resolve.
    if (!eventName || typeof eventName !== 'string') {
      console.warn('[Datalyr] track() requires a non-empty string event name; event dropped.');
      this.notifyDrop([{ event: String(eventName ?? ''), userId } as TrackEvent], 'validation_error');
      return;
    }

    // close() is terminal. Post-close track() used to drop silently (debug-only). Emit
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

    // use the caller-provided anonymousId, else a FRESH one per call — NEVER a
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
      // Person contract : declared namespaces ride the envelope top-level;
      // the ingest worker classifies + preserves them for identity joining.
      ...(providedExternalIds && typeof providedExternalIds === 'object'
        ? { externalIds: providedExternalIds } : {}),
      // honor a caller-supplied eventId VERBATIM — it is the ingest server's dedup
      // key (7-day window), so webhook handlers can pass the source event id (e.g. Stripe
      // `event.id`) and at-least-once redeliveries no longer double-count revenue. A fresh
      // uuid per call (the old unconditional behavior) made every redelivery look new.
      eventId: this.resolveEventId(providedEventId),
      event: eventName,
      properties: enrichedProperties,
      context: {
        library: '@datalyr/api',
        version: SDK_VERSION,
        source: 'api',
        schema_version: 1 // versioned-envelope stamp
      },
      // honor a caller-supplied timestamp (ingest reads `event.timestamp || now`),
      // so delayed webhook replays land on the day the event happened, not the replay day.
      timestamp: this.resolveTimestamp(providedTimestamp)
    };

    this.enqueue(trackEvent);
  }

  async identify(userId: string, traits?: any, anonymousId?: string): Promise<void> {
    // warn-and-drop, never throw (see track()).
    if (!userId) {
      console.warn('[Datalyr] identify() requires a userId; call dropped.');
      this.notifyDrop([{ event: '$identify' } as TrackEvent], 'validation_error');
      return;
    }
    // Route through the options form so a caller-provided anonymousId is honored.
    // track() stamps anonymous_id itself — no need to inject the (formerly shared) one.
    // Traits stay flat (not wrapped in $set) so the user-properties-updater extracts them.
    return this.track({ userId, anonymousId, event: '$identify', properties: { ...traits } });
  }

  async alias(newUserId: string, previousId?: string, anonymousId?: string): Promise<void> {
    // warn-and-drop, never throw.
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
    // warn-and-drop, never throw.
    if (!groupId) {
      console.warn('[Datalyr] group() requires a groupId; call dropped.');
      this.notifyDrop([{ event: '$group', userId } as TrackEvent], 'validation_error');
      return;
    }
    return this.track({ userId, anonymousId, event: '$group', properties: { groupId, ...traits } });
  }

  /**
   * purchase helper with a validated revenue amount. The ingest revenue pipeline
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

  // + caller-supplied idempotency key. Defensive by design — this SDK must never
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

  // caller-supplied event time, normalized to ISO-8601. Accepts ISO string, Date,
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
    // Memory cap. / queued + in flight never exceeds maxQueueSize. The oldest
    // QUEUED event is evicted; when every held event is in flight, the new one is dropped.
    // Every eviction is counted (getStats()) and reported as ONE summary line per flush
    // cycle, never per event. each also reaches onDrop.
    this.seqOf.set(event, this.nextSeq++);
    if (this.queue.length + this.inFlight >= this.maxQueueSize) {
      const dropped = this.queue.length > 0 ? this.queue.shift()! : event;
      this.retryState.delete(dropped);
      this.notifyDrop([dropped], 'queue_overflow');
      if (dropped === event) return;
    }

    this.queue.push(event);

    if (this.debug) {
      console.log('[Datalyr] Event queued:', event.event);
    }

    if (this.queue.length >= this.flushAt) {
      // Don't await to avoid blocking
      this.startDrain()?.catch(err => {
        if (this.debug) {
          console.error('[Datalyr] Auto-flush error:', err);
        }
      });
    }
  }

  /**
   * Send what is queued and wait, up to `flushTimeout` (default 30 s), for those sends and
   * their quick retries. Resolves with `{ unsent }`: events still queued (for example waiting
   * out a backoff or a Retry-After) or still in flight. Those are kept and retried later; they
   * are not dropped. When anything is left unsent, one line says how many.
   */
  async flush(): Promise<FlushResult> {
    // / / startDrain() returns the drain already running (even when the
    // queue is empty because an auto-flush took the events) instead of no-op'ing, and the
    // drain loops so events enqueued meanwhile are sent too.
    await this.drainWithin(this.flushTimeout);
    this.reportDrops();
    const unsent = this.pendingCount();
    if (unsent > 0) {
      console.warn(`[Datalyr] flush(): ${unsent} event(s) not delivered yet; kept in memory and retried later.`);
    }
    return { unsent };
  }

  /** delivery counters. `dropped` and `droppedByReason` count since construction. */
  getStats(): DatalyrStats {
    const droppedByReason = { ...this.droppedByReason };
    const dropped = ALL_DROP_REASONS.reduce((n, r) => n + droppedByReason[r], 0);
    return { queued: this.queue.length, inFlight: this.inFlight, dropped, droppedByReason };
  }

  private pendingCount(): number {
    return this.queue.length + this.inFlight;
  }

  private notBefore(event: TrackEvent): number {
    return this.retryState.get(event)?.notBefore ?? 0;
  }

  private hasReady(): boolean {
    const now = Date.now();
    return this.queue.some((e) => this.notBefore(e) <= now);
  }

  private earliestReadyAt(): number {
    let earliest = Infinity;
    for (const e of this.queue) earliest = Math.min(earliest, this.notBefore(e));
    return earliest;
  }

  // The running drain, or a new one when an event is ready to send; undefined when nothing
  // is running and nothing is ready.
  private startDrain(): Promise<void> | undefined {
    if (this.isFlushing) return this.currentFlush;
    if (!this.hasReady()) return undefined;
    this.isFlushing = true;
    this.currentFlush = this._drain().finally(() => {
      this.isFlushing = false;
      this.currentFlush = undefined;
    });
    return this.currentFlush;
  }

  // Wait for the drain, but never longer than `ms`. A drain still running when the bound
  // expires keeps going in the background (it has its own catch), so the caller is bounded.
  private async drainWithin(ms: number): Promise<void> {
    const drain = this.startDrain();
    if (!drain) return;
    const budget = this.delay(ms);
    try {
      await Promise.race([drain.catch(() => {}), budget.promise]);
    } finally {
      budget.cancel();
    }
  }

  // one line for the drops since the last report, never one per event.
  private reportDrops(): void {
    const parts: string[] = [];
    let total = 0;
    for (const r of SUMMARY_REASONS) {
      const n = this.droppedByReason[r] - this.reportedByReason[r];
      if (n > 0) { parts.push(`${r}=${n}`); total += n; }
      this.reportedByReason[r] = this.droppedByReason[r];
    }
    if (total === 0) return;
    const hint = this.droppedByReason.queue_overflow > 0
      ? ` Queue cap is ${this.maxQueueSize}: increase maxQueueSize, or flush() more often.`
      : '';
    console.warn(`[Datalyr] ${total} event(s) dropped since the last report (${parts.join(', ')}); getStats() has the totals.${hint}`);
  }

  // a single _flush pass snapshots the ready events, so events enqueued during the
  // pass would strand on `await flush()`. Loop passes until nothing is ready or a pass
  // DELIVERS NOTHING (every event failed: a down endpoint). Progress is measured by
  // successful sends, not queue length. A failed event waits out its backoff before it is
  // ready again, so this never hot-spins; the hard cap guarantees termination when a
  // producer keeps enqueuing during the drain.
  private async _drain(): Promise<void> {
    for (let pass = 0; this.hasReady() && pass < MAX_DRAIN_PASSES; pass++) {
      const sent = await this._flush();
      if (sent === 0) break;
    }
  }

  // Returns the number of events SUCCESSFULLY sent this pass, so _drain can tell real
  // progress from a fully-failing endpoint.
  private async _flush(): Promise<number> {
    // Take the events that are ready; leave those waiting out a backoff in the queue.
    const now = Date.now();
    const events: TrackEvent[] = [];
    const waiting: TrackEvent[] = [];
    for (const e of this.queue) (this.notBefore(e) <= now ? events : waiting).push(e);
    this.queue = waiting;
    this.inFlight += events.length;

    if (this.debug) {
      console.log(`[Datalyr] Flushing ${events.length} events`);
    }

    // this is a CONCURRENCY window (10 events in parallel), NOT a single batched
    // HTTP request — one POST per event. (Real payload batching is gated on the ingest
    // `/batch` endpoint, currently disabled.)
    const batchSize = 10;
    let failed = 0;

    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      const promises = batch.map(event =>
        this.sendEvent(event).then(
          () => { this.inFlight--; this.retryState.delete(event); },
          (err: any) => {
            // Settled: no longer in flight before the keep/drop decision (the cap counts it again if kept).
            this.inFlight--;
            failed++;
            this.handleFailure(event, err);
          })
      );
      await Promise.allSettled(promises);
    }

    if (failed > 0 && this.debug) {
      console.error(`[Datalyr] ${failed} events failed to send this flush`);
    }

    return events.length - failed;
  }

  // keep or drop one event whose send (with its quick retries) failed. The event
  // object itself goes back to the queue, so every later attempt sends the SAME eventId.
  private handleFailure(event: TrackEvent, err: any): void {
    // every send failure reaches onError before any drop/requeue decision.
    this.notifyError(event, err instanceof Error ? err : new Error(String(err)));

    // A final 4xx (malformed, too large, wrong method, refused key) can never succeed: drop at once.
    if (err && err.permanent) {
      this.retryState.delete(event);
      if (err.auth) {
        // a wrong key black-holes everything; say so loudly, once.
        if (!this.warnedAuthFailure) {
          this.warnedAuthFailure = true;
          console.error(`[Datalyr] Authentication failing (HTTP ${err.status}) — check your API key ("dk_..."). Events are being dropped.`);
        }
        this.notifyDrop([event], 'auth_refused');
      } else {
        this.notifyDrop([event], 'permanent_client_error');
      }
      return;
    }

    // a send still running when close()'s budget expired is not in the queue, so
    // close() could not report it. Re-queueing would strand it on a closed client.
    if (this.closeFinished) {
      this.retryState.delete(event);
      this.notifyDrop([event], 'close_timeout');
      return;
    }

    const now = Date.now();
    const state = this.retryState.get(event) ?? { firstFailedAt: now, failures: 0, notBefore: 0 };
    state.failures++;

    if (now - state.firstFailedAt >= this.maxRetryDuration) {
      this.retryState.delete(event);
      this.notifyDrop([event], 'max_flush_attempts');
      return;
    }

    // Back off before this event is sent again: 1s, 2s, 4s ... 60s with jitter, and never
    // before the time a Retry-After named.
    const backoff = Math.min(1000 * Math.pow(2, state.failures - 1), MAX_CYCLE_BACKOFF_MS) * (0.5 + Math.random() * 0.5);
    const retryAfter = typeof err?.retryAfterMs === 'number' ? jitterUp(err.retryAfterMs) : 0;
    state.notBefore = now + Math.max(backoff, retryAfter);
    this.retryState.set(event, state);
    // Back in arrival order, so the oldest go first and the cap evicts the oldest.
    const seq = this.seqOf.get(event) ?? -1;
    let at = this.queue.length;
    while (at > 0 && (this.seqOf.get(this.queue[at - 1]) ?? -1) > seq) at--;
    this.queue.splice(at, 0, event);
    // a re-queued event counts against the cap like a new one.
    while (this.queue.length + this.inFlight > this.maxQueueSize && this.queue.length > 0) {
      const evicted = this.queue.shift()!;
      this.retryState.delete(evicted);
      this.notifyDrop([evicted], 'queue_overflow');
    }
  }

  private async sendEvent(event: TrackEvent, retryCount = 0): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // clear the abort timer on settle (success OR reject). A fetch rejection
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
        const status = response.status;
        let retryAfter: string | null | undefined;
        try { retryAfter = response.headers?.get?.('Retry-After'); } catch { retryAfter = undefined; }

        // A final 4xx: never retried.
        if (isFinalStatus(status)) {
          const err: any = new Error(`Client error: ${status} ${response.statusText} - ${errorText}`);
          err.status = status;
          err.permanent = true;
          err.auth = status === 401 || status === 403; // dropped as auth_refused
          throw err;
        }
        // 408 / 429 / 5xx: temporary.
        const err: any = new Error(`Server error: ${status} ${response.statusText} - ${errorText}`);
        err.status = status;
        err.retryAfterMs = parseRetryAfterMs(retryAfter);
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
      // Final answers are decided by the flush layer, never retried here.
      if (error && error.permanent) {
        if (this.debug) {
          console.error('[Datalyr] Not retrying now:', error.message);
        }
        throw error;
      }

      // Temporary (5xx / 408 / 429 / timeout / network): quick retries with backoff.
      if (retryCount < this.retryLimit) {
        const retryAfterMs: number | undefined = error?.retryAfterMs;
        // A Retry-After too long to wait out here: hand the event back to the queue, which
        // will not send it before that time.
        if (retryAfterMs !== undefined && retryAfterMs > MAX_INLINE_WAIT_MS) throw error;
        if (this.debug) {
          console.log(`[Datalyr] Retrying event (attempt ${retryCount + 1}/${this.retryLimit})`);
        }
        // full jitter so many SDK instances don't retry in lockstep against a
        // recovering server; never sooner than the server's Retry-After.
        const backoffMs = Math.min(Math.pow(2, retryCount) * 1000, 10000); // Max 10s
        const jittered = backoffMs * (0.5 + Math.random() * 0.5);
        await new Promise(resolve => setTimeout(resolve, Math.max(jittered, retryAfterMs === undefined ? 0 : jitterUp(retryAfterMs))));
        return this.sendEvent(event, retryCount + 1);
      }

      throw error;
    }
  }

  private startFlushTimer(): void {
    this.timer = setInterval(() => {
      if (!this.isClosing) {
        this.reportDrops();
        this.startDrain()?.catch(err => {
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
   * Generate a NEW anonymous id. there is no longer a shared process-wide anon
   * (that merged distinct users). Each call returns a fresh id — persist it in YOUR
   * per-user/session store and pass it back as `anonymousId` to stitch that user's
   * events. (Behavior change from <=1.2.3, which returned one shared id.)
   */
  getAnonymousId(): string {
    return generateAnonymousId();
  }

  // A cancelable delay: . Returns the promise AND a cancel() that clears the underlying
  // timer, so a Promise.race that settles via the OTHER arm doesn't leave a live (non-unref'd)
  // timer holding the event loop open until it fires — the exact hang the 1.3.0 unref work
  // fixed and the close() race timer had reintroduced.
  private delay(ms: number): { promise: Promise<void>; cancel: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
  }

  /**
   * Stop the timer and drain, waiting for sends, their retries and any backoff, up to
   * `closeTimeout`. Terminal and idempotent. Resolves with `{ unsent }`: the events it gave
   * up on (queued ones go to onDrop('close_timeout') now; ones still in flight are delivered
   * or reach onDrop when their send settles).
   */
  async close(): Promise<FlushResult> {
    // idempotent — repeat or concurrent close() calls share ONE drain and never
    // restart it (a second close() must not re-run the loop or double-remove the exit hook).
    if (this.closePromise) return this.closePromise;
    this.closePromise = this._close();
    return this.closePromise;
  }

  private async _close(): Promise<FlushResult> {
    this.isClosing = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // /2/4: actually DRAIN the queue. The old close() flushed ONCE and raced a hard
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
    // the budget + pause timers are CANCELED when their race settles (this.delay), so
    // a won race never leaves a live timer pinning the event loop for up to closeTimeout ms
    // after close() resolved (proven: close resolved 14ms, process exited 8016ms).
    //
    // also loop while a drain is in flight with an EMPTY queue (an auto-flush already
    // took the events). startDrain() returns that drain, so close() waits for its sends — and
    // their onDrop/onError — instead of resolving at ~0ms.
    const start = Date.now();
    const deadline = start + this.closeTimeout;
    while ((this.queue.length > 0 || this.isFlushing) && Date.now() < deadline) {
      await this.drainWithin(deadline - Date.now());
      // events remain but none is ready (each is waiting out its backoff or a
      // Retry-After) and nothing is in flight: wait until the first is ready, bounded by the
      // deadline, instead of hot-looping or sending early.
      if (this.queue.length > 0 && !this.isFlushing && Date.now() < deadline) {
        const until = Math.max(this.earliestReadyAt(), Date.now() + 10);
        const pause = this.delay(Math.max(0, Math.min(until, deadline) - Date.now()));
        try {
          await pause.promise;
        } finally {
          pause.cancel();
        }
      }
    }

    this.closeFinished = true;

    // review M2: stop leaking the beforeExit listener (+ the instance/queue it pins).
    if (this.exitHook) {
      try { process.removeListener('beforeExit', this.exitHook); } catch { /* noop */ }
      this.exitHook = undefined;
    }

    this.reportDrops();
    const unsent = this.pendingCount();
    if (unsent > 0) {
      console.warn(`[Datalyr] close(): ${unsent} event(s) undelivered after ~${Date.now() - start}ms (budget ${this.closeTimeout}ms): ${this.queue.length} queued, ${this.inFlight} still in flight.`);
    }
    if (this.queue.length > 0) {
      const undelivered = [...this.queue];
      this.queue = [];
      // hand the survivors to onDrop so callers can persist them (their durability is
      // now the caller's — close() has given up on them).
      this.notifyDrop(undelivered, 'close_timeout');
    }
    return { unsent };
  }
}

export default Datalyr;
