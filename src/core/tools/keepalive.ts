/**
 * STURM — Tool-Binding Phase P3: Keepalive worker + circuit-breaker.
 *
 * State machine:
 *   closed     — every successful ping stays here.
 *   closed     → open        after `failureThreshold` consecutive failures.
 *   open       — refuse calls (CircuitOpenError); a scheduled probe will fire
 *                once `cooldownMs` has elapsed since entering `open`.
 *   open       → half-open   when the next scheduled ping is *about* to fire
 *                after the cooldown window has expired (transition happens
 *                BEFORE the probe result is known so a hung probe is visible).
 *   half-open  → closed      after `successThreshold` consecutive successes.
 *   half-open  → open        on a single failure; cooldown timer is restarted.
 *
 * Scheduling uses a single setTimeout chain (rescheduled in `.finally()`),
 * never setInterval, to avoid tick pile-up when a ping hangs longer than
 * `intervalMs`. Each ping is wrapped in an `AbortController` driven timeout.
 */

import type { ToolHealth, ToolKind } from './types.ts';

export interface Pingable {
  readonly name: string;
  readonly kind: ToolKind;
  health(signal?: AbortSignal): Promise<ToolHealth>;
}

export type CircuitState = 'closed' | 'half-open' | 'open';

export interface CircuitBreakerOptions {
  /** Consecutive failures to open the circuit. Default: 3. */
  failureThreshold?: number;
  /** Cooldown ms before transitioning open → half-open. Default: 30_000. */
  cooldownMs?: number;
  /** Consecutive successes in half-open to close. Default: 1. */
  successThreshold?: number;
}

export interface StateChangeEvent {
  name: string;
  from: CircuitState;
  to: CircuitState;
  reason: string;
}

export interface SchedulerLike {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface KeepaliveOptions {
  /** Ping interval in ms. Default: 30_000. */
  intervalMs?: number;
  /** Per-ping timeout in ms. Default: 5_000. */
  timeoutMs?: number;
  breaker?: CircuitBreakerOptions;
  /** Called when circuit state changes (for logging / metrics / SSE). */
  onStateChange?: (event: StateChangeEvent) => void;
  /** Called after each ping (for live dashboards). */
  onHealth?: (health: ToolHealth) => void;
  /** Optional `Date.now()` override (tests). */
  now?: () => number;
  /** Optional setTimeout/clearTimeout override (tests). */
  scheduler?: SchedulerLike;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_COOLDOWN_MS = 30_000;

const defaultScheduler: SchedulerLike = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class KeepaliveWorker {
  readonly target: Pingable;

  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: (event: StateChangeEvent) => void;
  private readonly onHealth?: (health: ToolHealth) => void;
  private readonly now: () => number;
  private readonly scheduler: SchedulerLike;

  private _circuit: CircuitState = 'closed';
  private _lastHealth: ToolHealth;
  private consecutiveFailures = 0;
  private consecutiveHalfOpenSuccesses = 0;
  private openedAt: number | null = null;

  private timerHandle: unknown = null;
  private started = false;
  private inFlight = false;

  constructor(target: Pingable, opts: KeepaliveOptions = {}) {
    this.target = target;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failureThreshold =
      opts.breaker?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.successThreshold =
      opts.breaker?.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.cooldownMs = opts.breaker?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.onStateChange = opts.onStateChange;
    this.onHealth = opts.onHealth;
    this.now = opts.now ?? Date.now;
    this.scheduler = opts.scheduler ?? defaultScheduler;

    this._lastHealth = {
      name: target.name,
      kind: target.kind,
      configured: true,
      alive: false,
      circuit: 'closed',
    };
  }

  get lastHealth(): ToolHealth {
    return this._lastHealth;
  }

  get circuit(): CircuitState {
    return this._circuit;
  }

  get available(): boolean {
    return this._circuit !== 'open';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Boot ping fires immediately (synchronously schedule a microtask).
    this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timerHandle != null) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  async pingNow(): Promise<ToolHealth> {
    return this.runPing();
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Schedule (or perform) the next ping. Cancels any existing timer so
   * there is only ever one outstanding scheduled tick.
   */
  private scheduleNext(delayMs: number): void {
    if (!this.started) return;
    if (this.timerHandle != null) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.timerHandle = this.scheduler.setTimeout(() => {
      this.timerHandle = null;
      this.tick();
    }, Math.max(0, delayMs));
  }

  private tick(): void {
    if (!this.started) return;
    if (this.inFlight) {
      // Guard: never overlap pings. Reschedule after intervalMs.
      this.scheduleNext(this.intervalMs);
      return;
    }
    // If circuit is open and cooldown has elapsed, transition to half-open
    // BEFORE the probe so observers see the half-open state during the call.
    if (this._circuit === 'open') {
      const elapsed = this.openedAt == null ? 0 : this.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.transition('half-open', 'cooldown elapsed');
      } else {
        // Not yet — reschedule for the remainder of the cooldown.
        this.scheduleNext(this.cooldownMs - elapsed);
        return;
      }
    }
    void this.runPing().finally(() => {
      if (!this.started) return;
      // After an open transition we must wait for cooldown, not intervalMs.
      if (this._circuit === 'open') {
        this.scheduleNext(this.cooldownMs);
      } else {
        this.scheduleNext(this.intervalMs);
      }
    });
  }

  private async runPing(): Promise<ToolHealth> {
    this.inFlight = true;
    const controller = new AbortController();
    let timeoutHandle: unknown = null;
    let timedOut = false;
    const startedAt = this.now();
    try {
      timeoutHandle = this.scheduler.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);

      let health: ToolHealth;
      try {
        health = await this.target.health(controller.signal);
        if (timedOut) {
          // health() ignored the abort and resolved late; still treat as fail.
          health = {
            name: this.target.name,
            kind: this.target.kind,
            configured: health.configured,
            alive: false,
            latencyMs: this.now() - startedAt,
            lastError: `timeout after ${this.timeoutMs}ms`,
          };
        }
      } catch (err) {
        const msg = timedOut
          ? `timeout after ${this.timeoutMs}ms`
          : (err instanceof Error ? err.message : String(err));
        health = {
          name: this.target.name,
          kind: this.target.kind,
          configured: true,
          alive: false,
          latencyMs: this.now() - startedAt,
          lastError: msg,
        };
      }

      // Stamp the circuit state into the snapshot. We update state first
      // based on the outcome, then mirror onto the health record.
      if (health.alive) {
        this.onSuccess();
      } else {
        this.onFailure(health.lastError);
      }
      health = { ...health, circuit: this._circuit };
      this._lastHealth = health;
      try {
        this.onHealth?.(health);
      } catch {
        // Swallow observer errors — they must never break the worker.
      }
      return health;
    } finally {
      if (timeoutHandle != null) {
        this.scheduler.clearTimeout(timeoutHandle);
      }
      this.inFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this._circuit === 'half-open') {
      this.consecutiveHalfOpenSuccesses += 1;
      if (this.consecutiveHalfOpenSuccesses >= this.successThreshold) {
        this.transition('closed', 'probe succeeded');
      }
    } else if (this._circuit === 'open') {
      // Shouldn't happen — we transition to half-open before probing — but
      // be defensive and treat a stray success as recovery.
      this.transition('closed', 'unexpected success while open');
    }
    // closed → closed is a no-op.
  }

  private onFailure(reason?: string): void {
    this.consecutiveHalfOpenSuccesses = 0;
    if (this._circuit === 'half-open') {
      // Failed probe → re-open and restart cooldown.
      this.openedAt = this.now();
      this.consecutiveFailures = this.failureThreshold; // already breached.
      this.transition('open', `half-open probe failed${reason ? `: ${reason}` : ''}`);
      return;
    }
    if (this._circuit === 'closed') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openedAt = this.now();
        this.transition(
          'open',
          `failure threshold reached (${this.consecutiveFailures})${reason ? `: ${reason}` : ''}`,
        );
      }
    }
    // open → open is a no-op (cooldown unchanged).
  }

  private transition(to: CircuitState, reason: string): void {
    const from = this._circuit;
    if (from === to) return;
    this._circuit = to;
    if (to === 'closed') {
      this.consecutiveFailures = 0;
      this.consecutiveHalfOpenSuccesses = 0;
      this.openedAt = null;
    }
    if (to === 'half-open') {
      this.consecutiveHalfOpenSuccesses = 0;
    }
    try {
      this.onStateChange?.({ name: this.target.name, from, to, reason });
    } catch {
      // Observer errors must never affect circuit state.
    }
  }
}
