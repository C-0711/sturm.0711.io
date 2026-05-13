/**
 * elster-v5/phase1-regex — deterministische 4-Faktor-Extraktion.
 *
 * Pro Atom in der erkannten Anlage prüfen wir 4 Signale gegen den OCR-Text:
 *   1. **Vordruckzeile**: atom.metadata.vordruckzeile muss als Token in der
 *      OCR-Zeile vorkommen (z.B. `\b5\b` für Zeile 5).
 *   2. **Drucktext**: atom.metadata.drucktext (≥ 4 chars) muss in derselben
 *      OCR-Zeile als Substring auftauchen, case-insensitive.
 *   3. **Wert-Pattern**: am Ende der Zeile muss ein typgerechter Wert stehen
 *      (currency → `123.456,78` oder `123.456,78 €`; date → `dd.mm.yyyy`;
 *      string → Rest der Zeile nach Drucktext).
 *   4. **Format-Validation**: der normalisierte Wert (via normalizeForElster
 *      + checkFormat aus elster-catalog.ts) muss atom.metadata.formatRegex
 *      erfüllen.
 *
 * Wenn ALLE 4 zutreffen → 100% Match. Output: regex_hits map mit Wert +
 * Provenance (origin=REGEX_100%, evidence_line, kontextPath). Felder ohne
 * Match landen in missing_ecodes — die werden in Phase 3 (LLM-Fill) bearbeitet.
 */
import { defineStage } from '../../../core/stage.ts';
import {
  normalizeForElster,
  type AnlagenFelderListe,
  type AnlagenFeld,
} from '../../../lib/elster-catalog.ts';

export interface Phase1RegexInput {
  /** OCR-Volltext (von mistral-ocr). */
  text: string;
  /** Anlagen-Felder-Listen aus elster-v4/felder-katalog. */
  per_anlage: Record<string, AnlagenFelderListe>;
}

export interface Phase1RegexHit {
  eCode: string;
  value: string;
  /** Currency: integer cents als string. date: DD.MM.YYYY. string: trimmed. */
  normalized: string;
  /** Quelle des Hits. 4-Faktor = strenger Match mit vordruckzeile-Anker;
   *  3-Faktor = Drucktext + Value + Format (Quellbelege ohne ELSTER-Zeilen). */
  origin: 'REGEX_100%' | 'REGEX_3F';
  /** Die OCR-Zeile die zum Match führte (Audit-Beleg). */
  evidence_line: string;
  /** BMF-kontextPath-Prefix (Einkunftsart). */
  kontextPath: string | null;
  /** Volle atom-Metadata für downstream. */
  anlage: string;
  drucktext: string;
  vordruckzeile: string;
  datentyp: 'string' | 'date' | 'currency';
}

export interface Phase1AnlageResult {
  anlage: string;
  /** Per eCode: alle 100%-Hits dieser Anlage. */
  regex_hits: Record<string, Phase1RegexHit>;
  /** eCodes die wir noch nicht gefunden haben → gehen an Phase 3 (LLM). */
  missing_ecodes: string[];
  fieldCount: number;
  hitCount: number;
  durationMs: number;
}

export interface Phase1RegexOutput {
  per_anlage: Record<string, Phase1AnlageResult>;
  totalHits: number;
  totalMissing: number;
  ms: number;
}

export interface Phase1RegexConfig {
  /** Drucktexts ≤ dieser Länge gelten als zu ambig (z.B. "Betrag", "Summe")
   *  und werden in Phase 1 nicht geprüft → gehen direkt an LLM. Default 5. */
  minDrucktextLength?: number;
  /** Fallback ohne vordruckzeile-Anker: wenn der 4-Faktor-Match scheitert,
   *  versuche 3-Faktor (drucktext + value + format) auf langen, eindeutigeren
   *  Drucktexts. Default true. Mindest-Länge für 3-Faktor: minDrucktextLength3F. */
  threeFaktorFallback?: boolean;
  /** Mindestlänge des Drucktexts für 3-Faktor-Fallback (ambig-resistent).
   *  Default 12 — z.B. "Bruttoarbeitslohn", "Identifikationsnummer". */
  minDrucktextLength3F?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Versucht in einer OCR-Zeile einen typ-passenden Wert nach dem Drucktext zu finden. */
function extractRawValueAfter(line: string, drucktextEnd: number, datentyp: AnlagenFeld['datentyp']): string | null {
  // Markdown-Tabellen aus mistral-ocr enden auf `| ... |`. Trailing-Pipe abstreifen,
  // damit currency/date-Regex auch in Tabellen-Zellen das Zeilenende treffen.
  const tail = line.slice(drucktextEnd).replace(/\s*\|\s*$/, '').trim();
  if (tail.length === 0) return null;
  switch (datentyp) {
    case 'currency': {
      // German currency: 1.234,56 / 1234,56 / 1234 / -1.234,56 / 1234,56 €
      // Optionales trailing `|` bleibt zusätzlich erlaubt für defensive Toleranz.
      const m = tail.match(/(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|-?\d+(?:,\d{1,2})?)\s*(?:€|EUR)?\s*\|?\s*$/);
      return m ? m[1] : null;
    }
    case 'date': {
      // DE: 31.12.2024 / 1.1.2024 / ISO: 2024-12-31
      const m = tail.match(/(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{1,2}-\d{1,2})\s*\|?\s*$/);
      return m ? m[1] : null;
    }
    case 'string':
    default: {
      // String: alles nach Drucktext bis Zeilenende, gestripped von trailing whitespace
      return tail.length > 0 ? tail : null;
    }
  }
}

/** Validiert: normalized erfüllt formatRegex + Längen-Grenzen. */
function passesFormat(normalized: string, atom: AnlagenFeld): boolean {
  if (atom.minLaenge !== undefined && normalized.length < atom.minLaenge) return false;
  if (atom.maxLaenge !== undefined && normalized.length > atom.maxLaenge) return false;
  try {
    return new RegExp(atom.formatRegex).test(normalized);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const phase1RegexStage = defineStage<Phase1RegexInput, Phase1RegexOutput, Phase1RegexConfig>({
  id: 'elster-v5/phase1-regex',
  name: 'Phase 1 — Deterministische 4-Faktor-Regex-Extraktion',
  description:
    'Scannt OCR-Zeilen pro Anlage. Pro Atom prüft 4 Signale: vordruckzeile-Token, ' +
    'drucktext-Substring, typgerechter Wert, formatRegex-Validation. Bei ALLEN 4 → ' +
    '100% Match mit Provenance. Output: regex_hits + missing_ecodes pro Anlage. ' +
    'Pure logic, kein LLM, <100ms für hunderte Felder.',
  hints: {
    inputs: 'text (OCR), per_anlage (von elster-v4/felder-katalog)',
    outputs: 'per_anlage map mit regex_hits + missing_ecodes pro Anlage, totalHits, totalMissing, ms',
    configExample: '{"minDrucktextLength":5}',
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'per_anlage', type: 'json' },
    ],
    outputPorts: [
      { name: 'per_anlage', type: 'json' },
      { name: 'totalHits', type: 'number' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const minLen = cfg.minDrucktextLength ?? 5;
    const threeFaktor = cfg.threeFaktorFallback ?? true;
    const minLen3F = cfg.minDrucktextLength3F ?? 12;

    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new Error('phase1-regex: input.text required');
    }
    const perAnlage = input.per_anlage ?? {};
    const lines = input.text.split(/\r?\n/);
    const result: Record<string, Phase1AnlageResult> = {};
    let totalHits = 0;
    let totalMissing = 0;

    for (const [anlage, liste] of Object.entries(perAnlage)) {
      const tA = Date.now();
      const felder = liste.felder ?? [];
      const regex_hits: Record<string, Phase1RegexHit> = {};
      const missing_ecodes: string[] = [];

      for (const feld of felder) {
        if (!feld.drucktext || feld.drucktext.length < minLen) {
          missing_ecodes.push(feld.eCode);
          continue;
        }

        const druckRx = new RegExp(escapeRegex(feld.drucktext), 'i');
        const hasZeile = feld.vordruckzeile && /^\d+$/.test(feld.vordruckzeile);
        const zeileRx = hasZeile ? new RegExp(`\\b${feld.vordruckzeile}\\b`) : null;
        let hit: Phase1RegexHit | null = null;

        // Pass A — 4-Faktor (streng): vordruckzeile + drucktext + value + format
        if (hasZeile && zeileRx) {
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.length === 0) continue;
            if (!zeileRx.test(line)) continue;
            const m = druckRx.exec(line);
            if (!m) continue;
            const druckEnd = m.index + m[0].length;
            const rawValue = extractRawValueAfter(line, druckEnd, feld.datentyp);
            if (!rawValue) continue;
            const normalized = normalizeForElster(rawValue, feld.datentyp);
            if (normalized === null) continue;
            if (!passesFormat(normalized, feld)) continue;
            hit = {
              eCode: feld.eCode,
              value: rawValue,
              normalized,
              origin: 'REGEX_100%',
              evidence_line: line,
              kontextPath: feld.einkunftsart,
              anlage,
              drucktext: feld.drucktext,
              vordruckzeile: feld.vordruckzeile,
              datentyp: feld.datentyp,
            };
            break;
          }
        }

        // Pass B — 3-Faktor (Fallback für Quellbelege ohne ELSTER-Zeilenanker):
        // nur Drucktext + Value + Format. Erfordert genug langen, ambig-resistenten
        // Drucktext (Default ≥12 Zeichen), z.B. "Bruttoarbeitslohn".
        if (!hit && threeFaktor && feld.drucktext.length >= minLen3F) {
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.length === 0) continue;
            const m = druckRx.exec(line);
            if (!m) continue;
            const druckEnd = m.index + m[0].length;
            const rawValue = extractRawValueAfter(line, druckEnd, feld.datentyp);
            if (!rawValue) continue;
            const normalized = normalizeForElster(rawValue, feld.datentyp);
            if (normalized === null) continue;
            if (!passesFormat(normalized, feld)) continue;
            hit = {
              eCode: feld.eCode,
              value: rawValue,
              normalized,
              origin: 'REGEX_3F',
              evidence_line: line,
              kontextPath: feld.einkunftsart,
              anlage,
              drucktext: feld.drucktext,
              vordruckzeile: feld.vordruckzeile,
              datentyp: feld.datentyp,
            };
            break;
          }
        }

        if (hit) {
          regex_hits[feld.eCode] = hit;
        } else {
          missing_ecodes.push(feld.eCode);
        }
      }

      const hitCount = Object.keys(regex_hits).length;
      result[anlage] = {
        anlage,
        regex_hits,
        missing_ecodes,
        fieldCount: felder.length,
        hitCount,
        durationMs: Date.now() - tA,
      };
      totalHits += hitCount;
      totalMissing += missing_ecodes.length;
      ctx.emit('phase1_anlage_done', {
        anlage,
        hits: hitCount,
        missing: missing_ecodes.length,
        durationMs: result[anlage].durationMs,
      });
    }

    await ctx.artifacts.write('phase1_regex.json', result);
    ctx.emit('phase1_done', { totalHits, totalMissing, anlagen: Object.keys(result).length });
    return { per_anlage: result, totalHits, totalMissing, ms: Date.now() - t0 };
  },
});
