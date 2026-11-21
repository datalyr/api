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
    advance(90_000); // 150 s in all: past 120 s plus up to 20% jitter
    const r2: any = await dl.flush();
    assert(accepted === 1 && r2 && r2.unsent === 0, `Retry-After: sent once the 120 s (plus jitter) pass (accepted ${accepted}, ${JSON.stringify(r2)})`);
    await dl.close();
  }

  // ---- 401/403 are final (the server answers 503 for its own faults): sent once, dropped, counted ----
  {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
      for (const status of [401, 403]) {
        let calls = 0;
        (globalThis as any).fetch = async () => { calls++; return answer(status); };
        const drops: string[] = [];
        const dl = new Datalyr({ ...base, retryLimit: 3, onDrop: (_e, r) => drops.push(r) });
        await dl.track({ userId: 'u', event: 'auth_' + status + '_a' });
        await dl.track({ userId: 'u', event: 'auth_' + status + '_b' });
        await dl.flush();
        advance(61_000);
        await dl.flush();
        assert(calls === 2 && drops.length === 2 && drops.every((r) => r === 'auth_refused'),
          `${status}: final, each event sent once and dropped as auth_refused (attempts ${calls}, drops ${JSON.stringify(drops)})`);
        const st = (dl as any).getStats?.();
        assert(st?.droppedByReason?.auth_refused === 2, `${status}: counted under auth_refused (got ${JSON.stringify(st?.droppedByReason)})`);
        await dl.close();
      }
      const authLines = warnings.filter((w) => /auth_refused=2/.test(w));
      assert(authLines.length === 2, `one summary line per client for its auth drops, not one per event (got ${JSON.stringify(authLines)})`);
    } finally {
      console.warn = realWarn;
    }
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

  // ---- A long outage with a steady sender never holds more than maxQueueSize; every eviction counted ----
  {
    let peak = 0, calls = 0;
    let dlRef: any;
    (globalThis as any).fetch = async () => {
      calls++;
      const st = dlRef.getStats();
      peak = Math.max(peak, st.queued + st.inFlight);
      return answer(503);
    };
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const dl = new Datalyr({ ...base, flushAt: 20, maxQueueSize: 100, retryLimit: 0 });
      dlRef = dl;
      let tracked = 0, worst = 0;
      for (let round = 0; round < 30; round++) {
        for (let i = 0; i < 20; i++) { await dl.track({ userId: 'u', event: `steady_${round}_${i}` }); tracked++; }
        await dl.flush();
        const st = (dl as any).getStats();
        worst = Math.max(worst, st.queued + st.inFlight);
        advance(61_000);
      }
      const st = (dl as any).getStats();
      assert(worst <= 100 && peak <= 100,
        `steady sender, 30-minute 503 outage: queued + in flight never above the cap of 100 (worst after a flush ${worst}, peak during sends ${peak})`);
      assert(st.droppedByReason.queue_overflow + st.queued + st.inFlight === tracked && st.dropped === st.droppedByReason.queue_overflow,
        `every event is either held or counted as queue_overflow (${tracked} tracked, ${st.queued + st.inFlight} held, ${st.droppedByReason.queue_overflow} evicted)`);
      await dl.close();
    } finally {
      console.warn = realWarn;
    }
  }

  // ---- Temporary failures longer than maxRetryDuration: dropped as max_flush_attempts, counted ----
  {
    let calls = 0;
    (globalThis as any).fetch = async () => { calls++; return answer(503); };
    const drops: string[] = [];
    const dl = new Datalyr({ ...base, retryLimit: 0, maxRetryDuration: 60_000, onDrop: (_e, r) => drops.push(r) } as any);
    await dl.track({ userId: 'u', event: 'expires' });
    await dl.flush();
    advance(30_000);
    await dl.flush();
    assert(drops.length === 0, `maxRetryDuration: still kept after 30 s of a 60 s window (drops ${JSON.stringify(drops)})`);
    advance(31_000);
    await dl.flush();
    assert(calls === 3 && drops.length === 1 && drops[0] === 'max_flush_attempts',
      `maxRetryDuration: dropped as max_flush_attempts once the window passed (attempts ${calls}, drops ${JSON.stringify(drops)})`);
    assert((dl as any).getStats().droppedByReason.max_flush_attempts === 1, 'maxRetryDuration: the drop is counted');
    await dl.close();
  }

  // ---- A malformed Retry-After is ignored: normal backoff, then delivered ----
  {
    const stamps: number[] = [];
    (globalThis as any).fetch = async () => {
      stamps.push(realNow());
      return stamps.length === 1 ? answer(503, { 'Retry-After': 'soon' }) : answer(200);
    };
    const dl = new Datalyr({ ...base, retryLimit: 1 });
    await dl.track({ userId: 'u', event: 'retry_after_bad' });
    const r: any = await dl.flush();
    const gap = stamps.length >= 2 ? stamps[1] - stamps[0] : -1;
    assert(stamps.length === 2 && gap >= 400 && gap < 1500 && r.unsent === 0,
      `Retry-After: soon is ignored: retried after the normal 0.5-1 s backoff and delivered (gap ${gap} ms, ${JSON.stringify(r)})`);
    await dl.close();
  }

  // ---- close() waits out a backoff (Retry-After: 2) and delivers instead of dropping ----
  {
    const stamps: number[] = [];
    (globalThis as any).fetch = async () => {
      stamps.push(realNow());
      return stamps.length === 1 ? answer(503, { 'Retry-After': '2' }) : answer(200);
    };
    const drops: string[] = [];
    const dl = new Datalyr({ ...base, retryLimit: 0, closeTimeout: 10_000, onDrop: (_e, r) => drops.push(r) });
    await dl.track({ userId: 'u', event: 'close_waits' });
    await dl.flush();
    const c: any = await dl.close();
    const gap = stamps.length >= 2 ? stamps[1] - stamps[0] : -1;
    assert(stamps.length === 2 && gap >= 1950 && c.unsent === 0 && drops.length === 0,
      `close() waits out the 2 s Retry-After, then delivers (gap ${gap} ms, ${JSON.stringify(c)}, drops ${JSON.stringify(drops)})`);
  }

  // ---- The queue cap: drops are counted, readable, and logged as ONE summary line ----
  {
    (globalThis as any).fetch = () => new Promise(() => {}); // a send that never settles
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    const dl = new Datalyr({ ...base, maxQueueSize: 100, timeout: 1000, flushTimeout: 1000, closeTimeout: 1000 } as any);
    try {
      // The first 100 are taken by the auto-flush (stuck in flight). Queued + in flight is
      // already at the cap of 100 and nothing is queued to evict, so the 260 that follow are dropped.
      for (let i = 0; i < 360; i++) void dl.track({ userId: 'u', event: 'e' + i });
      const t0 = realNow();
      const res = await within(dl.flush() as Promise<any>, 4000);
      const elapsed = realNow() - t0;
      assert(res.done && elapsed < 2500, `flush() returns within flushTimeout while sends hang (${res.done ? elapsed + ' ms' : 'did not return in 4 s'})`);
      assert(res.done && res.value && res.value.unsent === 100,
        `flush() says how many are unsent: 100 in flight (got ${JSON.stringify(res.value)})`);
      const stats = (dl as any).getStats?.();
      assert(!!stats && stats.droppedByReason.queue_overflow === 260 && stats.dropped === 260,
        `getStats() counts the 260 events the cap dropped (got ${JSON.stringify(stats)})`);
      assert(!!stats && stats.queued === 0 && stats.inFlight === 100,
        `getStats() shows 0 queued and 100 in flight (got ${stats && JSON.stringify({ q: stats.queued, f: stats.inFlight })})`);
      const capLines = warnings.filter((w) => /queue/i.test(w) && /dropped/i.test(w));
      assert(capLines.length === 1 && capLines[0].includes('260'),
        `one summary line for the cap, with the count, never one per event (got ${JSON.stringify(capLines)})`);
      // Nothing new dropped: the next report says nothing.
      await within(dl.flush() as Promise<any>, 4000);
      assert(warnings.filter((w) => /queue/i.test(w) && /dropped/i.test(w)).length === 1,
        'the summary line is not repeated when nothing new was dropped');

      // close() is bounded too and says how many it could not send.
      const c = await within(dl.close() as Promise<any>, 4000);
      assert(c.done && c.value && c.value.unsent === 100,
        `close() returns within closeTimeout and says 100 left unsent (got ${JSON.stringify(c.value)})`);
    } finally {
      console.warn = realWarn;
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
