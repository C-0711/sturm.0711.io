/**
 * STURM — Tool-Binding Phase P4: NullToolContainer.
 *
 * A ToolContainer placeholder used when a workflow runs without an Anwendung
 * (e.g. via the Designer UI, standalone Bash invocation, or a test).
 *
 * Any .get/.getByRole call throws a helpful error explaining how to fix it.
 * .has() always returns false so opportunistic checks degrade gracefully.
 */

import type { ToolContainerView, ToolHealth } from './types.ts';

export class NullToolContainer implements ToolContainerView {
  readonly applicationId = '(none)';
  readonly toolNames: readonly string[] = [];

  get<T>(name: string): T {
    throw new Error(
      `Tool '${name}' not available: this workflow run has no Anwendung context. ` +
      `Start the run via /api/applications/:appId/instances/:caseId/upload (or similar) ` +
      `so that ToolContainer.bootAll() can resolve the roster.`,
    );
  }

  getByRole<T>(role: string): T {
    throw new Error(
      `No tool bound to role '${role}': this workflow run has no Anwendung context.`,
    );
  }

  getAllByRole<T>(_role: string): T[] {
    return [];
  }

  has(_name: string): boolean {
    return false;
  }

  async healthAll(): Promise<Record<string, ToolHealth>> {
    return {};
  }
}
