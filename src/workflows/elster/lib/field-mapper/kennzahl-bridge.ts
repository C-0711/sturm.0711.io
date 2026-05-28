/**
 * kennzahl-bridge — E-Code → Sachbereich.Kennzahl (ERiC-Adressierung).
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Die Kennzahl (Kz) ist das universelle ELSTER-Feld-Adressierungs-System.
 *  ERiC adressiert Steuerdaten beim Einreichen per (Sachbereich, Kennzahl) —
 *  NICHT per E-Code (das ist nur der XSD-Element-Name). Diese Brücke ist
 *  die Vorbereitung für den ERiC-Submission-Schritt.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Drei Nummernkreise (catalog elster_catalog):
 *   • LStB-Nr / Anlage-Zeile  → im QUELL-Beleg gedruckt (Extraktions-Anker)
 *   • Kennzahl (Sachbereich.Kz) → ERiC-Submission-Adressierung  ◀── DIESE
 *   • Vordruckzeile             → Druckbild / XSD-Sequence
 *
 * Person-Kodierung: der Sachbereich (+ lfd_nr_vordruck) kodiert die
 * Person/Instanz bei mehrfach-vorkommenden Anlagen:
 *   E0200201 (Bruttoarbeitslohn, shared):
 *     Sachbereich 47 · Kz 110 · lfd_nr 1  → Person A
 *     Sachbereich 48 · Kz 110 · lfd_nr 2  → Person B
 *   (Anlage R analog 71/72.) lfd_nr_vordruck = 1 → A, 2 → B.
 *
 * Quelle: catalog vw_sb_kz_to_code (3016 Zeilen), live verifiziert.
 *
 * Verwendung:
 *   const enriched = await annotateWithKennzahl(mappedFields, { pool, vz });
 *   // jedes Feld trägt nun { kennzahl: { sachbereich, kennzahl, lfdNr } }
 *   // unresolved[] listet E-Codes ohne Kennzahl (Sanity-Signal).
 */
import type pg from 'pg';
import type { MappedField, Person } from './types.ts';

export interface KennzahlRef {
  /** Sachbereich, z.B. "47" (Anlage N Person A). */
  sachbereich: string;
  /** Kennzahl innerhalb des Sachbereichs, z.B. "110". */
  kennzahl: string;
  /** lfd. Nr. des Vordrucks (Instanz): 1 = Person A, 2 = Person B, … */
  lfdNr: number | null;
  /** Anlage laut Catalog. */
  anlage: string;
}

export type EnrichedField = MappedField & { kennzahl?: KennzahlRef };

export interface KennzahlBridgeResult {
  enriched: EnrichedField[];
  /** E-Codes für die keine Kennzahl gefunden wurde (z.B. interne Felder). */
  unresolved: Array<{ eCode: string; person: Person; anlage: string }>;
  /** Anteil aufgelöster Felder (0..1). */
  coverage: number;
}

interface KzRow {
  code: string;
  sachbereich: string;
  kennzahl: string;
  lfd_nr_vordruck: number | null;
  anlage: string;
}

async function loadKennzahlRows(
  pool: pg.Pool,
  eCodes: string[],
  vz: number,
): Promise<Map<string, KzRow[]>> {
  const uniq = [...new Set(eCodes)];
  if (uniq.length === 0) return new Map();
  const { rows } = await pool.query<KzRow>(
    `SELECT code, sachbereich, kennzahl, lfd_nr_vordruck, anlage
       FROM elster.vw_sb_kz_to_code
      WHERE code = ANY ($1::text[]) AND vz = $2`,
    [uniq, vz],
  );
  const map = new Map<string, KzRow[]>();
  for (const r of rows) {
    const arr = map.get(r.code) ?? [];
    arr.push(r);
    map.set(r.code, arr);
  }
  return map;
}

/**
 * Wählt aus den Kennzahl-Kandidaten eines E-Codes den, der zur Person +
 * Anlage des Feldes passt.
 *
 * Regel:
 *   1. Filter auf passende Anlage (E-Code kann in mehreren Anlagen sein).
 *   2. Person A → lfd_nr_vordruck = 1 (oder niedrigste); Person B → 2.
 *   3. Nur ein Kandidat → den nehmen (kein Person-Split).
 */
function pickKennzahl(rows: KzRow[], field: MappedField): KennzahlRef | undefined {
  if (rows.length === 0) return undefined;
  let pool = rows.filter((r) => r.anlage === field.anlage);
  if (pool.length === 0) pool = rows; // Anlage-Mismatch → alle Kandidaten

  if (pool.length === 1) {
    const r = pool[0];
    return { sachbereich: r.sachbereich, kennzahl: r.kennzahl, lfdNr: r.lfd_nr_vordruck, anlage: r.anlage };
  }

  // Mehrere Instanzen → per Person über lfd_nr_vordruck wählen
  const wantLfd = field.person === 'B' ? 2 : 1;
  const byLfd = pool.find((r) => r.lfd_nr_vordruck === wantLfd);
  const chosen = byLfd ?? [...pool].sort((a, b) => (a.lfd_nr_vordruck ?? 99) - (b.lfd_nr_vordruck ?? 99))[0];
  return { sachbereich: chosen.sachbereich, kennzahl: chosen.kennzahl, lfdNr: chosen.lfd_nr_vordruck, anlage: chosen.anlage };
}

export interface KennzahlBridgeOptions {
  pool: pg.Pool;
  vz: number;
}

/**
 * Reichert MappedField[] um die Sachbereich.Kennzahl-Adressierung an.
 * Ein batched PG-Query für alle E-Codes.
 */
export async function annotateWithKennzahl(
  fields: MappedField[],
  opts: KennzahlBridgeOptions,
): Promise<KennzahlBridgeResult> {
  const rowMap = await loadKennzahlRows(opts.pool, fields.map((f) => f.eCode), opts.vz);
  const enriched: EnrichedField[] = [];
  const unresolved: KennzahlBridgeResult['unresolved'] = [];

  for (const f of fields) {
    const rows = rowMap.get(f.eCode) ?? [];
    const kz = pickKennzahl(rows, f);
    if (kz) {
      enriched.push({ ...f, kennzahl: kz });
    } else {
      enriched.push({ ...f });
      unresolved.push({ eCode: f.eCode, person: f.person, anlage: f.anlage });
    }
  }

  const resolvedCount = enriched.filter((f) => f.kennzahl).length;
  return {
    enriched,
    unresolved,
    coverage: fields.length > 0 ? resolvedCount / fields.length : 1,
  };
}

/**
 * Formatiert eine Kennzahl-Referenz als ERiC-Adresse "SB.Kz" für Logs/Audit.
 */
export function formatKennzahl(kz: KennzahlRef | undefined): string {
  if (!kz) return '—';
  return `${kz.sachbereich}.${kz.kennzahl}`;
}
