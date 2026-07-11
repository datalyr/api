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

  // ---- 9.D.4: invalid args warn-and-drop, NEVER throw (was ERR_UNHANDLED_REJECTION exit 1) ----
  const sent94: any[] = []; mockFetch(sent94);
  const drops94: string[] = [];
  const dl94 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, onDrop: (_e, r) => drops94.push(r) });
  let threw94 = false;
  try {
    await dl94.track({ event: '' } as any);   // empty event name (options form)
    await dl94.track(null, '');               // empty event name (legacy form)
    await dl94.identify('' as any);           // missing userId
    await dl94.alias('' as any);              // missing newUserId
    await dl94.group('u', '' as any);         // missing groupId
  } catch { threw94 = true; }
  assert(!threw94, '9.D.4: invalid track/identify/alias/group never throw (no unhandled rejection)');
  assert(sent94.length === 0, '9.D.4: invalid calls send nothing');
  assert(drops94.filter((r) => r === 'validation_error').length === 5,
    `9.D.4: each of the 5 invalid calls fires onDrop('validation_error') (got ${drops94.filter((r) => r === 'validation_error').length})`);
  await dl94.close();

  // ---- 9.D.3: post-close track() drops + onDrop('closed'); close() is idempotent ----
  const sent93: any[] = []; mockFetch(sent93);
  const drops93: string[] = [];
  const dl93 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, onDrop: (_e, r) => drops93.push(r) });
  await dl93.track({ userId: 'u', event: 'before_close' });
  await dl93.close();
  await dl93.close(); // idempotent — must not throw or restart the drain
  await dl93.track({ userId: 'u', event: 'after_close' });
  assert(sent93.some((e) => e.event === 'before_close') && !sent93.some((e) => e.event === 'after_close'),
    '9.D.3: pre-close event delivered; post-close event dropped (not sent)');
  assert(drops93.includes('closed'), "9.D.3: post-close track() fires onDrop('closed')");

  // ---- 9.D.8: permanent 401 → sent ONCE, immediate drop, no 10-cycle requeue ----
  let calls401 = 0; const drops401: string[] = [];
  // Count only THIS test's event — an earlier bounded-close test (dl4) may still be running a
  // best-effort background flush against the shared global fetch; filtering keeps the count clean.
  (globalThis as any).fetch = async (_u: string, opts: any) => {
    if (JSON.parse(opts.body).event === 'bad_key') calls401++;
    return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' };
  };
  const dl401 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, retryLimit: 3, closeTimeout: 2000, onDrop: (_e, r) => drops401.push(r) });
  await dl401.track({ userId: 'u', event: 'bad_key' });
  await dl401.flush();
  assert(calls401 === 1, `9.D.8: permanent 401 sent exactly ONCE — no retry, no requeue (got ${calls401}; retry would be 4)`);
  assert(drops401.includes('permanent_client_error'), "9.D.8: 401 fires onDrop('permanent_client_error')");
  await dl401.close();
  assert(calls401 === 1, `9.D.8: 401 event not re-queued across close() either — still ${calls401} POST`);

  // ---- 9.D.8: 429 is TRANSIENT (retried like 5xx), NOT permanent ----
  let calls429 = 0;
  (globalThis as any).fetch = async (_u: string, opts: any) => {
    if (JSON.parse(opts.body).event === 'rate_limited') calls429++; // ignore stray background-flush calls
    return { ok: false, status: 429, statusText: 'Too Many', text: async () => '' };
  };
  const dl429 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, retryLimit: 1, closeTimeout: 1000 });
  await dl429.track({ userId: 'u', event: 'rate_limited' });
  await dl429.flush();
  assert(calls429 === 2, `9.D.8: 429 retried (retryLimit 1 → 2 attempts); permanent would stop at 1 (got ${calls429})`);
  await dl429.close();

  // ---- TR-25: await flush() drains events enqueued DURING an in-flight flush ----
  const sent25: any[] = [];
  let n25 = 0, releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((res) => { releaseFirst = res; });
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    n25++;
    if (n25 === 1) await firstGate; // hold the first send open so e2 enqueues mid-flush
    sent25.push(JSON.parse(opts.body));
    return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({}) };
  };
  const dl25 = new Datalyr({ apiKey: 'dk_test', flushAt: 1, flushInterval: 3_600_000 });
  void dl25.track({ userId: 'u', event: 'e1' }); // flushAt:1 → auto-flush; first send blocks on the gate
  void dl25.track({ userId: 'u', event: 'e2' }); // enqueued WHILE e1's flush is in flight
  const flush25 = dl25.flush();                   // must await the whole drain, not the e1-only snapshot
  releaseFirst();                                 // let e1 land; drain must then pick up e2
  await flush25;
  assert(sent25.some((e) => e.event === 'e1') && sent25.some((e) => e.event === 'e2'),
    'TR-25: await flush() delivers BOTH e1 and an event enqueued during the in-flight flush');
  await dl25.close();

  // ---- 9.D.7: queue overflow fires onDrop('queue_overflow') ----
  const dropsOv: string[] = [];
  (globalThis as any).fetch = () => new Promise(() => {}); // hang: first auto-flush never completes → queue refills past cap
  const dlOv = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, maxQueueSize: 100, timeout: 1000, onDrop: (_e, r) => dropsOv.push(r) });
  for (let i = 0; i < 260; i++) void dlOv.track({ userId: 'u', event: 'e' + i });
  assert(dropsOv.filter((r) => r === 'queue_overflow').length > 0,
    `9.D.7: enqueuing past maxQueueSize while a flush is stuck fires onDrop('queue_overflow') (got ${dropsOv.filter((r) => r === 'queue_overflow').length})`);
  // (dlOv left un-closed on purpose — its sends hang; process.exit at suite end reaps it.)

  // ---- B-4: over-long eventId is hash-collapsed — deterministic, ≤256, still dedups ----
  const sentB4: any[] = []; mockFetch(sentB4);
  const dlB4 = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000 });
  const longId = 'x'.repeat(5000);
  const longId2 = 'y'.repeat(5000);
  await dlB4.track({ userId: 'u', event: 'long_a', eventId: longId });
  await dlB4.track({ userId: 'u', event: 'long_a_again', eventId: longId }); // same long id (redelivery)
  await dlB4.track({ userId: 'u', event: 'long_b', eventId: longId2 });      // different long id
  await dlB4.flush();
  const wireA = sentB4.find((e) => e.event === 'long_a').eventId;
  const wireA2 = sentB4.find((e) => e.event === 'long_a_again').eventId;
  const wireB = sentB4.find((e) => e.event === 'long_b').eventId;
  assert(wireA.length <= 256, `B-4: over-long eventId clamped to ≤256 chars (got ${wireA.length})`);
  assert(wireA === wireA2, 'B-4: the SAME long eventId maps to the SAME wire id (redeliveries still dedup)');
  assert(wireA !== wireB, 'B-4: DIFFERENT long eventIds map to DIFFERENT wire ids (no collision)');
  await dlB4.close();

  // ---- 9.D.6: trackPurchase validates a finite numeric value ----
  const sentTP: any[] = []; mockFetch(sentTP);
  const dropsTP: string[] = [];
  const dlTP = new Datalyr({ apiKey: 'dk_test', flushAt: 100, flushInterval: 3_600_000, onDrop: (_e, r) => dropsTP.push(r) });
  await dlTP.trackPurchase('u', { value: 49.99, currency: 'usd' }, { eventId: 'order_1' });
  await dlTP.trackPurchase('u', { value: NaN as any });          // invalid → drop
  await dlTP.trackPurchase('u', { value: 'oops' as any });        // invalid → drop
  await dlTP.trackPurchase('u', {} as any);                       // missing value → drop
  await dlTP.flush();
  const purch = sentTP.filter((e) => e.event === 'purchase');
  assert(purch.length === 1 && purch[0].properties.value === 49.99 && purch[0].properties.currency === 'USD' && purch[0].eventId === 'order_1',
    '9.D.6: trackPurchase sends value+uppercased currency+eventId for a valid finite value');
  assert(dropsTP.filter((r) => r === 'validation_error').length === 3,
    `9.D.6: NaN/non-number/missing value each dropped (got ${dropsTP.filter((r) => r === 'validation_error').length})`);
  await dlTP.close();

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
