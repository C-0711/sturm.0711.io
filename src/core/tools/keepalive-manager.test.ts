/**
 * Tests for `KeepaliveManager` — add/startAll/stopAll, snapshot fan-out,
 * onStateChange subscribe/unsubscribe.
 *
 * Run: tsx src/core/tools/keepalive-manager.test.ts
 */

import { KeepaliveManager } from './keepalive-manager.ts';
import type { Pingable, SchedulerLike, StateChangeEvent } from './keepalive.ts';
import type { ToolHealth, ToolKind } from './types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// Minimal fake clock — same shape as keepalive.test.ts.
interface FakeTimer { fireAt: number; handler: () => void; cancelled: boolean; }
class FakeClock {
  private timers: FakeTimer[] = [];
  now = 0;
  scheduler: SchedulerLike = {
    setTimeout: (handler, ms) => {
      const t: FakeTimer = { fireAt: this.now + ms, handler, cancelled: false };
      this.timers.push(t);
      return t;
    },
    clearTimeout: (h) => { const t = h as FakeTimer | null; if (t) t.cancelled = true; },
  };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
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
      await flushMicrotasks();
    }
    this.now = target;
  }
}
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

class FakePingable implements Pingable {
  callCount = 0;
  alive = true;
  constructor(readonly name: string, readonly kind: ToolKind = 'mcp') {}
  async health(): Promise<ToolHealth> {
    this.callCount += 1;
    return {
      name: this.name, kind: this.kind, configured: true,
      alive: this.alive,
      lastError: this.alive ? undefined : 'down',
    };
  }
}

console.log('\n=== add / startAll / stopAll ===');
{
  const clock = new FakeClock();
  const mgr = new KeepaliveManager();
  const a = new FakePingable('alpha');
  const b = new FakePingable('beta', 'llm');
  mgr.add(a, { intervalMs: 1000, timeoutMs: 100, scheduler: clock.scheduler, now: clock.nowFn });
  mgr.add(b, { intervalMs: 1000, timeoutMs: 100, scheduler: clock.scheduler, now: clock.nowFn });
  assert('size = 2', mgr.size === 2);
  mgr.startAll();
  await flushMicrotasks();
  assert('alpha booted', a.callCount === 1);
  assert('beta booted', b.callCount === 1);
  await mgr.stopAll();
  const aBefore = a.callCount;
  const bBefore = b.callCount;
  await clock.advance(5000);
  assert('alpha did not tick after stopAll', a.callCount === aBefore);
  assert('beta did not tick after stopAll', b.callCount === bBefore);
}

console.log('\n=== duplicate add throws ===');
{
  const mgr = new KeepaliveManager();
  const a = new FakePingable('alpha');
  mgr.add(a);
  let threw = false;
  try { mgr.add(a); } catch { threw = true; }
  assert('duplicate add throws', threw);
}

console.log('\n=== snapshot returns latest health for each tool ===');
{
  const clock = new FakeClock();
  const mgr = new KeepaliveManager();
  const a = new FakePingable('alpha');
  const b = new FakePingable('beta');
  b.alive = false;
  mgr.add(a, { intervalMs: 1000, timeoutMs: 100, scheduler: clock.scheduler, now: clock.nowFn });
  mgr.add(b, { intervalMs: 1000, timeoutMs: 100, scheduler: clock.scheduler, now: clock.nowFn });
  mgr.startAll();
  await flushMicrotasks();
  const snap = mgr.snapshot();
  assert('snapshot has alpha', !!snap['alpha']);
  assert('snapshot has beta', !!snap['beta']);
  assert('alpha alive', snap['alpha'].alive === true);
  assert('beta down', snap['beta'].alive === false);
  await mgr.stopAll();
}

console.log('\n=== onStateChange fan-out + unsubscribe ===');
{
  const clock = new FakeClock();
  const mgr = new KeepaliveManager();
  const a = new FakePingable('alpha');
  a.alive = false;
  const evs1: StateChangeEvent[] = [];
  const evs2: StateChangeEvent[] = [];
  const unsub1 = mgr.onStateChange((e) => evs1.push(e));
  mgr.onStateChange((e) => evs2.push(e));
  mgr.add(a, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 2, cooldownMs: 30_000 },
    scheduler: clock.scheduler, now: clock.nowFn,
  });
  mgr.startAll();
  await flushMicrotasks();        // fail #1
  await clock.advance(1000);      // fail #2 → open
  assert('subscriber 1 saw open event', evs1.some((e) => e.to === 'open'));
  assert('subscriber 2 saw open event', evs2.some((e) => e.to === 'open'));
  // Now unsubscribe #1 and force another transition.
  unsub1();
  a.alive = true;
  await clock.advance(30_000);    // cooldown → half-open → closed
  const closedAfter = evs2.filter((e) => e.to === 'closed').length;
  const closedAfter1 = evs1.filter((e) => e.to === 'closed').length;
  assert('subscriber 2 saw closed event', closedAfter > 0);
  assert('subscriber 1 did NOT see closed event after unsubscribe',
    closedAfter1 === 0,
    { evs1 });
  await mgr.stopAll();
}

console.log('\n=== per-add onStateChange also fires ===');
{
  const clock = new FakeClock();
  const mgr = new KeepaliveManager();
  const a = new FakePingable('alpha');
  a.alive = false;
  const perAdd: StateChangeEvent[] = [];
  const global: StateChangeEvent[] = [];
  mgr.onStateChange((e) => global.push(e));
  mgr.add(a, {
    intervalMs: 1000, timeoutMs: 100,
    breaker: { failureThreshold: 1, cooldownMs: 30_000 },
    scheduler: clock.scheduler, now: clock.nowFn,
    onStateChange: (e) => perAdd.push(e),
  });
  mgr.startAll();
  await flushMicrotasks();        // boot fail → open (threshold=1)
  assert('per-add callback received event', perAdd.some((e) => e.to === 'open'));
  assert('global subscriber also received event', global.some((e) => e.to === 'open'));
  await mgr.stopAll();
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
