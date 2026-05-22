// case-events.ts — In-Memory EventBus per Case-ID.
//
// Producer (filesystem-watcher in case-stream.ts, plus stage-bus-bridge in
// server.ts) emit events here; Consumers (SSE-Endpoint /api/m/cases/:id/stream)
// subscribe per caseId and forward to clients as text/event-stream.
//
// Why in-memory: jeder STURM-mandanten-Container hat sticky Sessions (single
// node), keine Cross-Container-Replikation nötig. Bei Restart geht der live
// stream verloren — Case-JSON-State bleibt aber persistent, Frontend kann
// auf den letzten Stand neu draufstöpseln und ab da live mitlesen.

import { EventEmitter } from 'node:events';

export type CaseEventKind =
  | 'beleg.uploaded'
  | 'beleg.classified'
  | 'beleg.state_change'
  | 'value.extracted'
  | 'page.read'
  | 'pipeline.stage'
  | 'berechnung.start'
  | 'berechnung.bridge'
  | 'berechnung.lane1'
  | 'audit.warning'
  | 'audit.consistency'
  | 'narrator.say'
  | 'narrator.error'
  | 'story.ready'
  | 'heartbeat';

export interface CaseEvent {
  kind: CaseEventKind;
  ts: string;                    // ISO timestamp
  doc_id?: string;
  filename?: string;
  belegtyp?: string;
  anlagen?: string[];
  label?: string;
  value?: string | number;
  person_id?: 'A' | 'B' | null;
  konfidenz?: number;
  page?: number;
  totalPages?: number;
  stage?: string;
  status?: 'start' | 'done' | 'error';
  ms?: number;
  reason?: string;
  message?: string;
  refs?: string[];
  text?: string;                 // for narrator.say
  data?: any;                    // generic payload
}

class CaseBus {
  private buses = new Map<string, EventEmitter>();
  private buffers = new Map<string, CaseEvent[]>();    // last N events per case
  private readonly MAX_BUFFER = 200;

  private bus(caseId: string): EventEmitter {
    let b = this.buses.get(caseId);
    if (!b) {
      b = new EventEmitter();
      b.setMaxListeners(50);
      this.buses.set(caseId, b);
      this.buffers.set(caseId, []);
    }
    return b;
  }

  emit(caseId: string, event: Omit<CaseEvent, 'ts'> & { ts?: string }): void {
    const full: CaseEvent = { ...event, ts: event.ts ?? new Date().toISOString() };
    const buf = this.buffers.get(caseId);
    if (buf) {
      buf.push(full);
      if (buf.length > this.MAX_BUFFER) buf.shift();
    }
    this.bus(caseId).emit('event', full);
  }

  subscribe(caseId: string, listener: (e: CaseEvent) => void): () => void {
    const b = this.bus(caseId);
    b.on('event', listener);
    return () => b.off('event', listener);
  }

  /** Buffered events der letzten Minuten (für späte Subscriber). */
  replay(caseId: string): CaseEvent[] {
    return [...(this.buffers.get(caseId) ?? [])];
  }

  /** Statistik. */
  stats() {
    const out: Record<string, number> = {};
    for (const [k, v] of this.buffers) out[k] = v.length;
    return out;
  }
}

export const caseEvents = new CaseBus();
