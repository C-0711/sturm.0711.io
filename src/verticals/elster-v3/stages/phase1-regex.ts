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
  /** True wenn die OCR-Zeile mit der erwarteten vordruckzeile als
   *  führendem Label-Token beginnt (z.B. "13 …" für vordruckzeile=13).
   *  False = Fallback ohne Zeilen-Anker → soll downstream `trust='suspicious'`
   *  triggern (siehe phase5-merge). Bei eCodes ohne vordruckzeile bleibt
   *  das Flag undefined und wird wie ein anchored-Match behandelt. */
  zeile_anchored?: boolean;
  /** True wenn (value, drucktext) in ≥ repeatedValueSuspicionThreshold eCodes
   *  über ≥2 Anlagen auftaucht — Signal für OCR-Platzhalter (z.B. WISO
   *  "Bezeichnung 456" auf jeder Anlage). Post-Pass-Flag. */
  repeat_suspicious?: boolean;
  /** Citation: 0-based index of the OCR page where `evidence_line` was found.
   *  Populated when the OCR input includes per-page text; left undefined when
   *  upstream only provided the joined string. Downstream (phase5-merge →
   *  canonical_layer → aggregate → Pro-Abrechnung UI) uses this to render
   *  clickable "jump to source page" chips. */
  page?: number;
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
   *  Default 8 — kurz genug für "Lohnsteuer" (10) und "Konfession" (10),
   *  lang genug um false positives wie "Art" / "Nr." zu blocken.
   *  Word-Boundary-Matching kompensiert die niedrigere Grenze. */
  minDrucktextLength3F?: number;
  /** Bei mehreren Atomen mit identischem (drucktext+vordruckzeile+datentyp):
   *  alle matchen statt nur das erste (Default true). BMF hat Duplikate
   *  wie E0200201/202/203/204 für "Bruttoarbeitslohn" – jede Variante
   *  bezieht sich auf einen anderen Kontext (Person A/B, sum/einz). */
  matchDuplicateECodes?: boolean;
  /** Bei mehreren Kandidaten-Zeilen: bevorzuge diejenige, deren führendes
   *  Label-Token === feld.vordruckzeile ist. Verhindert dass "48 Bezeichnung 456"
   *  einen anderen Bezeichnung-eCode mit vordruckzeile=23 trifft. Default true
   *  in v5.2-rag; auf false setzen für strikte Rückwärtskompatibilität (v4). */
  vordruckzeileAnchor?: boolean;
  /** Post-Pass: (value, drucktext) das in ≥ N eCodes über ≥2 Anlagen vorkommt
   *  wird als OCR-Platzhalter (WISO "Bezeichnung 456") markiert (zeile_anchored
   *  bleibt unverändert, aber repeat_suspicious=true). Downstream-trust wird
   *  in phase5-merge auf 'suspicious' gesetzt. Default 3. Auf 0 setzen → off. */
  repeatedValueSuspicionThreshold?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a drucktext-Regex that matches as a "label" — preceded by start-of-
 *  line, whitespace, table-pipe, or a digit-dot (like "3."). Avoids matching
 *  drucktext as a fragment inside another word.
 *  Example: drucktext "Lohnsteuer" matches "| Lohnsteuer |" and "4. Lohnsteuer"
 *  but NOT "Bauernlohnsteuer" (theoretically). */
function buildDrucktextRegex(drucktext: string): RegExp {
  // Tolerate single trailing punctuation in stored drucktexts (some BMF
  // strings end in ":" or "-").
  const cleaned = drucktext.replace(/[\s:.;,-]+$/, '');
  const escaped = escapeRegex(cleaned);
  // Boundary: start-of-string, whitespace, pipe, dot+space (table prefix
  // like "4. Lohnsteuer"), or word boundary fallback.
  return new RegExp(`(?:^|[\\s|]|\\d+\\.\\s)${escaped}\\b`, 'i');
}

/** Markdown-table-aware extraction: for lines of shape
 *    `| <cellPrefix> | <drucktext> | <value> |`
 *  return the cell content AFTER the drucktext-cell, regardless of where
 *  drucktextEnd lands. Falls back to slice-after-drucktext for non-table lines. */
function extractTableCellAfterDrucktext(line: string, drucktextEnd: number): string | null {
  if (!line.includes('|')) return null;
  // Find the cell boundary AFTER drucktextEnd: the next "|" delimits the
  // drucktext-cell; the cell that follows is the value-cell.
  const sliceFromDt = line.slice(drucktextEnd);
  const firstPipeAfter = sliceFromDt.indexOf('|');
  if (firstPipeAfter < 0) return null;
  const rest = sliceFromDt.slice(firstPipeAfter + 1);
  // Value cell ends at next "|" or end-of-line
  const nextPipe = rest.indexOf('|');
  const valueCell = (nextPipe < 0 ? rest : rest.slice(0, nextPipe)).trim();
  return valueCell.length > 0 ? valueCell : null;
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

/** Extrahiert die führende Label-Nummer aus einer OCR-Zeile.
 *  Erkennt: "13 Arbeitnehmerbeiträge …" → "13"
 *           " 22. b) Bezeichnung 456"   → "22"  (Dot/Sub-Marker erlaubt)
 *           "| 5 | Lohnsteuer | 1.234 |" → "5"  (Markdown-Table-Cell)
 *           "Arbeitnehmer 1.243"        → null (kein Label-Token)
 *  Wir wollen nur isolierte 1-3-stellige Zahlen am Zeilen- bzw. Cell-Anfang.
 *  Pure Hilfsfunktion, exportiert für Tests. */
export function leadingLabelNumber(line: string): string | null {
  // Markdown-Table: erste Zelle abstreifen, falls die erste Zelle leer/Marker
  // ist und die nächste Zelle eine Zahl enthält.
  const tableCell = line.match(/^\s*\|\s*([^|]+?)\s*\|/);
  const head = tableCell ? tableCell[1] : line;
  // Erkennt "13", " 13 ", "13.", "13. b)", "13)", "13 Arbeitnehmer…"
  const m = head.match(/^\s*(\d{1,3})(?:[.)\s]|$)/);
  return m ? m[1] : null;
}

/** BMF-formatRegex enthält Perl-Style `\Q...\E` (literal-Block) für Enum-
 *  Felder (z.B. Konfession `\Q11\E|\Q03\E|…`). JS-Regex versteht das nicht
 *  und matched es wörtlich. Wir konvertieren zu `(?:11|03|…)`. */
function normalizeFormatRegex(re: string): string {
  return re.replace(/\\Q([\s\S]*?)\\E/g, (_, inner) =>
    inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
}

/** BMF hat zwei Currency-Wire-Formats nebeneinander:
 *  • Cents-Form  (E0200201 etc.):  "^(?=.{1,12}$)(?!0\d)\d{1,12}$"          → 753200
 *  • DE-Decimal  (E0200301 etc.):  "^(?=.{4,15}$)(?!0\d)\d{1,12}(,\d{2,2})$" → 7532,00
 *  Wir geben dem Format-Check beide Kandidaten und nehmen den der passt. */
function currencyCandidates(centsNormalized: string): string[] {
  if (!/^-?\d+$/.test(centsNormalized)) return [centsNormalized];
  const neg = centsNormalized.startsWith('-');
  const abs = neg ? centsNormalized.slice(1) : centsNormalized;
  if (abs.length < 1) return [centsNormalized];
  const euros = abs.length > 2 ? abs.slice(0, -2) : '0';
  const cents = abs.length > 2 ? abs.slice(-2) : abs.padStart(2, '0');
  const deDec = `${neg ? '-' : ''}${euros},${cents}`;
  return [centsNormalized, deDec];
}

/** Validiert: normalized erfüllt formatRegex + Längen-Grenzen.
 *  Gibt die akzeptierte Form zurück (manchmal != input wenn das Atom DE-
 *  Decimal statt Cents verlangt). Null = passt nicht. */
function passesFormatWithCoercion(
  normalized: string,
  atom: AnlagenFeld,
): string | null {
  const safeRegexSource = normalizeFormatRegex(atom.formatRegex);
  let re: RegExp;
  try { re = new RegExp(safeRegexSource); } catch { return null; }
  const candidates = atom.datentyp === 'currency'
    ? currencyCandidates(normalized)
    : [normalized];
  for (const c of candidates) {
    if (atom.minLaenge !== undefined && c.length < atom.minLaenge) continue;
    if (atom.maxLaenge !== undefined && c.length > atom.maxLaenge) continue;
    if (re.test(c)) return c;
  }
  return null;
}

/** Legacy alias for callers that only need boolean. */
function passesFormat(normalized: string, atom: AnlagenFeld): boolean {
  return passesFormatWithCoercion(normalized, atom) !== null;
}
void passesFormat; // wird vom externen Code referenziert; kein toter Export

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
    const minLen3F = cfg.minDrucktextLength3F ?? 8;
    const zeileAnchor = cfg.vordruckzeileAnchor ?? true;
    const repeatThreshold = cfg.repeatedValueSuspicionThreshold ?? 3;
    // Duplikat-eCode-Match ist heute strukturell schon gegeben (jeder eCode hat
    // seine eigene Schleife). Flag bleibt für zukünftige Dedup-Variante reserviert.
    const _matchDuplicates = cfg.matchDuplicateECodes ?? true;
    void _matchDuplicates;

    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new Error('phase1-regex: input.text required');
    }
    // P10: phase1-regex consumes per_anlage as a pre-built list; no catalog
    // lookup needed. The earlier P7 probe was dropped — re-add a
    // `ctx.tools.get('elster-catalog')` here when this stage needs cat.get('atoms').
    const perAnlage = input.per_anlage ?? {};
    const lines = input.text.split(/\r?\n/);

    // Citation infra (P1): build line→page index so each hit can carry the
    // 0-based page where its evidence_line was found. Tracks the current
    // page by parsing "Seite N von M" markers as we walk the lines. Lines
    // before the first marker stay on page -1 (unknown). Mirrors the
    // splitOcrByPages logic in lib/page-anlage-detect.ts.
    const pageByLine: number[] = new Array(lines.length);
    {
      let currentPage = -1; // before first "Seite N" marker
      const headerRx = /Seite\s+(\d+)\s+von\s+\d+/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(headerRx);
        if (m) {
          const parsed = parseInt(m[1], 10);
          if (Number.isFinite(parsed) && parsed >= 1) {
            currentPage = parsed - 1; // 1-based → 0-based
          }
        }
        pageByLine[i] = currentPage;
      }
    }

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

        // Word-boundary-Drucktext-Match (verhindert Substring-False-Positives:
        // "Lohnsteuer" matched nicht mehr versehentlich in "Lohnsteuerbescheinigung").
        // Plus: Markdown-Table-Cell-Aware value extraction für VaSt-Layouts.
        const druckRx = buildDrucktextRegex(feld.drucktext);
        const hasZeile = feld.vordruckzeile && /^\d+$/.test(feld.vordruckzeile);
        const zeileRx = hasZeile ? new RegExp(`\\b${feld.vordruckzeile}\\b`) : null;

        /** Try one line, return hit if matches all factors (or null).
         *  lineIdx is the index into `lines` (and `pageByLine`) so the hit
         *  can carry the 0-based page where it was matched. */
        const tryLine = (rawLine: string, lineIdx: number, requireZeile: boolean, origin: 'REGEX_100%' | 'REGEX_3F'): Phase1RegexHit | null => {
          const line = rawLine.trim();
          if (line.length === 0) return null;
          if (requireZeile && zeileRx && !zeileRx.test(line)) return null;
          const m = druckRx.exec(line);
          if (!m) return null;
          const druckEnd = m.index + m[0].length;
          // First try table-cell-aware extraction (handles VaSt "| label | value |")
          // then fall back to slice-after-drucktext.
          let rawValue: string | null = extractTableCellAfterDrucktext(line, druckEnd);
          if (rawValue) {
            // Validate it's typgerecht — re-run the type-regex on the cell content.
            const m2 = extractRawValueAfter(`X ${rawValue}`, 2, feld.datentyp);
            rawValue = m2 ?? rawValue;
          } else {
            rawValue = extractRawValueAfter(line, druckEnd, feld.datentyp);
          }
          if (!rawValue) return null;
          const baseNormalized = normalizeForElster(rawValue, feld.datentyp);
          if (baseNormalized === null) return null;
          // Coerce to the atom's expected wire format (cents OR DE-decimal)
          // depending on what its formatRegex accepts; also fixes \Q…\E.
          const accepted = passesFormatWithCoercion(baseNormalized, feld);
          if (accepted === null) return null;
          // Bestimme ob die Zeile mit dem erwarteten Label-Token beginnt.
          // Anchor-Check ist tolerant: ohne vordruckzeile → undefined (kein
          // Downgrade); mit vordruckzeile → true/false.
          let anchored: boolean | undefined;
          if (hasZeile) {
            const lead = leadingLabelNumber(line);
            anchored = lead === feld.vordruckzeile;
          }
          const page = pageByLine[lineIdx];
          return {
            eCode: feld.eCode,
            value: rawValue,
            normalized: accepted,
            origin,
            evidence_line: line,
            kontextPath: feld.einkunftsart,
            anlage,
            drucktext: feld.drucktext,
            vordruckzeile: feld.vordruckzeile,
            datentyp: feld.datentyp,
            zeile_anchored: anchored,
            ...(page >= 0 ? { page } : {}),
          };
        };

        /** Wähle den besten Kandidaten aus N Treffern. Priorität:
         *   1. anchored (führende Label-Nummer == vordruckzeile) + langer drucktext
         *   2. anchored mit kürzerem drucktext
         *   3. nicht-anchored, längster drucktext-Match
         *   4. erster Match (Fallback) */
        const pickBest = (cands: Phase1RegexHit[]): Phase1RegexHit | null => {
          if (cands.length === 0) return null;
          if (cands.length === 1) return cands[0];
          // Sortier-Score: anchored vorne, dann nach drucktext.length absteigend.
          // Wenn vordruckzeileAnchor=false → ignoriere anchored-Bit (legacy).
          const scored = cands.map((c) => ({
            c,
            anchorScore: zeileAnchor && c.zeile_anchored === true ? 2
                       : c.zeile_anchored === undefined ? 1
                       : 0,
            druckLen: c.drucktext.length,
          }));
          scored.sort((a, b) => {
            if (a.anchorScore !== b.anchorScore) return b.anchorScore - a.anchorScore;
            if (a.druckLen !== b.druckLen) return b.druckLen - a.druckLen;
            return 0;
          });
          return scored[0].c;
        };

        let hit: Phase1RegexHit | null = null;
        // Pass A — 4-Faktor (streng) — kollektiere ALLE matchenden Zeilen,
        // wähle die anchored bevorzugt.
        if (hasZeile) {
          const cands: Phase1RegexHit[] = [];
          for (let i = 0; i < lines.length; i++) {
            const h = tryLine(lines[i], i, true, 'REGEX_100%');
            if (h) cands.push(h);
          }
          hit = pickBest(cands);
        }
        // Pass B — 3-Faktor (Quellbelege ohne ELSTER-Zeilenanker).
        // Auch hier: sammle alle Kandidaten und wähle anchored bevorzugt.
        // Das verhindert dass "48 Bezeichnung 456" (WISO-Platzhalter) einen
        // Bezeichnung-eCode mit vordruckzeile=23 trifft, wenn es eine Zeile
        // "23 Bezeichnung …" gibt.
        if (!hit && threeFaktor && feld.drucktext.length >= minLen3F) {
          const cands: Phase1RegexHit[] = [];
          for (let i = 0; i < lines.length; i++) {
            const h = tryLine(lines[i], i, false, 'REGEX_3F');
            if (h) cands.push(h);
          }
          hit = pickBest(cands);
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

    // ── Post-Pass: cross-Anlage value-repeat suspicion ──────────────────
    // Wenn dieselbe (value, drucktext)-Kombination in ≥ repeatThreshold
    // eCodes über ≥2 Anlagen auftaucht → markiere alle als repeat_suspicious.
    // Fängt WISO-Platzhalter wie "48 Bezeichnung 456" generisch ab (ohne
    // Hardcoding der Zahlen). Downstream-Trust wird in phase5-merge auf
    // 'suspicious' gesetzt → BMF-Pipeline ignoriert sie.
    if (repeatThreshold > 0) {
      type Occ = { hit: Phase1RegexHit; anlage: string };
      const buckets = new Map<string, Occ[]>();
      for (const [anlage, ar] of Object.entries(result)) {
        for (const h of Object.values(ar.regex_hits)) {
          const valStr = String(h.value ?? '').trim();
          const druckStr = (h.drucktext ?? '').trim();
          if (!valStr || !druckStr) continue;
          const key = `${valStr} ${druckStr}`;
          let arr = buckets.get(key);
          if (!arr) { arr = []; buckets.set(key, arr); }
          arr.push({ hit: h, anlage });
        }
      }
      let repeatFlags = 0;
      for (const [, occs] of buckets) {
        if (occs.length < repeatThreshold) continue;
        const distinctAnlagen = new Set(occs.map((o) => o.anlage));
        if (distinctAnlagen.size < 2) continue;
        for (const o of occs) {
          o.hit.repeat_suspicious = true;
          repeatFlags++;
        }
      }
      if (repeatFlags > 0) {
        ctx.emit('phase1_repeat_suspicion', {
          flagged: repeatFlags,
          threshold: repeatThreshold,
        });
      }

      // Pass 2 — value-only repeat detector (WISO "456"-Style).
      // WISO-Tests setzen denselben numerischen Platzhalter ("456") in viele
      // Anlagen ein, ABER mit unterschiedlichem Drucktext pro Zeile (Kranken-
      // versicherung Nr 25, Pflegeversicherung Nr 26 …). Die (value, drucktext)-
      // Bucketing oben würde das nicht erkennen. Hier nochmal nur über den
      // Wert gruppieren — mit höherer Schwelle und Ausschluss trivialer
      // Kleinwerte (0, 1, 2), damit normale Wiederholungen nicht flaggen.
      const valueBuckets = new Map<string, Occ[]>();
      for (const [anlage, ar] of Object.entries(result)) {
        for (const h of Object.values(ar.regex_hits)) {
          if (h.datentyp !== 'currency') continue;
          const valStr = String(h.value ?? '').trim();
          if (!valStr) continue;
          // Skip trivial values that legitimately recur (0, kleine Ganzzahlen).
          // normalized ist hier integer-cents; 0..200 cents = nicht aussagekräftig.
          const cents = Number(h.normalized);
          if (!Number.isFinite(cents) || Math.abs(cents) <= 200) continue;
          let arr = valueBuckets.get(valStr);
          if (!arr) { arr = []; valueBuckets.set(valStr, arr); }
          arr.push({ hit: h, anlage });
        }
      }
      let valueRepeatFlags = 0;
      for (const [, occs] of valueBuckets) {
        // Höhere Schwelle als druck+value bucket: identical numeric value
        // across ≥3 eCodes auf ≥2 Anlagen → WISO-Verdacht.
        if (occs.length < 3) continue;
        const distinctAnlagen = new Set(occs.map((o) => o.anlage));
        if (distinctAnlagen.size < 2) continue;
        for (const o of occs) {
          if (o.hit.repeat_suspicious === true) continue;
          o.hit.repeat_suspicious = true;
          valueRepeatFlags++;
        }
      }
      if (valueRepeatFlags > 0) {
        ctx.emit('phase1_value_repeat_suspicion', {
          flagged: valueRepeatFlags,
        });
      }
    }

    await ctx.artifacts.write('phase1_regex.json', result);
    ctx.emit('phase1_done', { totalHits, totalMissing, anlagen: Object.keys(result).length });
    return { per_anlage: result, totalHits, totalMissing, ms: Date.now() - t0 };
  },
});
