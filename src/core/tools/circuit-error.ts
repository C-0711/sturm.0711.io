/**
 * STURM — Tool-Binding Phase P3: Error classes for the keepalive subsystem
 * and the (P2) tool-container boot path.
 *
 * `CircuitOpenError` is thrown by tool-container call paths when the
 * keepalive worker has marked a tool's circuit as `open`.
 *
 * `ToolBootError` is thrown by the container boot routine when a `required`
 * tool fails its initial health check. Shipped here so P2 and P3 can both
 * import from the same module without a circular dependency.
 */

import type { ToolHealth } from './types.ts';

export class CircuitOpenError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly lastError?: string,
  ) {
    super(
      `tool circuit open: ${toolName}${lastError ? ` (last error: ${lastError})` : ''}`,
    );
    this.name = 'CircuitOpenError';
  }
}

export class ToolBootError extends Error {
  /** Optional health snapshot from the failing probe. P2 supplies this when the
   *  required-tool health check came back `alive:false`; P3 keepalive paths may
   *  omit it. */
  public readonly health?: ToolHealth;
  constructor(
    public readonly appId: string,
    public readonly toolName: string,
    message: string,
    health?: ToolHealth,
  ) {
    super(`[anwendung:${appId}] tool boot failed: ${toolName} — ${message}`);
    this.name = 'ToolBootError';
    this.health = health;
  }
}
