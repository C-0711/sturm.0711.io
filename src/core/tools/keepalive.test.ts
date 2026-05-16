/**
 * Tests for `KeepaliveWorker` — verifies the full circuit-breaker state
 * machine using a deterministic fake scheduler + controllable mock Pingable.
 *
 * Run: tsx src/core/tools/keepalive.test.ts
 */

import {
  KeepaliveWorker,
  type Pingable,
  type SchedulerLike,
  type StateChangeEvent,
} from './keepalive.ts';
import type { ToolHealth, ToolKind } from './types.ts';

// ── Test infrastructure ────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? undefined : { actual, expected });
}

interface FakeTimer {
  fireAt: number;
  handler: () => void;
  cancelled: boolean;
  id: number;
}

class FakeClock {
  private timers: FakeTimer[] = [];
  private nextId = 1;
  now = 0;

  scheduler: SchedulerLike = {
    setTimeout: (handler: () => void, ms: number): unknown => {
      const t: FakeTimer = {
        fireAt: this.now + ms,
        handler,
        cancelled: false,
        id: this.nextId++,
      };
      this.timers.push(t);
      return t;
    },
    clearTimeout: (handle: unknown): void => {
      const t = handle as FakeTimer | null;
      if (t) t.cancelled = true;
    },
  };

  nowFn = (): number => this.now;

  /**
   * Advance virtual time by `ms`, firing any timers whose fireAt falls in
   * the window. Repeats until no more eligible timers exist so that
   * cascade-scheduled timers (e.g. from .finally()) also fire.
   */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    // Allow any microtasks queued from prior synchronous work to drain first.
    await flushMicrotasks();
    while (true) {
      const next = this.timers
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!next) break;
      this.now = next.fireAt;
      next.cancelled = true;
      this.timers = this.timers.filter((t) => t !== next);
      next.handler();
      // Drain microtasks scheduled by the handler (including .finally chains).
      await flushMicrotasks();
    }
    this.now = target;
  }

  /** Fire the soonest pending timer regardless of distance. */
  async fireNext(): Promise<void> {
    const next = this.timers
      .filter((t) => !t.cancelled)
      .sort((a, b) => a.fireAt - b.fireAt)[0];
    if (!next) return;
    this.now = next.fireAt;
    next.cancelled = true;
    this.timers = this.timers.filter((t) => t !== next);
    next.handler();
    await flushMicrotasks();
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

async function flushMicrotasks(): Promise<void> {
  // A handful of awaits drains nested microtask chains in our worker
  // (await target.health → .finally → scheduleNext, etc).
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

type Outcome =
  | { type: 'alive'; latencyMs?: number }
  | { type: 'down'; lastError?: string }
  | { type: 'throw'; message: string }
  | { type: 'hang' };

class MockPingable implements Pingable {
  readonly name = 'mock-tool';
  readonly kind: ToolKind = 'mcp';
  outcome: Outcome = { type: 'alive', latencyMs: 1 };
  callCount = 0;

  async health(signal?: AbortSignal): Promise<ToolHealth> {
    this.callCount += 1;
    const out = this.outcome;
    if (out.type === 'alive') {
      return {
        name: this.name, kind: this.kind, configured: true, alive: true,
        latencyMs: out.latencyMs ?? 1,
      };
    }
    if (out.type === 'down') {
      return {
        name: this.name, kind: this.kind, configured: true, alive: false,
        lastError: out.lastError ?? 'down',
      };
    }
    if (out.type === 'throw') {
      throw new Error(out.message);
    }
    // hang: resolve only when aborted.
    return new Promise<ToolHealth>((_, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

console.log('\n=== 1. Boot ping fires immediately ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    scheduler: clock.scheduler, now: clock.nowFn,
  });
  w.start();
  await flushMicrotasks();
  assert('health() called exactly once after start()', target.callCount === 1);
  assert('circuit is closed', w.circuit === 'closed');
  assert('available is true', w.available === true);
  w.stop();
}

console.log('\n=== 2. Closed stays closed on success ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    scheduler: clock.scheduler, now: clock.nowFn,
  });
  const events: StateChangeEvent[] = [];
  w.start();
  await flushMicrotasks();
  // Re-attach listener after start by recreating? We attached via opts:
  // Actually we did not — recreate with onStateChange.
  w.stop();

  const w2 = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    scheduler: clock.scheduler, now: clock.nowFn,
    onStateChange: (e) => events.push(e),
  });
  target.callCount = 0;
  w2.start();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) {
    await clock.advance(1000);
  }
  assert('5 pings observed', target.callCount === 5);
  assert('circuit remains closed', w2.circuit === 'closed');
  assert('no state-change events', events.length === 0);
  w2.stop();
}

console.log('\n=== 3. N failures open the circuit ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  target.outcome = { type: 'down', lastError: 'ECONNREFUSED' };
  const events: StateChangeEvent[] = [];
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 3, cooldownMs: 10_000 },
    scheduler: clock.scheduler, now: clock.nowFn,
    onStateChange: (e) => events.push(e),
  });
  w.start();
  await flushMicrotasks();
  // Boot ping = 1st failure.
  await clock.advance(1000); // 2nd failure
  await clock.advance(1000); // 3rd failure → open
  assert('circuit open after 3 failures', w.circuit === 'open');
  assert('available is false', w.available === false);
  assert('one state-change event', events.length === 1);
  eq('event from→to', { from: events[0].from, to: events[0].to }, { from: 'closed', to: 'open' });
  assert('event names tool', events[0].name === 'mock-tool');
  assert('reason mentions failure threshold', /threshold/i.test(events[0].reason));
  w.stop();
}

console.log('\n=== 4. Cooldown → half-open (before probe result) ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  target.outcome = { type: 'down', lastError: 'ECONNREFUSED' };
  const events: StateChangeEvent[] = [];
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 3, cooldownMs: 10_000 },
    scheduler: clock.scheduler, now: clock.nowFn,
    onStateChange: (e) => events.push(e),
  });
  // Set up hang for the probe so we can observe half-open BEFORE result.
  w.start();
  await flushMicrotasks();
  await clock.advance(1000);
  await clock.advance(1000);
  // Now open.
  target.outcome = { type: 'hang' };
  // Cooldown is 10_000ms; the worker scheduled its next tick at cooldownMs
  // after entering open. Advance the clock past the cooldown.
  await clock.advance(10_000);
  // The probe is now in-flight (hanging). State should be half-open BEFORE
  // we observe the result.
  assert('circuit transitioned to half-open during probe',
    w.circuit === 'half-open',
    { circuit: w.circuit, events });
  const halfOpenEv = events.find((e) => e.to === 'half-open');
  assert('half-open state-change emitted', !!halfOpenEv);
  if (halfOpenEv) eq('half-open from', halfOpenEv.from, 'open');
  w.stop();
}

console.log('\n=== 5. Half-open success → closed ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  target.outcome = { type: 'down', lastError: 'down' };
  const events: StateChangeEvent[] = [];
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 2, cooldownMs: 5_000, successThreshold: 1 },
    scheduler: clock.scheduler, now: clock.nowFn,
    onStateChange: (e) => events.push(e),
  });
  w.start();
  await flushMicrotasks();           // boot fail #1
  await clock.advance(1000);         // fail #2 → open
  assert('open after 2 failures', w.circuit === 'open');
  // Make next probe succeed.
  target.outcome = { type: 'alive', latencyMs: 5 };
  await clock.advance(5_000);        // cooldown elapses → half-open probe runs → closes
  assert('back to closed after good probe', w.circuit === 'closed');
  // Events: closed→open, open→half-open, half-open→closed.
  const types = events.map((e) => `${e.from}→${e.to}`);
  eq('event sequence', types, ['closed→open', 'open→half-open', 'half-open→closed']);
  w.stop();
}

console.log('\n=== 6. Half-open failure → open, cooldown restarts ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  target.outcome = { type: 'down', lastError: 'down' };
  const events: StateChangeEvent[] = [];
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 2, cooldownMs: 5_000, successThreshold: 1 },
    scheduler: clock.scheduler, now: clock.nowFn,
    onStateChange: (e) => events.push(e),
  });
  w.start();
  await flushMicrotasks();        // fail #1
  await clock.advance(1000);      // fail #2 → open
  const openedFirstAt = clock.now;
  // Probe still fails.
  await clock.advance(5_000);     // half-open → fail → reopen
  assert('reopened after failed probe', w.circuit === 'open');
  const reopenEv = events.filter((e) => e.to === 'open');
  assert('two open events recorded', reopenEv.length === 2);
  assert('second open reason mentions probe',
    /probe/i.test(reopenEv[1].reason),
    { reason: reopenEv[1].reason });

  // Cooldown should restart from the reopen time. Advance just under cooldown.
  // The next tick is scheduled at cooldownMs after the reopen.
  const beforeReopenCalls = target.callCount;
  await clock.advance(4_999);
  assert('no probe before cooldown elapses',
    target.callCount === beforeReopenCalls,
    { before: beforeReopenCalls, after: target.callCount });
  // One more ms past the cooldown should fire the probe.
  await clock.advance(2);
  assert('probe fires after cooldown elapses',
    target.callCount === beforeReopenCalls + 1);
  // Reset suppression — clock.now since first open should now be > 2*cooldownMs.
  void openedFirstAt;
  w.stop();
}

console.log('\n=== 7. Idempotent start ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    scheduler: clock.scheduler, now: clock.nowFn,
  });
  w.start();
  w.start();
  w.start();
  await flushMicrotasks();
  assert('only one boot ping despite triple start', target.callCount === 1);
  await clock.advance(1000);
  assert('only one ping per interval', target.callCount === 2);
  w.stop();
}

console.log('\n=== 8. Stop is safe before start ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    scheduler: clock.scheduler, now: clock.nowFn,
  });
  let threw = false;
  try { w.stop(); } catch { threw = true; }
  assert('stop() before start() does not throw', !threw);
  await flushMicrotasks();
  assert('no pings happened', target.callCount === 0);
  assert('no pending timers', clock.pendingCount() === 0);
}

console.log('\n=== 9. Timeout enforcement ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  target.outcome = { type: 'hang' };
  const healths: ToolHealth[] = [];
  const w = new KeepaliveWorker(target, {
    intervalMs: 10_000, timeoutMs: 500,
    breaker: { failureThreshold: 99 }, // don't open during this test
    scheduler: clock.scheduler, now: clock.nowFn,
    onHealth: (h) => healths.push(h),
  });
  w.start();
  await flushMicrotasks();
  // Boot ping is hanging; advance past the timeout.
  await clock.advance(500);
  assert('one health observation recorded', healths.length === 1);
  assert('observed health.alive === false', healths[0].alive === false);
  assert('lastError mentions timeout',
    !!healths[0].lastError && /timeout/i.test(healths[0].lastError),
    { lastError: healths[0].lastError });
  w.stop();
}

console.log('\n=== 10. onHealth fires on every ping (success + failure) ===');
{
  const clock = new FakeClock();
  const target = new MockPingable();
  const healths: ToolHealth[] = [];
  const w = new KeepaliveWorker(target, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 99 },
    scheduler: clock.scheduler, now: clock.nowFn,
    onHealth: (h) => healths.push(h),
  });
  w.start();
  await flushMicrotasks();        // boot: success
  target.outcome = { type: 'down', lastError: 'oops' };
  await clock.advance(1000);      // failure
  target.outcome = { type: 'alive' };
  await clock.advance(1000);      // success
  assert('three health observations', healths.length === 3,
    { len: healths.length, healths });
  eq('alive flags sequence',
    healths.map((h) => h.alive),
    [true, false, true]);
  // Every snapshot should carry a circuit field.
  assert('every health has circuit field',
    healths.every((h) => h.circuit === 'closed' || h.circuit === 'open' || h.circuit === 'half-open'));
  w.stop();
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
