/**
 * protocol — Audit-Protokoll + Content-Seal. Beim gemeinsamen Abschluss wird
 * dokumentiert, WAS der Auditor geprüft hat und WIE der Nutzer aufgelöst hat,
 * und das Ganze mit einem blake2b-256-Hash über die kanonische Form versiegelt:
 * jede spätere Änderung am Inhalt ergibt einen anderen Hash → manipulationssicher.
 *
 * (Die durable, append-only GitChain-Verankerung — recordAnchor — setzt ein
 * GitChain-Container für den Fall voraus und ist der nächste Schritt; der
 * blake2b-Seal hier ist on-prem, dependency-frei und sofort verifizierbar.)
 */
import { createHash } from 'node:crypto';
import type { AuditFinding } from './audit.ts';

export interface AuditProtocol {
  v: 1;
  caseId: string;
  label: string;
  vz: number;
  ergebnis: { erstattung: number | null; veranlagungsart: string | null };
  fingerprint: { fields: number; belege: number };
  befunde: Array<{ kind: string; severity: string; frage: string; state: string; wert?: string; basis: { quelle: string; ref: string }; belegstelle?: { quelle: string | null; zitat: string } }>;
}

export interface Seal { algo: 'blake2b-256'; hash: string; sealedAt: string; }

/** Deterministische JSON-Serialisierung (sortierte Keys) → stabiler Hash. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

interface BuildInput {
  caseId: string; label: string; vz: number;
  data: { calcs?: Array<{ erstattung?: number }>; veranlagungsart?: string; fields?: unknown[]; belege?: unknown[] };
  audit: { findings: AuditFinding[] };
}

export function buildAuditProtocol(input: BuildInput): AuditProtocol {
  const d = input.data ?? {};
  const calc = Array.isArray(d.calcs) && d.calcs[0] ? d.calcs[0] : null;
  return {
    v: 1, caseId: input.caseId, label: input.label, vz: input.vz,
    ergebnis: { erstattung: calc && calc.erstattung != null ? Number(calc.erstattung) : null, veranlagungsart: d.veranlagungsart ?? null },
    fingerprint: { fields: (d.fields ?? []).length, belege: (d.belege ?? []).length },
    befunde: (input.audit.findings ?? []).map((f) => ({
      kind: f.kind, severity: f.severity, frage: f.frage ?? '', state: f.state,
      ...(f.wert ? { wert: String(f.wert) } : {}),
      basis: { quelle: f.basis.quelle, ref: f.basis.ref },
      ...(f.grounding && f.grounding.text
        ? { belegstelle: { quelle: f.grounding.source ?? null, zitat: f.grounding.text.slice(0, 160).replace(/\s+/g, ' ').trim() } }
        : {}),
    })),
  };
}

/** blake2b-256 über die kanonische Protokoll-Form (Zeitstempel separat). */
export function sealProtocol(p: AuditProtocol, now: string): Seal {
  const hash = createHash('blake2b512').update(canonical(p), 'utf8').digest('hex').slice(0, 64);
  return { algo: 'blake2b-256', hash, sealedAt: now };
}
