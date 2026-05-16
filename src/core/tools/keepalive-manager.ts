/**
 * STURM — Tool-Binding Phase P3: KeepaliveManager.
 *
 * Owns one `KeepaliveWorker` per `Pingable` target and provides the
 * dashboard-friendly aggregate view (snapshot + state-change fan-out).
 */

import type { ToolHealth } from './types.ts';
import {
  KeepaliveWorker,
  type CircuitState,
  type KeepaliveOptions,
  type Pingable,
  type StateChangeEvent,
} from './keepalive.ts';

export type ManagerStateChangeListener = (event: StateChangeEvent) => void;

export class KeepaliveManager {
  private readonly workers = new Map<string, KeepaliveWorker>();
  private readonly listeners = new Set<ManagerStateChangeListener>();

  add(target: Pingable, opts: KeepaliveOptions = {}): KeepaliveWorker {
    if (this.workers.has(target.name)) {
      throw new Error(
        `KeepaliveManager: tool '${target.name}' is already registered`,
      );
    }
    const userOnStateChange = opts.onStateChange;
    const worker = new KeepaliveWorker(target, {
      ...opts,
      onStateChange: (event) => {
        try {
          userOnStateChange?.(event);
        } catch {
          // ignore caller errors
        }
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            // ignore subscriber errors
          }
        }
      },
    });
    this.workers.set(target.name, worker);
    return worker;
  }

  startAll(): void {
    for (const worker of this.workers.values()) worker.start();
  }

  async stopAll(): Promise<void> {
    for (const worker of this.workers.values()) worker.stop();
  }

  snapshot(): Record<string, ToolHealth> {
    const out: Record<string, ToolHealth> = {};
    for (const [name, worker] of this.workers) {
      out[name] = worker.lastHealth;
    }
    return out;
  }

  onStateChange(cb: ManagerStateChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Convenience: look up a registered worker by name (may be undefined). */
  get(name: string): KeepaliveWorker | undefined {
    return this.workers.get(name);
  }

  /** Number of registered workers. */
  get size(): number {
    return this.workers.size;
  }
}

export type { CircuitState, StateChangeEvent, Pingable };
