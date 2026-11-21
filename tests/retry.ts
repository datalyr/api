// FX-047 piece 1: keep events on temporary failures, honour Retry-After, count what the
// queue cap drops, and bound flush()/close(). Mocks global fetch (no real network) and
// moves Date.now forward instead of sleeping through backoff. Run with: node tests/retry.ts
//
// What the ingest worker answers on POST /track (datalyr-v2 infra/cloudflare/ingest/index.js
// handleServerTrack, main ef756fd42, pinned by infra/cloudflare/tests/ingest-answer-contract.test.js):
//   200                  stored, or a duplicate of an event id it already has (success:false)
//   400 / 405 / 413      malformed body, missing event name or identity, wrong method, too large: final
//   401                  no key, over-long key, or a key a healthy lookup refused: final
//   429 + Retry-After: 1 over 1,000 requests a second for one key: try again
//   500                  queue outage or unexpected error (the dedup claim is released): try again
//   503 + Retry-After: 5 its own database failed while checking the key (INGEST_OWN_FAULT_503 on)
import { Datalyr } from '../src/index.ts';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('PASS  ' + msg); }
  else { failures++; console.error('FAIL  ' + msg); }
}

// Move the SDK's clock without waiting. Timers (setTimeout) still run on real time.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms: number) => { clockOffset += ms; };

const KEY = 'dk_test_not_a_real_key';
const base = { apiKey: KEY, flushAt: 100, flushInterval: 3_600_000 };

function answer(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: new Headers(headers), text: async () => '', json: async () => ({}),
  };
}

// Resolve a promise or give up after `ms` (the pre-fix flush() could hang forever).
async function within<T>(p: Promise<T>, ms: number): Promise<{ done: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: boolean }>((r) => { timer = setTimeout(() => r({ done: false }), ms); });
  try {
    return await Promise.race([p.then((value) => ({ done: true, value })), timeout]);
  } finally { if (timer) clearTimeout(timer); }
}

async function main() {
  // ---- A long outage of every temporary kind loses nothing; every attempt carries the SAME id ----
  {
    const bodies: any[] = [];
    let calls = 0, accepted = 0;
    const kinds = ['503', '500', '429', 'timeout', 'network', '502'];
    const failingCalls = 14; // more than the 10 flush cycles after which 1.3.4 deleted the event
    (globalThis as any).fetch = async (_u: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      const kind = calls < failingCalls ? kinds[calls % kinds.length] : 'ok';
      calls++;
      if (kind === 'ok') { accepted++; return answer(200); }
      if (kind === '503') return answer(503, { 'Retry-After': '5' });
      if (kind === '429') return answer(429, { 'Retry-After': '1' });
      if (kind === 'timeout') {
        // Wait for the SDK's own abort, the way a real fetch fails on a timeout.
        return await new Promise((_res, rej) => opts.signal.addEventListener('abort', () => {
          rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        }));
      }
      if (kind === 'network') throw new TypeError('fetch failed');
      return answer(Number(kind));
    };
    const drops: string[] = [];
    const dl = new Datalyr({ ...base, retryLimit: 0, timeout: 1000, onDrop: (_e, r) => drops.push(r) });
    await dl.track({ userId: 'u', event: 'purchase', properties: { value: 10 } });
    // One flush a simulated minute: a 15-minute outage, far past the old 10-cycle cut-off.
    for (let i = 0; i <= failingCalls; i++) {
      await dl.flush();
      advance(61_000);
    }
    assert(accepted === 1, `outage: the event is delivered once the server recovers (accepted ${accepted}, attempts ${calls})`);
    assert(drops.length === 0, `outage: nothing dropped during a 503/500/429/timeout/network/502 outage (got ${JSON.stringify(drops)})`);
    const ids = new Set(bodies.map((b) => b.eventId));
    assert(bodies.length === failingCalls + 1 && ids.size === 1,
      `outage: all ${bodies.length} attempts carry the SAME event id (distinct ids: ${ids.size})`);
    // After a 2xx the event is gone: more flushes send nothing.
    const before = calls;
    await dl.flush(); advance(61_000); await dl.flush();
    assert(calls === before, `outage: an accepted event is never sent again (calls ${before} -> ${calls})`);
    await dl.close();
  }

  // ---- A short Retry-After is honoured before the next quick retry; same id ----
  {
    const stamps: number[] = [];
    const ids: string[] = [];
    (globalThis as any).fetch = async (_u: string, opts: any) => {
      stamps.push(realNow());
      ids.push(JSON.parse(opts.body).eventId);
      return stamps.length === 1 ? answer(503, { 'Retry-After': '2' }) : answer(200);
    };
    const dl = new Datalyr({ ...base, retryLimit: 1 });
    await dl.track({ userId: 'u', event: 'retry_after_short' });
    await dl.flush();
    const gap = stamps.length >= 2 ? stamps[1] - stamps[0] : -1;
    assert(stamps.length === 2 && gap >= 1950,
      `Retry-After: 2 waits at least 2 s before the retry (gap ${gap} ms; 1.3.4 waited 0.5-1 s)`);
    assert(ids.length === 2 && ids[0] === ids[1], 'Retry-After: the retry carries the same event id');
    await dl.close();
  }

  // ---- Retry-After as an HTTP date is honoured too ----
  {
    const stamps: number[] = [];
    (globalThis as any).fetch = async () => {
      stamps.push(realNow());
      return stamps.length === 1
        ? answer(503, { 'Retry-After': new Date(Date.now() + 3000).toUTCString() })
        : answer(200);
    };
    const dl = new Datalyr({ ...base, retryLimit: 1 });
    await dl.track({ userId: 'u', event: 'retry_after_date' });
    await dl.flush();
    const gap = stamps.length >= 2 ? stamps[1] - stamps[0] : -1;
    assert(stamps.length === 2 && gap >= 1950, `Retry-After as an HTTP date (3 s ahead) is waited out (gap ${gap} ms)`);
    await dl.close();
  }

  // ---- A long Retry-After is not retried early; the event is kept, then sent ----
  {
    let calls = 0, accepted = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) return answer(429, { 'Retry-After': '120' });
      accepted++;
      return answer(200);
    };
    const dl = new Datalyr({ ...base, retryLimit: 3 });
    await dl.track({ userId: 'u', event: 'retry_after_long' });
    const r1: any = await dl.flush();
    assert(calls === 1, `Retry-After: 120 is not retried inside the same flush (attempts ${calls}; 1.3.4 made 4)`);
    assert(r1 && r1.unsent === 1, `Retry-After: flush() says 1 event is left unsent (got ${JSON.stringify(r1)})`);
    advance(60_000);
    await dl.flush();
    assert(calls === 1, `Retry-After: still not retried 60 s later (attempts ${calls})`);
    advance(61_000);
    const r2: any = await dl.flush();
    assert(accepted === 1 && r2 && r2.unsent === 0, `Retry-After: sent once the 120 s pass (accepted ${accepted}, ${JSON.stringify(r2)})`);
    await dl.close();
  }

  // ---- 401/403 are kept for 10 minutes (a key check can fail for a moment), then dropped ----
  {
    let calls = 0;
    (globalThis as any).fetch = async () => { calls++; return answer(401); };
    const drops: string[] = [];
    const dl = new Datalyr({ ...base, retryLimit: 3, onDrop: (_e, r) => drops.push(r) });
    await dl.track({ userId: 'u', event: 'auth_blip' });
    await dl.flush();
    assert(calls === 1 && drops.length === 0, `401: sent once per cycle and kept, not dropped (attempts ${calls}, drops ${JSON.stringify(drops)})`);
    advance(5 * 60_000);
    await dl.flush();
    assert(calls === 2 && drops.length === 0, `401: still kept after 5 minutes (attempts ${calls}, drops ${JSON.stringify(drops)})`);
    advance(6 * 60_000);
    await dl.flush();
    assert(drops.length === 1 && drops[0] === 'permanent_client_error',
      `401: dropped as permanent_client_error once 10 minutes have passed (drops ${JSON.stringify(drops)})`);
    assert((dl as any).getStats?.().droppedByReason?.permanent_client_error === 1, '401: the drop is counted');
    await dl.close();

    // A 403 that clears: delivered with the same id.
    const ids: string[] = [];
    (globalThis as any).fetch = async (_u: string, opts: any) => {
      ids.push(JSON.parse(opts.body).eventId);
      return ids.length === 1 ? answer(403) : answer(200);
    };
    const drops2: string[] = [];
    const dl2 = new Datalyr({ ...base, onDrop: (_e, r) => drops2.push(r) });
    await dl2.track({ userId: 'u', event: 'auth_recovers' });
    await dl2.flush();
    advance(61_000);
    await dl2.flush();
    assert(ids.length === 2 && ids[0] === ids[1] && drops2.length === 0,
      `403 then 200: delivered on the retry with the same id, nothing dropped (attempts ${ids.length})`);
    await dl2.close();
  }

  // ---- Final answers drop at once: 400 and 413 are sent once and never again ----
  {
    for (const status of [400, 413]) {
      let calls = 0;
      (globalThis as any).fetch = async () => { calls++; return answer(status); };
      const drops: string[] = [];
      const dl = new Datalyr({ ...base, retryLimit: 3, onDrop: (_e, r) => drops.push(r) });
      await dl.track({ userId: 'u', event: 'final_' + status });
      await dl.flush();
      advance(61_000);
      await dl.flush();
      assert(calls === 1 && drops.length === 1 && drops[0] === 'permanent_client_error',
        `${status}: final, sent once and dropped as permanent_client_error (attempts ${calls}, drops ${JSON.stringify(drops)})`);
      await dl.close();
    }
  }

  // ---- The queue cap: drops are counted, readable, and logged as ONE summary line ----
  {
    (globalThis as any).fetch = () => new Promise(() => {}); // a send that never settles
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    const dl = new Datalyr({ ...base, maxQueueSize: 100, timeout: 1000, flushTimeout: 1000, closeTimeout: 1000 } as any);
    try {
      // The first 100 are taken by the auto-flush (stuck in flight); 260 more refill a 100 cap.
      for (let i = 0; i < 360; i++) void dl.track({ userId: 'u', event: 'e' + i });
      const t0 = realNow();
      const res = await within(dl.flush() as Promise<any>, 4000);
      const elapsed = realNow() - t0;
      assert(res.done && elapsed < 2500, `flush() returns within flushTimeout while sends hang (${res.done ? elapsed + ' ms' : 'did not return in 4 s'})`);
      assert(res.done && res.value && res.value.unsent === 200,
        `flush() says how many are unsent: 100 queued + 100 in flight (got ${JSON.stringify(res.value)})`);
      const stats = (dl as any).getStats?.();
      assert(!!stats && stats.droppedByReason.queue_overflow === 160 && stats.dropped === 160,
        `getStats() counts the 160 events the cap dropped (got ${JSON.stringify(stats)})`);
      assert(!!stats && stats.queued === 100 && stats.inFlight === 100,
        `getStats() shows 100 queued and 100 in flight (got ${stats && JSON.stringify({ q: stats.queued, f: stats.inFlight })})`);
      const capLines = warnings.filter((w) => /queue/i.test(w) && /dropped/i.test(w));
      assert(capLines.length === 1 && capLines[0].includes('160'),
        `one summary line for the cap, with the count, never one per event (got ${JSON.stringify(capLines)})`);
      // Nothing new dropped: the next report says nothing.
      await within(dl.flush() as Promise<any>, 4000);
      assert(warnings.filter((w) => /queue/i.test(w) && /dropped/i.test(w)).length === 1,
        'the summary line is not repeated when nothing new was dropped');

      // close() is bounded too and says how many it could not send.
      const c = await within(dl.close() as Promise<any>, 4000);
      assert(c.done && c.value && c.value.unsent === 200,
        `close() returns within closeTimeout and says 200 left unsent (got ${JSON.stringify(c.value)})`);
    } finally {
      console.warn = realWarn;
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
