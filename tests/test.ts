// Functional tests for the Node SDK. Mocks global fetch (no real network) and asserts
// the 1.2.4 fixes. Run with: node tests/test.ts  (Node 23+ strips types).
import { Datalyr } from '../src/index.ts';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('PASS  ' + msg); }
  else { failures++; console.error('FAIL  ' + msg); }
}

function mockFetch(into: any[]) {
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    into.push(JSON.parse(opts.body));
    return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({}) };
  };
}

async function main() {
  // ---- NODE-6: distinct users get DISTINCT anonymous ids (no shared/merged identity) ----
  const sent: any[] = [];
  mockFetch(sent);
  const dl = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000 });

  await dl.track({ userId: 'userA', event: 'a' });
  await dl.track({ userId: 'userB', event: 'b' });
  await dl.track({ anonymousId: 'anon_provided_xyz', event: 'c' });
  await dl.track({ event: 'anon_only_1' });   // no userId, no anonymousId → fresh anon (+ one-time warn)
  await dl.track({ event: 'anon_only_2' });
  await dl.identify('userX', { email: 'x@y.com' }, 'anon_for_x');
  await dl.flush();

  const byEvent = (n: string) => sent.find((e) => e.event === n);
  assert(sent.length === 6, 'all 6 events sent on flush()');
  assert(!!byEvent('a').anonymousId && byEvent('a').anonymousId !== byEvent('b').anonymousId,
    'NODE-6: two identified users get DISTINCT anonymousIds (not one shared/merged id)');
  assert(byEvent('c').anonymousId === 'anon_provided_xyz',
    'NODE-6: a caller-provided anonymousId is honored on track()');
  assert(byEvent('anon_only_1').anonymousId !== byEvent('anon_only_2').anonymousId,
    'NODE-6: two id-less anonymous calls get DISTINCT fresh anonymousIds (no cross-link)');
  assert(byEvent('$identify').anonymousId === 'anon_for_x',
    'NODE-6: identify() honors a caller-provided anonymousId');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(byEvent('a').eventId),
    'NODE-13: eventId is a crypto.randomUUID (not the weak Math.random fallback)');
  await dl.close();

  // ---- NODE-1/2/3: close() actually DRAINS the queue ----
  const sent2: any[] = [];
  mockFetch(sent2);
  const dl2 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000 });
  for (let i = 0; i < 5; i++) await dl2.track({ userId: 'u' + i, event: 'evt' + i });
  assert(sent2.length === 0, 'events sit queued (flushAt not reached), nothing sent yet');
  await dl2.close();
  assert(sent2.length === 5, 'NODE-1/2: close() drained all 5 queued events');

  // ---- NODE-1/4: close() drains even when the FIRST attempts fail (re-queue + retry) ----
  let calls = 0;
  const sent3: any[] = [];
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    calls++;
    if (calls <= 2) return { ok: false, status: 503, statusText: 'Server Error', text: async () => 'down' };
    sent3.push(JSON.parse(opts.body));
    return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
  };
  const dl3 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, retryLimit: 1, closeTimeout: 10_000 });
  await dl3.track({ userId: 'u', event: 'survives' });
  await dl3.close();
  assert(sent3.some((e) => e.event === 'survives'),
    'NODE-1/4: close() keeps draining until the event lands despite early 503s');

  // ---- review H1: close() is bounded by closeTimeout even with a slow + failing endpoint ----
  (globalThis as any).fetch = async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { ok: false, status: 503, statusText: 'down', text: async () => '' };
  };
  const dl4 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, retryLimit: 3, closeTimeout: 1000 });
  await dl4.track({ userId: 'u', event: 'never_lands' });
  const t0 = Date.now();
  await dl4.close();
  const elapsed = Date.now() - t0;
  assert(elapsed < 2500,
    `review H1: close() bounded by closeTimeout (~1s) despite slow+failing endpoint — took ${elapsed}ms (was 5–12s+ before)`);

  // ---- alias() emits the camelCase keys the ingest $alias link builder actually reads ----
  const sentA: any[] = [];
  mockFetch(sentA);
  const dla = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000 });
  await dla.alias('new_user', 'prev_anon');
  await dla.flush();
  const aliasEvt = sentA.find((e) => e.event === '$alias');
  assert(!!aliasEvt && aliasEvt.properties.previousId === 'prev_anon' && aliasEvt.properties.userId === 'new_user',
    'alias(): emits camelCase previousId/userId (the keys ingest reads to write the link)');
  await dla.close();

  // ---- review M3: retryLimit:0 is honored (not coerced to 3 by `|| 3`) ----
  let calls0 = 0;
  (globalThis as any).fetch = async () => { calls0++; return { ok: false, status: 503, statusText: 'x', text: async () => '' }; };
  const dl0 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, retryLimit: 0, closeTimeout: 1000 });
  await dl0.track({ userId: 'u', event: 'e' });
  await dl0.flush();
  assert(calls0 === 1, `review M3: retryLimit:0 honored — 1 attempt, no retries (got ${calls0}; would be 4 if coerced to 3)`);
  await dl0.close();

  // ---- 9.D.1: caller-supplied eventId is the wire event id (webhook idempotency) ----
  const sentE: any[] = [];
  mockFetch(sentE);
  const dle = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000 });
  await dle.track({ userId: 'u1', event: 'purchase', eventId: 'evt_stripe_123' });
  await dle.track({ userId: 'u1', event: 'purchase', eventId: 'evt_stripe_123' }); // redelivery
  await dle.track({ userId: 'u1', event: 'no_id_given' });
  await dle.track({ userId: 'u1', event: 'bad_id_number', eventId: 42 as any });
  await dle.track({ userId: 'u1', event: 'bad_id_empty', eventId: '' as any });
  await dle.flush();
  const byEvt = (n: string) => sentE.filter((e) => e.event === n);
  assert(byEvt('purchase').length === 2 &&
    byEvt('purchase')[0].eventId === 'evt_stripe_123' && byEvt('purchase')[1].eventId === 'evt_stripe_123',
    '9.D.1: caller eventId used VERBATIM — a redelivery carries the SAME wire event id (server dedups)');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert(uuidRe.test(byEvt('no_id_given')[0].eventId),
    '9.D.1: omitted eventId still gets a random UUID (behavior unchanged)');
  assert(uuidRe.test(byEvt('bad_id_number')[0].eventId) && uuidRe.test(byEvt('bad_id_empty')[0].eventId),
    '9.D.1: non-string/empty eventId is IGNORED (uuid fallback, no throw)');

  // ---- 9.D.5: caller-supplied timestamp is honored (delayed webhook replays) ----
  const iso = '2026-07-01T12:34:56.000Z';
  await dle.track({ userId: 'u1', event: 'ts_iso', timestamp: iso });
  await dle.track({ userId: 'u1', event: 'ts_date', timestamp: new Date(iso) });
  await dle.track({ userId: 'u1', event: 'ts_epoch_seconds', timestamp: 1751373296 }); // Stripe event.created style
  await dle.track({ userId: 'u1', event: 'ts_epoch_ms', timestamp: 1751373296000 });
  await dle.track({ userId: 'u1', event: 'ts_invalid', timestamp: 'not a date' as any });
  await dle.flush();
  const one = (n: string) => sentE.find((e) => e.event === n);
  assert(one('ts_iso').timestamp === iso, '9.D.5: ISO-string timestamp honored');
  assert(one('ts_date').timestamp === iso, '9.D.5: Date timestamp honored');
  assert(one('ts_epoch_seconds').timestamp === new Date(1751373296 * 1000).toISOString(),
    '9.D.5: epoch-seconds timestamp (e.g. Stripe event.created) interpreted as seconds');
  assert(one('ts_epoch_ms').timestamp === new Date(1751373296000).toISOString(),
    '9.D.5: epoch-milliseconds timestamp honored');
  assert(Math.abs(Date.parse(one('ts_invalid').timestamp) - Date.now()) < 60_000,
    '9.D.5: invalid timestamp ignored — falls back to now (no throw)');
  await dle.close();

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
