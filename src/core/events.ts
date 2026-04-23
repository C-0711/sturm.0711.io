import type { EventEnvelope, WorkflowId } from './types.ts';

/**
 * Minimaler Pub/Sub pro Run. Subscriber bekommen alle Events ab Subscribe-Zeitpunkt.
 * SSE-Serialisierung lebt beim Server, nicht hier.
 */
export class EventBus {
  private subscribers = new Set<(e: EventEnvelope) => void>();
  private done = false;

  constructor(
    public readonly runId: string,
    public readonly workflowId: WorkflowId
  ) {}

  subscribe(fn: (e: EventEnvelope) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(name: string, payload?: unknown, stageId?: string): void {
    if (this.done) return;
    const env: EventEnvelope = {
      name,
      runId: this.runId,
      workflowId: this.workflowId,
      stageId,
      at: new Date().toISOString(),
      payload,
    };
    for (const fn of this.subscribers) {
      try { fn(env); } catch { /* subscriber-Fehler sollen Run nicht kippen */ }
    }
  }

  close(): void {
    this.done = true;
    this.subscribers.clear();
  }
}

/** SSE-Serialisierung: eine Zeile `data: <json>\n\n`. */
export function formatSseEvent(env: EventEnvelope): string {
  return `event: ${env.name}\ndata: ${JSON.stringify(env)}\n\n`;
}
