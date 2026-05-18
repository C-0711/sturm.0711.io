/**
 * Case-Level-Layer-Aggregation für Anwendungen.
 *
 * Eingabe: `ApplicationInstance` mit N abgeschlossenen extraction-Runs.
 * Für jeden Run wird das `phase6BmfRechner.canonical_layer` (oder als
 * Fallback `phase5Merge.canonical_layer`) gelesen und per eCode in eine
 * Fall-Level-Map gemerged.
 *
 * Merge-Semantik pro eCode:
 *   • Ein Beleg liefert den Wert → übernommen wie heute.
 *   • Mehrere Belege liefern denselben (normalisierten) Wert →
 *     bestätigt; Confidence-Indikator gesetzt.
 *   • Mehrere Belege liefern verschiedene Werte → Konflikt. Der mit der
 *     höchsten Origin-Trust-Stufe gewinnt (REGEX_100% > BMF_RECHNER >
 *     REGEX_3F > LLM_FSM > ENSEMBLE_TIE/DISAGREE > unknown). Alle
 *     Kandidaten bleiben in `conflicts[]`.
 *
 * Plus: Pflicht-Coverage (welche pflicht-Atome der erkannten Anlagen
 * sind im merged Layer belegt?) und Suggestion welcher Belegtyp ein
 * fehlendes Pflicht-Feld typischerweise liefert.
 *
 * Diese Funktion ist deterministisch + I/O-frei abseits des Datei-Lesens
 * der Run-Artefakte. Gut für Tests via in-Memory Stubs.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseGermanMoney } from '../lib/normalize-number.ts';
import type { ApplicationInstance, CaseDocument } from './applications.ts';

/** Numerische Datentypen, für die `normalizedNumber` populated wird. Spiegelt
 *  die Liste in phase5-merge.populateNormalizedNumber für ältere Runs ohne
 *  vorhandenes normalizedNumber-Feld. */
const NUMERIC_DATENTYPS = new Set<string>(['currency', 'amount', 'integer', 'percent', 'number']);

/** Liefert die normalizedNumber für einen canonical-Eintrag. Bevorzugt das
 *  bereits gesetzte Feld (phase5-merge schreibt es); fällt zurück auf einen
 *  parseGermanMoney(value)-Versuch für ältere Runs. Liefert undefined für
 *  nicht-numerische Datentypen. */
function deriveNormalizedNumber(cv: CanonicalValue): number | undefined {
  if (typeof cv.normalizedNumber === 'number' && Number.isFinite(cv.normalizedNumber)) {
    return cv.normalizedNumber;
  }
  const dt = typeof cv.datentyp === 'string' ? cv.datentyp : '';
  if (!NUMERIC_DATENTYPS.has(dt)) return undefined;
  const n = parseGermanMoney(typeof cv.value === 'string' ? cv.value : null);
  return n !== null ? n : undefined;
}

export interface CanonicalValue {
  eCode?: string;
  value?: string;
  normalized?: string | null;
  /** Pre-parsed JS-number für numerische Datentypen (currency etc.). Wird
   *  in phase5-merge gesetzt (siehe `populateNormalizedNumber`). Ground-
   *  Truth-Vergleiche und arithmetische Konsumenten sollen DIESES Feld
   *  lesen, nicht den deutschen Locale-String aus `value`. */
  normalizedNumber?: number;
  origin?: string;
  anlage?: string;
  drucktext?: string;
  vordruckzeile?: string;
  datentyp?: string;
  evidence_line?: string;
  [k: string]: unknown;
}

export interface MergedField {
  eCode: string;
  value: string;
  normalized: string | null;
  /** Pre-parsed JS-number — durchgereicht vom canonical_layer-Eintrag.
   *  Single source of arithmetic truth für BMF-Pre-Filter, Ground-Truth-
   *  Vergleich und Cross-Validator-Summen. */
  normalizedNumber?: number;
  origin: string;
  anlage: string;
  drucktext: string;
  vordruckzeile: string;
  datentyp: string;
  /** Trust-Stufe — wird aus dem winner.raw.trust übernommen, damit Downstream
   *  (BMF-Pre-Filter, Review-UI) zwischen high/medium/low/suspicious
   *  unterscheiden kann. */
  trust?: 'high' | 'medium' | 'low' | 'suspicious';
  /** Alle Belege, die diesen Wert geliefert haben. P1 citations infra:
   *  each entry can carry the page number (0-based) and the OCR snippet
   *  (evidence_line) it came from, so the Pro-Abrechnung UI can render
   *  a clickable chip "Stricker_ESt.pdf · Seite 5 · Bruttoarbeitslohn …". */
  confirmed_by: Array<{
    runId: string;
    filename: string;
    page?: number;
    snippet?: string;
  }>;
  /** Confidence: 1 = einziger Beleg, n>1 = bestätigt. */
  confidence_count: number;
}

export interface ConflictEntry {
  eCode: string;
  drucktext: string;
  anlage: string;
  /** Verschiedene Kandidaten-Werte, jeweils mit ihren Quellen. */
  candidates: Array<{
    value: string;
    normalized: string | null;
    origin: string;
    sources: Array<{ runId: string; filename: string }>;
  }>;
  /** Welcher Kandidat aktuell im merged_layer steht (Trust-Stufen-Sieger). */
  winner: string;
}

export interface PflichtMissing {
  eCode: string;
  drucktext: string;
  anlage: string;
  vordruckzeile: string;
  /** Welcher Belegtyp enthält dieses Feld typischerweise? */
  suggestedDocs: string[];
}

export interface DocumentSummary {
  runId: string;
  filename: string;
  inboxPath?: string;
  uploadedAt?: string;
  anlagen: string[];
  fieldsExtracted: number;
  state: 'ok' | 'error' | 'partial' | 'unknown';
}

export interface AggregateResult {
  caseId: string;
  appId: string;
  status: ApplicationInstance['status'];
  documents: DocumentSummary[];
  merged_layer: Record<string, MergedField>;
  conflicts: ConflictEntry[];
  pflicht_missing: PflichtMissing[];
  pflicht_coverage: {
    total: number;          // Pflicht-Atome aller erkannten Anlagen
    covered: number;        // davon im merged_layer mit Wert
    pct: number;            // 0..100
    measurable: boolean;    // false wenn 0 Pflicht-Atome (Katalog-Lücke)
  };
  stats: {
    docs: number;
    eCodes: number;
    conflicts: number;
  };
  /** Wird optional von der Route nachgetragen (BMF-Compute). */
  bmf?: unknown;
}

const TRUST_ORDER: Record<string, number> = {
  'REGEX_100%': 100,
  'BMF_RECHNER': 90,
  'REGEX_3F': 80,
  'ENSEMBLE_OK': 75,
  'LLM_FSM': 60,
  'ENSEMBLE_TIE': 40,
  'ENSEMBLE_DISAGREE': 20,
  'unknown': 0,
};
function trustOf(origin?: string): number {
  return TRUST_ORDER[origin ?? 'unknown'] ?? 0;
}

function normalizeForCompare(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')) as T; }
  catch { return null; }
}

/**
 * Liest die *reiche* canonical_layer eines Runs. Priorität:
 *   phase6BmfRechner.canonical_layer > phase5Merge.canonical_layer
 * (Beide haben die volle CanonicalValue-Shape mit origin/drucktext/etc.;
 * phase7Validator.canonicalLayer.codes ist ein flacher Fallback, hier
 * absichtlich ignoriert, weil wir die Metadaten brauchen.)
 */
async function loadRunLayer(runsDir: string, workflowId: string, runId: string): Promise<{
  layer: Record<string, CanonicalValue> | null;
  state: DocumentSummary['state'];
}> {
  const runDir = path.join(runsDir, workflowId, runId);
  const result = await readJson<{ state?: DocumentSummary['state']; stages?: Record<string, { state: string }> }>(path.join(runDir, '_result.json'));
  const state: DocumentSummary['state'] = result?.state ?? 'unknown';
  const bmf = await readJson<{ canonical_layer?: Record<string, CanonicalValue> }>(path.join(runDir, 'phase6BmfRechner', 'output.json'));
  if (bmf?.canonical_layer && Object.keys(bmf.canonical_layer).length > 0) {
    return { layer: bmf.canonical_layer, state };
  }
  const merge = await readJson<{ canonical_layer?: Record<string, CanonicalValue> }>(path.join(runDir, 'phase5Merge', 'output.json'));
  if (merge?.canonical_layer && Object.keys(merge.canonical_layer).length > 0) {
    return { layer: merge.canonical_layer, state };
  }
  return { layer: null, state };
}

export interface AggregateCaseOptions {
  runsDir: string;
  extractionWorkflowId: string;
  /** Async-Lookup für Pflicht-Atome einer Anlage (Default: felderFuerAnlage). */
  loadPflichtFelder?: (anlage: string) => Promise<Array<{ eCode: string; drucktext: string; vordruckzeile: string; pflicht: boolean }>>;
  /** Lookup für Doc-Type-Hints pro eCode. */
  documentTypeHints?: Record<string, string[]>;
}

export async function aggregateCase(
  inst: ApplicationInstance,
  opts: AggregateCaseOptions,
): Promise<AggregateResult> {
  const documents: DocumentSummary[] = [];
  const docMetaByRun = new Map<string, CaseDocument>();
  for (const d of inst.documents ?? []) docMetaByRun.set(d.runId, d);

  // Per-Run-Layer laden (parallel)
  const runLayers = await Promise.all(inst.runs.map(async (runId) => {
    const { layer, state } = await loadRunLayer(opts.runsDir, opts.extractionWorkflowId, runId);
    return { runId, layer, state };
  }));

  // Document-Summary-Liste aus runs + manifest-Metadaten
  const allAnlagen = new Set<string>();
  for (const { runId, layer, state } of runLayers) {
    const meta = docMetaByRun.get(runId);
    const filename = meta?.filename ?? '(unbekannte Datei)';
    const anlagen = meta?.anlagen ?? [];
    for (const a of anlagen) allAnlagen.add(a);
    documents.push({
      runId,
      filename,
      inboxPath: meta?.inboxPath,
      uploadedAt: meta?.uploadedAt,
      anlagen,
      fieldsExtracted: layer ? Object.keys(layer).length : (meta?.fieldsExtracted ?? 0),
      state,
    });
  }

  // ── Merge ──────────────────────────────────────────────────────────
  // Per eCode: Map<normalisierter Wert, { rawValue, origin, sources[] }>
  const perCode = new Map<string, Map<string, {
    raw: CanonicalValue;
    normalized: string | null;
    sources: Array<{ runId: string; filename: string; page?: number; snippet?: string }>;
  }>>();

  for (const { runId, layer } of runLayers) {
    if (!layer) continue;
    const meta = docMetaByRun.get(runId);
    const filename = meta?.filename ?? runId;
    for (const [eCode, cv] of Object.entries(layer)) {
      if (!cv || typeof cv !== 'object') continue;
      const norm = cv.normalized ?? cv.value ?? null;
      const key = normalizeForCompare(norm);
      // P1 citation: page from phase1-regex / phase3-vision-fill (propagated
      // through phase5-merge into canonical_layer); snippet from
      // evidence_line (regex only — vision hits don't have one yet).
      const page = (cv as { page?: number }).page;
      const snippet = typeof cv.evidence_line === 'string' ? cv.evidence_line : undefined;
      const src: { runId: string; filename: string; page?: number; snippet?: string } = {
        runId, filename,
        ...(typeof page === 'number' && page >= 0 ? { page } : {}),
        ...(snippet ? { snippet } : {}),
      };
      if (!perCode.has(eCode)) perCode.set(eCode, new Map());
      const bucket = perCode.get(eCode)!;
      const ex = bucket.get(key);
      if (ex) {
        ex.sources.push(src);
      } else {
        bucket.set(key, { raw: cv, normalized: norm, sources: [src] });
      }
    }
  }

  const merged_layer: Record<string, MergedField> = {};
  const conflicts: ConflictEntry[] = [];

  for (const [eCode, bucket] of perCode) {
    const candidates = Array.from(bucket.values());
    if (candidates.length === 1) {
      const c = candidates[0];
      merged_layer[eCode] = {
        eCode,
        value: String(c.raw.value ?? ''),
        normalized: c.normalized,
        normalizedNumber: deriveNormalizedNumber(c.raw),
        origin: String(c.raw.origin ?? 'unknown'),
        anlage: String(c.raw.anlage ?? ''),
        drucktext: String(c.raw.drucktext ?? ''),
        vordruckzeile: String(c.raw.vordruckzeile ?? ''),
        datentyp: String(c.raw.datentyp ?? ''),
        confirmed_by: c.sources,
        confidence_count: c.sources.length,
        trust: (c.raw as { trust?: 'high' | 'medium' | 'low' | 'suspicious' }).trust,
      };
      continue;
    }
    // Mehrere Kandidaten: Jahr-Match → Trust → Source-Count.
    // Jahr-Match ist PRIMÄR weil bei Konflikten (z.B. Bruttoarbeitslohn von
    // 2023-ELSTER-Form + 2024-LStB) der jahresaktuelle Wert gewinnen muss.
    const caseJahr = inst.veranlagungsjahr ?? null;
    const docYearByName = new Map<string, number | null>();
    for (const d of inst.documents ?? []) {
      const y = (d.indikation?.steuerjahr ?? null);
      if (d.filename) docYearByName.set(d.filename, y);
    }
    function yearScore(c: { sources: Array<{ filename: string }> }): number {
      if (!caseJahr) return 0; // kein case-jahr → kein bias
      for (const s of c.sources) {
        const y = docYearByName.get(s.filename);
        if (y === caseJahr) return 2; // exakter Match
      }
      // Penalty wenn ALLE sources ein anderes konkretes Jahr haben
      const allYears = c.sources.map((s) => docYearByName.get(s.filename)).filter((y) => typeof y === 'number');
      if (allYears.length > 0 && !allYears.includes(caseJahr)) return -1;
      return 0;
    }
    candidates.sort((a, b) => {
      const ya = yearScore(a);
      const yb = yearScore(b);
      if (ya !== yb) return yb - ya;
      const ta = trustOf(String(a.raw.origin ?? 'unknown'));
      const tb = trustOf(String(b.raw.origin ?? 'unknown'));
      if (ta !== tb) return tb - ta;
      return b.sources.length - a.sources.length;
    });
    const winner = candidates[0];
    merged_layer[eCode] = {
      eCode,
      value: String(winner.raw.value ?? ''),
      normalized: winner.normalized,
      normalizedNumber: deriveNormalizedNumber(winner.raw),
      origin: String(winner.raw.origin ?? 'unknown'),
      anlage: String(winner.raw.anlage ?? ''),
      drucktext: String(winner.raw.drucktext ?? ''),
      vordruckzeile: String(winner.raw.vordruckzeile ?? ''),
      datentyp: String(winner.raw.datentyp ?? ''),
      confirmed_by: winner.sources,
      confidence_count: winner.sources.length,
      trust: (winner.raw as { trust?: 'high' | 'medium' | 'low' | 'suspicious' }).trust,
    };
    conflicts.push({
      eCode,
      drucktext: String(winner.raw.drucktext ?? ''),
      anlage: String(winner.raw.anlage ?? ''),
      candidates: candidates.map((c) => ({
        value: String(c.raw.value ?? ''),
        normalized: c.normalized,
        origin: String(c.raw.origin ?? 'unknown'),
        sources: c.sources,
      })),
      winner: String(winner.raw.value ?? ''),
    });
  }

  // ── Pflicht-Coverage ─────────────────────────────────────────────
  const loadPflicht = opts.loadPflichtFelder
    ?? (async (anlage: string) => {
      try {
        const { felderFuerAnlage } = await import('../lib/elster-catalog.ts');
        const liste = await felderFuerAnlage(anlage as never);
        return liste.felder;
      } catch {
        return [];
      }
    });

  const pflicht_missing: PflichtMissing[] = [];
  let pflichtTotal = 0;
  let pflichtCovered = 0;
  for (const anlage of allAnlagen) {
    const felder = await loadPflicht(anlage);
    for (const f of felder) {
      if (!f.pflicht) continue;
      pflichtTotal++;
      const haveValue = merged_layer[f.eCode]
        && (merged_layer[f.eCode].value || merged_layer[f.eCode].normalized);
      if (haveValue) {
        pflichtCovered++;
      } else {
        pflicht_missing.push({
          eCode: f.eCode,
          drucktext: f.drucktext,
          anlage,
          vordruckzeile: f.vordruckzeile,
          suggestedDocs: opts.documentTypeHints?.[f.eCode] ?? [],
        });
      }
    }
  }

  return {
    caseId: inst.caseId,
    appId: inst.appId,
    status: inst.status,
    documents,
    merged_layer,
    conflicts,
    pflicht_missing,
    pflicht_coverage: {
      total: pflichtTotal,
      covered: pflichtCovered,
      pct: pflichtTotal === 0 ? 0 : Math.round((pflichtCovered / pflichtTotal) * 100),
      measurable: pflichtTotal > 0,
    },
    stats: {
      docs: documents.length,
      eCodes: Object.keys(merged_layer).length,
      conflicts: conflicts.length,
    },
  };
}
