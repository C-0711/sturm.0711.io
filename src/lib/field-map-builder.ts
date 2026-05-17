/**
 * field-map-builder — felderNarrow output → vision-prompt text + JSON schema.
 *
 * Reproduziert das im v6-Vision-Spike als robust erwiesene Prompt-Pattern:
 *   1. Eine explizite eCode-Tabelle (eCode | Anlage | Zeile | Bezeichnung) im
 *      Prompt-TEXT (load-bearing), und
 *   2. Ein strict JSON-Schema fuer vLLM constrained decoding (nur strukturelle
 *      Typisierung; die `description`-Felder werden vom Modell nicht honoriert).
 *
 * Lessons-learned: v6 v1 (Schema-`description` only) = 13% korrekt;
 * v6 v2 (Mapping im Prompt-Text) = 93% korrekt. Dieses Helper baut das v2-
 * Pattern aus dem felder-narrow-Output deterministisch zusammen.
 *
 * Pure: keine I/O, keine env, keine externen Deps.
 */
import type { AnlagenFelderListe, AnlagenFeld } from './elster-catalog.ts';

export interface FieldMapEntry {
  eCode: string;
  anlage: string;
  drucktext: string;
  vordruckzeile?: string;
  /** 'string' | 'date' | 'currency' | ... (frei, abgeleitet aus AnlagenFeld). */
  datentyp: string;
  pflicht: boolean;
  /** Vorgebaute Zeile fuer die Prompt-Tabelle. */
  hintLine: string;
}

export interface FieldMapJsonSchema {
  name: string;
  schema: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, { type: ['string', 'null'] }>;
    /** With strict mode, OpenAI/vLLM require ALL property keys to be listed
     *  here so the model emits an explicit string-or-null for every field
     *  rather than silently skipping ones it isn't confident about. Without
     *  this, completion_tokens stayed at ~64 for batches over Vorsorge pages
     *  — model just wrote {"E1900702":"8","E1903702":"1,99"} and stopped. */
    required: string[];
  };
  strict: true;
}

export interface FieldMapStats {
  totalFields: number;
  pflichtCount: number;
  byAnlage: Record<string, number>;
  /** Anzahl per maxFields-Cap verworfener Nicht-Pflicht-Felder. */
  droppedByCap: number;
}

export interface FieldMapResult {
  /** Prompt-Text mit Header + sortierter Tabelle. */
  mapText: string;
  /** JSON-Schema fuer constrained decoding. */
  jsonSchema: FieldMapJsonSchema;
  /** eCodes in der finalen Reihenfolge (nach Sort + Cap). */
  fields: FieldMapEntry[];
  stats: FieldMapStats;
}

export interface BuildFieldMapOptions {
  /** felderNarrow-Output: Anlage-Key → AnlagenFelderListe. */
  perAnlage: Record<string, AnlagenFelderListe>;
  /** Auf diese Anlagen einschraenken. Wenn fehlt: alle aus perAnlage. */
  anlagenSubset?: string[];
  /** Schema-Name fuer das JSON-Schema. Default 'elster_extract'. */
  schemaName?: string;
  /** Obergrenze fuer Gesamt-Felder (Prompt-Budget). Default 80.
   *  Bei Ueberschreitung werden Nicht-Pflicht-Felder zuerst verworfen
   *  (die Sortierung garantiert, dass sie am Ende stehen). */
  maxFields?: number;
  /** Eigene Hint-Funktion pro datentyp. Default: deutsche Hints. */
  hintForDatentyp?: (datentyp: string) => string;
}

const HEADER = 'FELD-MAPPING (eCode | Anlage | Zeile | Bezeichnung):';

function defaultHintForDatentyp(datentyp: string): string {
  switch (datentyp) {
    case 'currency':
      return '(Eurobetrag z.B. "1.234,56")';
    case 'date':
      return '(Datum DD.MM.YYYY)';
    case 'integer':
      return '(Ganzzahl)';
    case 'string':
    default:
      return '';
  }
}

/** Escapt das Pipe-Zeichen in einem Drucktext, damit die Tabelle lesbar bleibt. */
function sanitizeDrucktext(s: string): string {
  return (s ?? '').replace(/\|/g, '/');
}

function renderHintLine(args: {
  eCode: string;
  anlage: string;
  vordruckzeile: string | undefined;
  drucktext: string;
  datentyp: string;
  hintForDatentyp: (datentyp: string) => string;
}): string {
  const zeile = args.vordruckzeile && args.vordruckzeile.trim().length > 0
    ? args.vordruckzeile
    : '-';
  const hint = args.hintForDatentyp(args.datentyp);
  const drucktext = sanitizeDrucktext(args.drucktext || args.eCode);
  const tail = hint ? ` ${hint}` : '';
  return `${args.eCode} | ${args.anlage} | ${zeile} | ${drucktext}${tail}`;
}

function compareEntries(a: FieldMapEntry, b: FieldMapEntry): number {
  // 1. Anlage alphabetisch
  if (a.anlage !== b.anlage) return a.anlage < b.anlage ? -1 : 1;
  // 2. Pflicht zuerst
  if (a.pflicht !== b.pflicht) return a.pflicht ? -1 : 1;
  // 3. Vordruckzeile numerisch aufsteigend (NaN ans Ende)
  const za = Number(a.vordruckzeile);
  const zb = Number(b.vordruckzeile);
  const aHas = Number.isFinite(za);
  const bHas = Number.isFinite(zb);
  if (aHas && bHas && za !== zb) return za - zb;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  // 4. eCode lexikographisch
  if (a.eCode !== b.eCode) return a.eCode < b.eCode ? -1 : 1;
  return 0;
}

export function buildFieldMap(opts: BuildFieldMapOptions): FieldMapResult {
  const perAnlage = opts.perAnlage ?? {};
  const schemaName = opts.schemaName ?? 'elster_extract';
  const maxFields = opts.maxFields ?? 80;
  const hintForDatentyp = opts.hintForDatentyp ?? defaultHintForDatentyp;

  // Subset-Filter: wenn anlagenSubset definiert, nur diese Anlagen — unbekannte
  // werden still uebersprungen (Edge-Case der Spec).
  const subset: Set<string> | null = opts.anlagenSubset
    ? new Set(opts.anlagenSubset)
    : null;

  const seenECodes = new Set<string>();
  const entries: FieldMapEntry[] = [];

  for (const [anlageKey, liste] of Object.entries(perAnlage)) {
    if (subset && !subset.has(anlageKey)) continue;
    const felder: AnlagenFeld[] = liste?.felder ?? [];
    for (const f of felder) {
      if (!f?.eCode) continue;
      if (seenECodes.has(f.eCode)) continue; // first-wins dedup
      seenECodes.add(f.eCode);
      const entry: FieldMapEntry = {
        eCode: f.eCode,
        anlage: anlageKey,
        drucktext: f.drucktext ?? '',
        vordruckzeile: f.vordruckzeile,
        datentyp: f.datentyp ?? 'string',
        pflicht: !!f.pflicht,
        hintLine: '', // set right below
      };
      entry.hintLine = renderHintLine({
        eCode: entry.eCode,
        anlage: entry.anlage,
        vordruckzeile: entry.vordruckzeile,
        drucktext: entry.drucktext,
        datentyp: entry.datentyp,
        hintForDatentyp,
      });
      entries.push(entry);
    }
  }

  // Sortieren: Pflicht-zuerst pro Anlage. Die Sortierung garantiert, dass
  // beim maxFields-Cap die nicht-pflicht-Felder am Ende stehen — sie fliegen
  // also zuerst raus.
  entries.sort(compareEntries);

  // Cap anwenden.
  let droppedByCap = 0;
  let capped = entries;
  if (entries.length > maxFields) {
    droppedByCap = entries.length - maxFields;
    capped = entries.slice(0, maxFields);
  }

  // mapText bauen.
  const lines = [HEADER];
  for (const e of capped) {
    lines.push(`  ${e.hintLine}`);
  }
  const mapText = lines.join('\n');

  // jsonSchema bauen.
  const properties: Record<string, { type: ['string', 'null'] }> = {};
  const required: string[] = [];
  for (const e of capped) {
    properties[e.eCode] = { type: ['string', 'null'] };
    required.push(e.eCode);
  }
  const jsonSchema: FieldMapJsonSchema = {
    name: schemaName,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    },
    strict: true,
  };

  // Stats.
  const byAnlage: Record<string, number> = {};
  let pflichtCount = 0;
  for (const e of capped) {
    byAnlage[e.anlage] = (byAnlage[e.anlage] ?? 0) + 1;
    if (e.pflicht) pflichtCount++;
  }
  const stats: FieldMapStats = {
    totalFields: capped.length,
    pflichtCount,
    byAnlage,
    droppedByCap,
  };

  return { mapText, jsonSchema, fields: capped, stats };
}
