/**
 * extractor-vordruckzeile — Voll-Erklärungs-Extraktor (ausgefüllte ELSTER-Druck).
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Eine ausgefüllte Einkommensteuererklärung (ELSTER-/WISO-Druck) druckt je
 *  Feld eine Zeile  "<Vordruckzeile-Nr>  <Label>   <Wert>"  pro Anlage:
 *
 *    Anlage N (… Person A)
 *      5  Bruttoarbeitslohn            63.559,90
 *      8  Kirchensteuer des AN            302,37
 *     33  einfache Entfernung in km        17
 *
 *  Der Catalog (vw_zeile_to_code, 2276 Zeilen) mappt (Anlage, Vordruckzeile)
 *  → E-Code. Damit ist die Extraktion DATEN-GETRIEBEN: Zeilen-Nr + Label-
 *  Match → E-Code. Kein per-Beleg-Schema nötig — anders als die VaSt-Belege
 *  ist dies das ganze, mehrseitige Formular.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Sicherheit: ein Treffer wird NUR emittiert, wenn das Zeilen-Label zum
 * Catalog-drucktext passt (verhindert Fehl-Mapping bei doppelten Zeilen-Nrn,
 * die OCR durch Fußnoten-Marker erzeugt). Person aus kontext_pfad (/A,/B)
 * bzw. dem Anlage-Section-Header ("Person A" / "Ehefrau / Person B").
 */
import type pg from 'pg';
import { normalize } from './normalizer.ts';
import type { MappedField, Person, ValueType } from './types.ts';

interface ZeileEntry {
  code: string;
  drucktext: string;
  kontextPfad: string;
  kanonisch: string | null;
  /** Bei Enum-Feldern: normalisierter Label-Text → ELSTER-Code ("erste
   *  Tätigkeitsstätte" → "1"). Undefined bei Nicht-Enum-Feldern. */
  enumMap?: Map<string, string>;
}
/** anlage → vordruckzeile → Kandidaten-E-Codes. */
export type VordruckMap = Map<string, Map<string, ZeileEntry[]>>;

const ANLAGE_HEADER = /^\s*(?:<b>\s*)?Anlage\s+([A-Za-zÄÖÜ_]+)/i;
const ANLAGE_ALIAS: Record<string, string> = {
  N: 'N', KAP: 'KAP', Vorsorgeaufwand: 'VOR', VOR: 'VOR',
  Sonderausgaben: 'SA', SA: 'SA', R: 'R', Kind: 'Kind', AV: 'AV',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');

/** Lädt die (Anlage, Vordruckzeile)→E-Code-Map + valueType + Enum-Maps. */
export async function loadVordruckMap(pool: pg.Pool, vz: number): Promise<VordruckMap> {
  // Enum-Werte je format_id: normalisiertes label_de → Code ("erste
  // Tätigkeitsstätte" → "1"). Erlaubt Text→Code-Auflösung der Druck-Werte.
  const { rows: enumRows } = await pool.query<{ format_id: string; wert: string; label_de: string | null }>(
    `SELECT et.format_id, ew.wert, ew.label_de
       FROM elster.enumeration_typ et
       JOIN elster.enumeration_wert ew ON ew.enum_typ_id = et.enum_typ_id
      WHERE et.vz = $1 AND et.format_id IS NOT NULL`,
    [vz],
  );
  const enumByFormat = new Map<string, Map<string, string>>();
  for (const r of enumRows) {
    const m = enumByFormat.get(r.format_id) ?? new Map<string, string>();
    enumByFormat.set(r.format_id, m);
    if (r.label_de) m.set(norm(r.label_de), r.wert);
    m.set(norm(r.wert), r.wert); // Code-als-Eingabe ebenfalls akzeptieren
  }

  const { rows } = await pool.query<{
    anlage: string; vordruckzeile: string; code: string;
    drucktext: string | null; kontext_pfad: string | null; kanonisch: string | null; format_id: string | null;
  }>(
    `SELECT z.anlage, z.vordruckzeile, z.code, z.drucktext, z.kontext_pfad, ft.kanonisch, f.format_id
       FROM elster.vw_zeile_to_code z
  LEFT JOIN elster.feld f       ON f.feld_id = z.feld_id
  LEFT JOIN elster.format_typ ft ON ft.format_id = f.format_id
      WHERE z.vz = $1 AND z.vordruckzeile ~ '^[0-9]'`,
    [vz],
  );
  const map: VordruckMap = new Map();
  for (const r of rows) {
    const a = map.get(r.anlage) ?? new Map<string, ZeileEntry[]>();
    map.set(r.anlage, a);
    const z = (r.vordruckzeile || '').replace(/[^0-9].*$/, ''); // "16a" → "16"
    if (!z) continue;
    const arr = a.get(z) ?? [];
    a.set(z, arr);
    arr.push({
      code: r.code, drucktext: r.drucktext ?? '', kontextPfad: r.kontext_pfad ?? '',
      kanonisch: r.kanonisch, enumMap: r.format_id ? enumByFormat.get(r.format_id) : undefined,
    });
  }
  return map;
}

/** Enum-Druck-Text → ELSTER-Code; null wenn nicht auflösbar. */
function resolveEnum(value: string, enumMap: Map<string, string>): string | null {
  const nv = norm(value);
  if (enumMap.has(nv)) return enumMap.get(nv)!;
  for (const [k, code] of enumMap) {
    const m = Math.min(10, k.length, nv.length);
    if (m >= 4 && (k.startsWith(nv.slice(0, m)) || nv.startsWith(k.slice(0, m)))) return code;
  }
  return null;
}

/** Label-Übereinstimmung Zeilen-Label ↔ Catalog-drucktext (Präfix-Overlap). */
function labelMatches(lineLabel: string, drucktext: string): boolean {
  const a = norm(lineLabel), b = norm(drucktext);
  if (!a || !b) return false;
  const k = Math.min(8, a.length, b.length);
  const pa = a.slice(0, k), pb = b.slice(0, k);
  return a.startsWith(pb) || b.startsWith(pa) || a.includes(pb) || b.includes(pa);
}

export interface VordruckResult {
  felder: MappedField[];
  /** Zeilen mit Wert, aber ohne Catalog-Treffer (Diagnose). */
  unmatched: Array<{ anlage: string; zeile: string; label: string; value: string }>;
}

/**
 * Parst den reading-order rawText der ausgefüllten Erklärung.
 * @param defaultPerson Mantelbogen-Person (Hauptperson), default 'A'.
 */
export function extractByVordruckzeile(
  rawText: string,
  map: VordruckMap,
  defaultPerson: Person = 'A',
): VordruckResult {
  const felder: MappedField[] = [];
  const unmatched: VordruckResult['unmatched'] = [];
  const seen = new Set<string>();
  let anlage = 'ESt1A';
  let sectionPerson: Person = defaultPerson;

  for (const rawLine of rawText.split(/\r?\n/)) {
    // Tags entfernen, aber Mehrfach-Spaces (Label↔Wert-Trenner) ERHALTEN.
    const line = rawLine.replace(/<\/?[a-z][a-z0-9]*>/gi, '').replace(/\t+/g, '   ').replace(/\s+$/, '');
    if (!line.trim()) continue;

    const ah = line.match(ANLAGE_HEADER);
    if (ah) {
      anlage = ANLAGE_ALIAS[ah[1]] ?? (/^ESt1A/i.test(ah[1]) ? 'ESt1A' : anlage);
      sectionPerson = /Ehefrau|Person\s*B/i.test(line) ? 'B' : 'A';
      continue;
    }

    const lm = line.match(/^\s*(\d{1,3})\s+(.+)$/);
    if (!lm) continue;
    const zeile = lm[1];
    const parts = lm[2].split(/\s{2,}/); // reading-order trennt Label↔Wert mit ≥2 Spaces
    if (parts.length < 2) continue;
    const label = parts[0].trim();
    const value = parts.slice(1).join(' ').trim();
    if (!value) continue;

    const cands = map.get(anlage)?.get(zeile);
    if (!cands || cands.length === 0) continue;

    const hit = cands.find((c) => labelMatches(label, c.drucktext));
    if (!hit) { unmatched.push({ anlage, zeile, label, value }); continue; }

    const person: Person = /\/B(\/|$)/.test(hit.kontextPfad) ? 'B'
      : /\/A(\/|$)/.test(hit.kontextPfad) ? 'A' : sectionPerson;
    const key = `${hit.code}|${person}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const vt = (hit.kanonisch ?? 'string') as ValueType;
    let wert: string;
    const warns: string[] = [`Vordruckzeile-Anker: ${anlage} Z.${zeile} → ${hit.code}`];
    if (hit.enumMap) {
      // Enum: Druck zeigt Klartext ("erste Tätigkeitsstätte") → XSD-Code ("1").
      const code = resolveEnum(value, hit.enumMap);
      if (code !== null) { wert = code; }
      else { const n = normalize(value, vt); wert = n.wert; warns.push(...(n.warnings ?? []), `Enum-Wert "${value}" nicht aufgelöst`); }
    } else {
      const n = normalize(value, vt); wert = n.wert; warns.push(...(n.warnings ?? []));
    }
    felder.push({
      eCode: hit.code, anlage, kontextSubpath: undefined,
      wert, rawValue: value, person,
      pdfLabel: hit.drucktext || label, valueType: vt,
      method: 'schema', confidence: 0.85, warnings: warns,
    });
  }
  return { felder, unmatched };
}
