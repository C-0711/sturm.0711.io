import { defineStage } from '../../../core/stage.ts';
import {
  getIndices,
  findeCodePfadImSchema,
  setzeAnPfad,
  findeOderErstelleAnlageInstanz,
  normalizeWert,
  sammleBelegteCodes,
} from '../lib/helpers.ts';

// ─── Typen ────────────────────────────────────────────────────────────────

export interface MergeFinalCode {
  code: string;
  anlage: string;
  wert: unknown;
  quelle: string;
  personen_ctx?: 'A' | 'B' | null;
}

export interface BaselineMergeInput {
  /** Annotation vom zweiten Mistral-Lauf mit tight Schema. */
  mistralKuratiertAnno: Record<string, unknown> | null;
  /** Eindeutige Codes aus der Regel-Engine. */
  regelEindeutig: MergeFinalCode[];
  /** Optional: Opus-Kurator-Annotation (letztes Wort bei Konflikten). */
  opusKuratorAnno?: Record<string, unknown> | null;
}

export interface BaselineMergeStats {
  mistral_codes: number;
  regel_codes: number;
  opus_codes: number;
  opus_ueberschrieben: number;
  baseline_ergaenzt: number;
}

export interface BaselineMergeOutput {
  finalAnnotation: Record<string, unknown>;
  mergeStats: BaselineMergeStats;
}

// ─── Lokaler Helper (Port von server.mjs:1513-1574) ──────────────────────
// baueBaselineAnnotation wurde noch nicht in helpers.ts portiert — daher hier
// lokal, damit helpers.ts unveraendert bleibt. Nutzt ausschliesslich bereits
// exportierte Helpers (findeCodePfadImSchema, setzeAnPfad, normalizeWert).
/**
 * Baut die Baseline-Annotation aus den finalen V3-Codes.
 * Wenn eine Anlage max_occurs > 1 hat UND mehrere Personen-Instanzen belegt
 * sind, wird sie als Array von Instanzen ausgegeben (eine pro Person).
 */
export function baueBaselineAnnotation(finalCodes: MergeFinalCode[]): Record<string, unknown> {
  const { elsterCatalog } = getIndices();
  const anno: Record<string, unknown> = {};
  if (!elsterCatalog) return anno;

  // Gruppiere nach (anlage, personen_ctx)
  const gruppen = new Map<string, Map<string, MergeFinalCode[]>>();
  for (const c of finalCodes) {
    if (!c?.code || !c?.anlage) continue;
    if (!gruppen.has(c.anlage)) gruppen.set(c.anlage, new Map());
    const perAnl = gruppen.get(c.anlage)!;
    const ctx = c.personen_ctx || '_';
    if (!perAnl.has(ctx)) perAnl.set(ctx, []);
    perAnl.get(ctx)!.push(c);
  }

  for (const [anlage, perAnl] of gruppen.entries()) {
    const catAnl = elsterCatalog.anlagen?.[anlage];
    if (!catAnl) continue;
    const maxOcc = catAnl.max_occurs ?? 1;
    const personen = [...perAnl.keys()].filter(c => c !== '_');

    if (maxOcc > 1 && personen.length > 1) {
      // Array: eine Instanz pro Person, Person-Marker gesetzt.
      const instanzen: Array<Record<string, unknown>> = [];
      anno[anlage] = instanzen;
      for (const ctx of personen) {
        const inst: Record<string, unknown> = { Person: ctx === 'A' ? 'PersonA' : 'PersonB' };
        for (const c of perAnl.get(ctx) ?? []) {
          const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
          const wert = normalizeWert(c.wert);
          if (pfad) setzeAnPfad(inst, pfad, c.code, wert);
          else inst[c.code] = wert;
        }
        instanzen.push(inst);
      }
      // Personen-lose Codes einmal in Instanz 0 einpflegen.
      const neutral = perAnl.get('_') ?? [];
      if (neutral.length && instanzen[0]) {
        for (const c of neutral) {
          const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
          const wert = normalizeWert(c.wert);
          if (pfad) setzeAnPfad(instanzen[0], pfad, c.code, wert);
          else instanzen[0][c.code] = wert;
        }
      }
    } else {
      // Single-instance object
      const obj: Record<string, unknown> = {};
      anno[anlage] = obj;
      for (const [, codes] of perAnl.entries()) {
        for (const c of codes) {
          const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
          const wert = normalizeWert(c.wert);
          if (pfad) setzeAnPfad(obj, pfad, c.code, wert);
          else obj[c.code] = wert;
        }
      }
    }
  }
  return anno;
}

// ─── Merge-Utilities ──────────────────────────────────────────────────────

/**
 * Deep-merge von src nach dst. Arrays werden Element-weise per Index gemerged
 * (wichtig fuer Multi-Person-Array-Wrapper), Objekte rekursiv, Primitives
 * ueberschreiben.
 */
function deepMerge(
  dst: Record<string, unknown>,
  src: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    if (v === null || v === undefined || v === '') continue;
    const existing = dst[k];
    if (Array.isArray(v) && Array.isArray(existing)) {
      for (let i = 0; i < v.length; i++) {
        const elem = v[i];
        if (!elem || typeof elem !== 'object') {
          if (elem !== null && elem !== undefined) existing[i] = elem;
          continue;
        }
        // Versuche per Person-Marker zu matchen, sonst per Index.
        const personMarker = (elem as { Person?: string })?.Person;
        let zielIdx = -1;
        if (personMarker) {
          zielIdx = existing.findIndex(e => (e as { Person?: string })?.Person === personMarker);
        }
        if (zielIdx < 0) zielIdx = i;
        if (existing[zielIdx] && typeof existing[zielIdx] === 'object' && !Array.isArray(existing[zielIdx])) {
          deepMerge(
            existing[zielIdx] as Record<string, unknown>,
            elem as Record<string, unknown>,
          );
        } else {
          existing[zielIdx] = elem;
        }
      }
    } else if (
      v && typeof v === 'object' && !Array.isArray(v)
      && existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

// ─── Stage ────────────────────────────────────────────────────────────────

/**
 * Merged Mistral-kuratierte Annotation + Regel-Engine-Baseline
 * (+ optional Opus-Kurator) in die finale Annotation.
 *
 * Port aus legacy/elster-mvp/server.mjs:2740-2800.
 *
 * Strategie pro E-Code:
 *  1. Mistral-Kuratiert-Wert gewinnt (hat das Bild gesehen, im Schema-Frame).
 *  2. Wenn Mistral den Code nicht gefuellt hat → Baseline (Regel-Engine).
 *  3. Wenn Opus-Kurator eine andere Entscheidung hat → Opus gewinnt.
 */
export const baselineMergeStage = defineStage<BaselineMergeInput, BaselineMergeOutput>({
  id: 'elster-baseline-merge',
  name: 'Baseline-Merge',
  description: 'Merged Mistral-kuratiert + Regel-Engine (+ optional Opus-Kurator)',

  async run(input, ctx) {
    const { elsterCatalog } = getIndices();
    if (!elsterCatalog) throw new Error('ELSTER-Katalog nicht geladen');

    const regelEindeutig = input?.regelEindeutig ?? [];
    const mistralKuratiertAnno = input?.mistralKuratiertAnno ?? null;
    const opusKuratorAnno = input?.opusKuratorAnno ?? null;

    // Baseline aus der Regel-Engine bauen.
    const baselineAusRegel = baueBaselineAnnotation(regelEindeutig);
    const mistralCodes = sammleBelegteCodes(mistralKuratiertAnno ?? {});
    const opusCodes = sammleBelegteCodes(opusKuratorAnno ?? {});

    // Opus-Konfliktentscheidungen aus regelEindeutig ziehen (quelle=opus_konflikt).
    const opusEntscheidungen = new Map<string, unknown>();
    for (const c of regelEindeutig) {
      if (c.quelle === 'opus_konflikt') opusEntscheidungen.set(c.code, c.wert);
    }

    // Basis: Mistral-kuratiert (falls vorhanden), sonst Baseline.
    const finalAnnotation: Record<string, unknown> = mistralKuratiertAnno
      && typeof mistralKuratiertAnno === 'object'
      ? JSON.parse(JSON.stringify(mistralKuratiertAnno))
      : JSON.parse(JSON.stringify(baselineAusRegel));

    // Opus-Entscheidungen einpflegen — respektiert Array-Struktur bei mehrfach-Anlagen.
    let opusUeberschrieben = 0;
    for (const [code, wert] of opusEntscheidungen.entries()) {
      for (const c of regelEindeutig) {
        if (c.code !== code) continue;
        const catAnl = elsterCatalog.anlagen?.[c.anlage];
        if (!catAnl) break;
        const pfad = findeCodePfadImSchema(catAnl.json_schema, code);
        if (!pfad) break;
        const ziel = findeOderErstelleAnlageInstanz(finalAnnotation, c.anlage, c.personen_ctx ?? null);
        setzeAnPfad(ziel, pfad, code, normalizeWert(wert));
        opusUeberschrieben++;
        break;
      }
    }

    // Fehlende Baseline-Codes ergaenzen (nur wenn Mistral sie nicht hat).
    let baselineErgaenzt = 0;
    for (const c of regelEindeutig) {
      if (mistralCodes.has(c.code)) continue;
      if (opusEntscheidungen.has(c.code)) continue;
      const catAnl = elsterCatalog.anlagen?.[c.anlage];
      if (!catAnl) continue;
      const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
      const ziel = findeOderErstelleAnlageInstanz(finalAnnotation, c.anlage, c.personen_ctx ?? null);
      if (pfad) setzeAnPfad(ziel, pfad, c.code, normalizeWert(c.wert));
      else ziel[c.code] = normalizeWert(c.wert);
      baselineErgaenzt++;
    }

    // Optional: Opus-Kurator-Annotation deep-mergen (hat letztes Wort ueber Mistral).
    if (opusKuratorAnno && typeof opusKuratorAnno === 'object') {
      const opusKlone = JSON.parse(JSON.stringify(opusKuratorAnno)) as Record<string, unknown>;
      deepMerge(finalAnnotation, opusKlone);
    }

    const mergeStats: BaselineMergeStats = {
      mistral_codes: mistralCodes.size,
      regel_codes: regelEindeutig.length,
      opus_codes: opusCodes.size,
      opus_ueberschrieben: opusUeberschrieben,
      baseline_ergaenzt: baselineErgaenzt,
    };

    ctx.emit('merge_stats', mergeStats);
    ctx.logger.info('Baseline-Merge fertig', mergeStats);

    return { finalAnnotation, mergeStats };
  },
});
