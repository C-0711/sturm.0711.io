/**
 * Canonical ELSTER catalog atom — the **single source of truth** for every
 * piece of structural knowledge about an ELSTER eCode.
 *
 * The atoms in `src/verticals/elster-v3/data/atoms.json` already encode:
 *   • the canonical field name (`metadata.drucktext`)
 *   • where the value goes (`metadata.anlage`, `metadata.vordruckzeile`)
 *   • how to parse / validate it (`metadata.datentyp`, `metadata.formatRegex`,
 *     `metadata.formatkennzeichen`, `metadata.maxLaenge`, `metadata.minLaenge`)
 *   • whether the value is required (`metadata.pflicht`)
 *   • provenance + trust (`citation_document`, `trust_level`,
 *     `source_type`, `contributor_id`, `commit_hash`)
 *
 * Before this module existed, the same knowledge was duplicated in:
 *   - prompt strings (DOC_GUIDANCE in layer1-extract)
 *   - heuristic regex tables in cross-validator
 *   - per-stage atoms.json parsers
 *
 * Now every stage reads from here. Modifications to the catalog flow
 * one-way: re-encode the container, re-run calibration, ship.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ElsterDatentyp = 'string' | 'date' | 'currency';

/** ELSTER form (Anlage) codes — e.g. "N" = wages, "SA" = donations,
 *  "R" = pensions, "ESt1A" = main personal-data form. */
export type ElsterAnlage = string;

export interface ElsterAtomMetadata {
  /** The form on which this field appears, e.g. "N", "SA", "R". */
  anlage: ElsterAnlage;
  /** Value type — drives format regex, normalization, and value coercion. */
  datentyp: ElsterDatentyp;
  /** True if the form requires this field to be filled. */
  pflicht: boolean;
  /** Printed line number on the official BMF form (legal-citation anchor). */
  vordruckzeile: string;
  /** Human-readable field label as printed on the form. The canonical
   *  user-facing name; prefer this over the Bezeichnung in prompts. */
  drucktext: string;
  /** Per-atom format regex enforced by ELSTER's submission validator.
   *  Currency, date, and structural fields each have field-specific patterns
   *  (e.g. Postleitzahl is "currency"-typed but the regex is the 5-digit PLZ
   *   format, not generic currency). */
  formatRegex: string;
  /** ELSTER's compact type kennzeichen: 'N'=number, 'D'=date, 'X'=string. */
  formatkennzeichen?: string;
  maxLaenge?: number;
  minLaenge?: number;
  /** Internal kontext paths used by the BMF mapping. Informational. */
  kontextPaths?: string[];
}

export interface CatalogAtom {
  atom_id: string;
  container_id: string;
  layer_id: string;
  field_path: string;
  /** The eCode, e.g. "E0200201". */
  field_name: string;
  /** Bezeichnung — typically the German name from the official XML. */
  value: string;
  value_type: string;
  lang: string;
  citation_document: string;
  citation_section: string;
  citation_excerpt: string;
  citation_confidence: number;
  citation_method: string;
  /** "verified" → BMF primary source; lower trust levels would require
   *  human review before being accepted as ground truth. */
  trust_level: 'verified' | string;
  source_type: 'primary-source' | string;
  contributor_id: string;
  commit_hash: string;
  metadata: ElsterAtomMetadata;
}

// ─────────────────────────────────────────────────────────────────────────
// Cached loader
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_ATOMS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../verticals/elster-v3/data/atoms.json',
);

interface CatalogHandle {
  path: string;
  atoms: CatalogAtom[];
  byECode: Map<string, CatalogAtom>;
  byAnlage: Map<string, CatalogAtom[]>;
  byIdx: CatalogAtom[];
}

const CACHE = new Map<string, Promise<CatalogHandle>>();

export async function loadCatalog(path: string = DEFAULT_ATOMS_PATH): Promise<CatalogHandle> {
  let p = CACHE.get(path);
  if (p) return p;
  p = (async () => {
    const atoms = JSON.parse(await readFile(path, 'utf-8')) as CatalogAtom[];
    const byECode = new Map<string, CatalogAtom>();
    const byAnlage = new Map<string, CatalogAtom[]>();
    for (const a of atoms) {
      byECode.set(a.field_name, a);
      const list = byAnlage.get(a.metadata.anlage);
      if (list) list.push(a); else byAnlage.set(a.metadata.anlage, [a]);
    }
    return { path, atoms, byECode, byAnlage, byIdx: atoms };
  })();
  CACHE.set(path, p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Validators derived from the atom metadata
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize a German-formatted value into the canonical form that ELSTER's
 * regexes expect. Examples:
 *   • currency "1.234,56 €" → "123456"   (integer cents, sign-prefixed)
 *   • currency "1.234,56"   → "123456"
 *   • currency "-30.707,00" → "-3070700"
 *   • date     "31.12.2024" → "31.12.2024" (passthrough — already in DE form)
 *   • date     "2024-12-31" → "31.12.2024" (ISO → DE)
 *   • string                → passthrough trimmed
 *
 * The ELSTER `formatRegex` for currency atoms expects digits-only without
 * the locale separators. Coercion is a precondition for regex validation.
 */
export function normalizeForElster(value: unknown, datentyp: ElsterDatentyp): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value.trim() : String(value);
  if (s.length === 0) return null;

  switch (datentyp) {
    case 'currency': {
      // Strip currency symbol, spaces, thousands separators. Convert
      // comma decimal to dot, then convert to integer cents.
      // Accept inputs like: "1.234,56 €", "1234,56", "30707", "30707.00", "-30.707,00"
      let v = s.replace(/[€\sEUR]/gi, '');
      // Detect German vs ISO decimal: if both "." and "," appear and "," is
      // last → German (1.234,56). If only "." → ISO. If only "," → German.
      const lastComma = v.lastIndexOf(',');
      const lastDot = v.lastIndexOf('.');
      let normalized: string;
      if (lastComma > lastDot) {
        // German: dots are thousand separators, comma is decimal
        normalized = v.replace(/\./g, '').replace(',', '.');
      } else if (lastDot > lastComma && lastComma >= 0) {
        // Weird: both present, dot last → ISO-ish "1,234.56" — strip commas
        normalized = v.replace(/,/g, '');
      } else {
        // Only one separator (or none): treat dot as decimal
        normalized = v.replace(/,/g, '.');
      }
      const num = Number(normalized);
      if (!Number.isFinite(num)) return null;
      // Convert to cents (integer); strip sign separately to match regexes
      // that allow a leading "-".
      const cents = Math.round(num * 100);
      // Some ELSTER fields expect whole euros (the regex is field-specific).
      // We provide BOTH: the integer-cents form is the canonical input to
      // strict regexes that expect ≤12 digits without decimals.
      return String(cents);
    }
    case 'date': {
      // Accept "31.12.2024" and "2024-12-31" and "2024/12/31".
      let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (m) return `${m[3].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[1]}`;
      m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      if (m) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
      return null;
    }
    case 'string':
    default:
      return s;
  }
}

export interface FormatCheck {
  ok: boolean;
  /** The value as fed to the regex. */
  normalized: string | null;
  /** Why it failed, if it did. */
  reason?: string;
}

/**
 * Validate `value` against the atom's `formatRegex` after normalization.
 * Returns `{ok, normalized, reason}` — never throws.
 *
 * Length bounds are checked AGAINST THE NORMALIZED FORM, which is what
 * ELSTER's submission validator does. A currency stored as "30.707,00 €"
 * normalizes to "3070700" (7 chars) which fits a 12-char regex.
 */
export function checkFormat(value: unknown, atom: CatalogAtom): FormatCheck {
  const normalized = normalizeForElster(value, atom.metadata.datentyp);
  if (normalized === null) {
    return { ok: false, normalized: null, reason: 'null/empty after normalization' };
  }
  if (atom.metadata.minLaenge !== undefined && normalized.length < atom.metadata.minLaenge) {
    return { ok: false, normalized, reason: `len ${normalized.length} < minLaenge ${atom.metadata.minLaenge}` };
  }
  if (atom.metadata.maxLaenge !== undefined && normalized.length > atom.metadata.maxLaenge) {
    return { ok: false, normalized, reason: `len ${normalized.length} > maxLaenge ${atom.metadata.maxLaenge}` };
  }
  try {
    const re = new RegExp(atom.metadata.formatRegex);
    if (!re.test(normalized)) {
      return { ok: false, normalized, reason: `regex /${atom.metadata.formatRegex}/ did not match "${normalized}"` };
    }
  } catch (err) {
    return { ok: false, normalized, reason: `invalid regex in atom: ${(err as Error).message}` };
  }
  return { ok: true, normalized };
}

/**
 * Field-Eintrag pro Anlage — komprimierte View auf einen CatalogAtom für
 * die Verwendung in LLM-Prompts und dynamisch generierten JSON-Schemas.
 */
export interface AnlagenFeld {
  /** eCode wie "E0200201". */
  eCode: string;
  /** Wie auf dem Vordruck gedruckt — kanonischer Label-Text. */
  drucktext: string;
  /** Bezeichnung aus dem BMF-XML (Fallback wenn drucktext leer). */
  bezeichnung: string;
  datentyp: ElsterDatentyp;
  formatRegex: string;
  pflicht: boolean;
  vordruckzeile: string;
  /** BMF-kontextPath-Prefix → Einkunftsart-Identifier (z.B. "ArbL"). */
  einkunftsart: string | null;
  maxLaenge?: number;
  minLaenge?: number;
}

/** Geordnete Felder-Liste einer Anlage, wie sie ein LLM-Extract braucht. */
export interface AnlagenFelderListe {
  anlage: ElsterAnlage;
  felder: AnlagenFeld[];
}

/**
 * Liefert alle Atome einer Anlage als Felder-Liste, geordnet:
 *   1. Pflicht-Felder zuerst (pflicht=true)
 *   2. Innerhalb gleicher Pflicht-Klasse: aufsteigend nach vordruckzeile
 *
 * Wird von elster-v4/felder-katalog + container-extract genutzt — der Container
 * (atoms.json) ist single-source-of-truth, kein paralleler felder/*.json-Cache.
 */
export async function felderFuerAnlage(
  anlage: ElsterAnlage,
  path?: string,
): Promise<AnlagenFelderListe> {
  const handle = await loadCatalog(path);
  const atoms = handle.byAnlage.get(anlage) ?? [];
  const felder: AnlagenFeld[] = atoms
    .filter((a) => /^E\d+$/.test(a.field_name))
    .map((a) => ({
      eCode: a.field_name,
      drucktext: a.metadata.drucktext || a.value || a.field_name,
      bezeichnung: a.value,
      datentyp: a.metadata.datentyp,
      formatRegex: a.metadata.formatRegex,
      pflicht: a.metadata.pflicht,
      vordruckzeile: a.metadata.vordruckzeile,
      einkunftsart: einkunftsartVonAtom(a),
      maxLaenge: a.metadata.maxLaenge,
      minLaenge: a.metadata.minLaenge,
    }));
  felder.sort((a, b) => {
    if (a.pflicht !== b.pflicht) return a.pflicht ? -1 : 1;
    const za = Number(a.vordruckzeile) || Number.MAX_SAFE_INTEGER;
    const zb = Number(b.vordruckzeile) || Number.MAX_SAFE_INTEGER;
    if (za !== zb) return za - zb;
    return a.eCode.localeCompare(b.eCode);
  });
  return { anlage, felder };
}

// ─────────────────────────────────────────────────────────────────────────
// Container-Scan: welche Anlagen sind im OCR-Text wirklich vertreten?
// ─────────────────────────────────────────────────────────────────────────
//
// Statt einen LLM-Klassifizierer raten zu lassen welche Anlagen relevant
// sind, scannen wir den OCR-Text direkt gegen die `drucktext`-Strings ALLER
// 2287 Atome. Match → die Anlage des Atoms ist im Beleg.
//
// Strategie:
//   • Wir matchen nur Drucktexts ≥ `minDrucktextLength` Zeichen (Default 8),
//     weil kurze ("Betrag", "Summe", "Datum") in 100+ Atomen wiederkehren
//     und falsche Anlagen triggern würden.
//   • Match ist case-insensitive, mit non-word-boundary-tolerant regex
//     (BMF-XML hat manchmal Umlaut-Varianten oder Whitespace-Differenzen).
//   • Jeder Match wird mit Position + ~100 Zeichen Kontext aufgezeichnet.
//   • Output ist die deduplizierte Anlagen-Liste + die Match-Liste für Audit.

export interface ContainerMatch {
  atom_id: string;
  eCode: string;
  anlage: ElsterAnlage;
  drucktext: string;
  position: number;
  context: string;
}

export interface ContainerScanResult {
  /** Erkannte Anlagen, sortiert nach Anzahl Matches (häufigste zuerst). */
  erkannte_anlagen: ElsterAnlage[];
  /** Pro Anlage: wie viele Matches. */
  anlagen_hits: Record<ElsterAnlage, number>;
  /** Alle einzelnen Matches mit Kontext. */
  matches: ContainerMatch[];
  ms: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scannt den OCR-Text gegen alle Atome im Container. Liefert die Liste der
 * tatsächlich vertretenen Anlagen + Match-Details.
 *
 * NICHT für eCode-Disambiguation gedacht — bei mehrdeutigen Drucktexts
 * ("Werbungskosten" in mehreren Anlagen) zählt der erste Match. Für echte
 * Wert-Extraktion macht das Downstream-vLLM die feine Auflösung.
 */
export async function scanContainerInText(
  text: string,
  opts: { minDrucktextLength?: number; dataDir?: string } = {},
): Promise<ContainerScanResult> {
  const t0 = Date.now();
  const minLen = opts.minDrucktextLength ?? 8;
  const handle = await loadCatalog(opts.dataDir);

  // Pre-build: pro unique drucktext, die zugehörigen atoms (kann mehrere
  // sein bei Ambiguität — alle bekommen einen Match-Hit zugewiesen).
  const byDrucktext = new Map<string, CatalogAtom[]>();
  for (const a of handle.atoms) {
    const dt = a.metadata.drucktext;
    if (!dt || dt.length < minLen) continue;
    if (!/[A-Za-zÄÖÜäöüß]/.test(dt)) continue; // pure digits/punct skippen
    const arr = byDrucktext.get(dt);
    if (arr) arr.push(a);
    else byDrucktext.set(dt, [a]);
  }

  // Sortierte Liste — längste drucktexts zuerst, damit ein Längerer einen
  // kürzeren überlappenden Match konsumiert (Greedy-Specifity).
  const drucktexts = [...byDrucktext.keys()].sort((a, b) => b.length - a.length);

  const matches: ContainerMatch[] = [];
  const consumed = new Set<number>(); // text-positions bereits matched

  for (const dt of drucktexts) {
    const re = new RegExp(escapeRegex(dt), 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const pos = m.index;
      // Skip wenn Position schon von längerem Match abgedeckt
      if (consumed.has(pos)) continue;
      // Markiere die Position als consumed (für den ganzen Match-Bereich)
      for (let i = pos; i < pos + dt.length; i++) consumed.add(i);
      const ctxStart = Math.max(0, pos - 30);
      const ctxEnd = Math.min(text.length, pos + dt.length + 70);
      const context = text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ');
      // Bei Ambiguität ein Atom pro Anlage rausgeben (Anlagen-Detection
      // bevorzugen, eCode-Detail dem LLM überlassen).
      const atoms = byDrucktext.get(dt)!;
      const seenAnlagen = new Set<string>();
      for (const a of atoms) {
        if (seenAnlagen.has(a.metadata.anlage)) continue;
        seenAnlagen.add(a.metadata.anlage);
        matches.push({
          atom_id: a.atom_id,
          eCode: a.field_name,
          anlage: a.metadata.anlage,
          drucktext: dt,
          position: pos,
          context,
        });
      }
    }
  }

  const hits: Record<string, number> = {};
  for (const m of matches) hits[m.anlage] = (hits[m.anlage] ?? 0) + 1;
  const erkannte_anlagen = Object.keys(hits).sort((a, b) => hits[b] - hits[a]);

  return {
    erkannte_anlagen,
    anlagen_hits: hits,
    matches,
    ms: Date.now() - t0,
  };
}

/**
 * Returns the subset of atoms scoped to a single Anlage, useful for
 * "required-completeness" checks: "which pflicht=true fields for Anlage N
 * are missing in the extracted JSON?".
 */
export function requiredFieldsFor(handle: CatalogHandle, anlage: ElsterAnlage): CatalogAtom[] {
  return (handle.byAnlage.get(anlage) ?? []).filter((a) => a.metadata.pflicht);
}

// ─────────────────────────────────────────────────────────────────────────
// Container-Brief (CONTAINER_BRIEF.md) + JSON-Datenfiles als Single-Source
// ─────────────────────────────────────────────────────────────────────────
//
// Statt §EStG-Mapping + Disambiguation-Hints in Code zu pflegen, leben sie
// als Daten IM Container neben atoms.json. Code redet zum Container, nicht
// umgekehrt. Änderungen sind versioniert über den Container-Merkle.

const DEFAULT_DATA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../verticals/elster-v3/data',
);

interface ParagraphEstgFile {
  version: number;
  beschreibung: string;
  mapping: Record<string, string>;
}

interface DisambiguationFile {
  version: number;
  beschreibung: string;
  hints: Record<string, string[]>;
}

const PARAGRAPH_CACHE = new Map<string, Promise<ParagraphEstgFile>>();
const DISAMBIG_CACHE = new Map<string, Promise<DisambiguationFile>>();
const BRIEF_CACHE = new Map<string, Promise<string>>();

/** Lädt das paragraph_estg.json aus dem Container (gecached). */
export async function loadParagraphEstg(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<ParagraphEstgFile> {
  let p = PARAGRAPH_CACHE.get(dataDir);
  if (p) return p;
  p = (async () => JSON.parse(await readFile(join(dataDir, 'paragraph_estg.json'), 'utf-8')))();
  PARAGRAPH_CACHE.set(dataDir, p);
  return p;
}

/** Lädt das disambiguation_hints.json (gecached). */
export async function loadDisambiguationHints(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<DisambiguationFile> {
  let p = DISAMBIG_CACHE.get(dataDir);
  if (p) return p;
  p = (async () => JSON.parse(await readFile(join(dataDir, 'disambiguation_hints.json'), 'utf-8')))();
  DISAMBIG_CACHE.set(dataDir, p);
  return p;
}

/**
 * Lädt den CONTAINER_BRIEF.md — die Selbst-Beschreibung des Containers.
 * Wird von Layer-1 und Pass-2 als ERSTER Prompt-Block geladen, damit der
 * LLM die Atom-Schema-Konventionen kennt bevor er extrahiert.
 *
 * Der Brief ist Markdown und Teil des Container-Merkle (versioniert).
 */
export async function loadContainerBrief(
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<string> {
  let p = BRIEF_CACHE.get(dataDir);
  if (p) return p;
  p = readFile(join(dataDir, 'CONTAINER_BRIEF.md'), 'utf-8');
  BRIEF_CACHE.set(dataDir, p);
  return p;
}

/** Holt Disambiguations-Hint-Lines für eine docClass aus dem Container.
 *  Leere Liste wenn keine Hinweise existieren. */
export async function disambiguationHinweiseFuer(
  dokumenttypId: string,
  dataDir?: string,
): Promise<string[]> {
  const f = await loadDisambiguationHints(dataDir);
  return f.hints[dokumenttypId] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────
// Einkunftsart-Derivation — der Container ist die Quelle
// ─────────────────────────────────────────────────────────────────────────
//
// Die BMF-Atome encodieren die Einkunftsart bereits in `kontextPaths`. Der
// Path-Prefix vor dem ersten "/" ist die kanonische, deutsche BMF-Bezeichnung
// der Einkunftsart bzw. des Aufwandsblocks (z.B. "ArbL" = Arbeitslohn §19
// Abs.1 Nr.1, "Leibr_gesetzl" = gesetzliche Leibrente §22 Nr.1 Buchst. a,
// "Zuw" = Zuwendungen §10b, "St_Erm" = Steuerermäßigung §35a).
//
// Wir definieren KEIN paralleles Einkunftsart-Enum — wir verwenden die
// BMF-Prefixes direkt als kanonische Identifier. Was wir HINZUFÜGEN dürfen
// ist eine kleine Mapping-Tabelle Prefix → §EStG-Referenz für menschen-
// lesbare Layer-1-Prompts und für die ELSTER-Sektion in der Ausgabe.

/**
 * BMF-Einkunftsart-Code (kontextPath-Prefix). Beispiele:
 *   "ArbL", "Wk", "Leibr_gesetzl", "Leibr_priv", "KapErt_inl_StAbz",
 *   "Zuw", "St_Erm", "Beitr_g_KV_PV_Inl", "AVor", ...
 *
 * String-Type weil neue Prefixes mit jeder BMF-Jahresdoc dazukommen können;
 * Validierung erfolgt durch Container-Lookup, nicht durch Enum-Closing.
 */
export type EinkunftsartCode = string;

/** Holt die Einkunftsart eines einzelnen Atoms (1. kontextPath, Prefix vor "/"). */
export function einkunftsartVonAtom(atom: CatalogAtom): EinkunftsartCode | null {
  const paths = atom.metadata.kontextPaths;
  if (!paths || paths.length === 0) return null;
  const first = paths[0];
  return first.split('/')[0] || first;
}

/** Eindeutige Einkunftsarten einer Atom-Liste, in Reihenfolge des ersten Vorkommens. */
export function einkunftsartenVonAtomen(atoms: CatalogAtom[]): EinkunftsartCode[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of atoms) {
    const e = einkunftsartVonAtom(a);
    if (e && !seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

/**
 * §EStG-Referenz für eine BMF-Einkunftsart. Daten liegen in
 * `paragraph_estg.json` neben atoms.json im Container — nicht hier im Code.
 *
 * Hinzufügen → JSON editieren, Container bumpen.
 */
const PARAGRAPH_ESTG_DEPRECATED_INLINE: Record<string, string> = {
  // §19 EStG — Einkünfte aus nichtselbständiger Arbeit
  ArbL: '§19 Abs.1 Nr.1 EStG (Arbeitslohn)',
  Arb_V: '§19 EStG (Arbeitnehmer-Veranlagung)',
  Wk: '§9 EStG (Werbungskosten)',
  WK_Leibr: '§9 Abs.1 Nr.1 EStG (Werbungskosten bei Leibrenten)',
  DHHF: '§9 Abs.1 Nr.5 EStG (doppelte Haushaltsführung)',
  // §22 EStG — sonstige Einkünfte
  Leibr_gesetzl: '§22 Nr.1 Satz 3 Buchst. a EStG (gesetzliche Leibrente)',
  Leibr_priv: '§22 Nr.1 Satz 3 Buchst. a aa EStG (private Leibrente)',
  Leibr_sonst: '§22 Nr.1 EStG (sonstige Leibrenten)',
  // §20 EStG — Kapitaleinkünfte
  KapErt_inl_StAbz: '§20 EStG i.V.m. §43 EStG (inländische KapErt mit Steuerabzug)',
  KapErt_kein_inl_StAbz: '§20 EStG (KapErt ohne inländischen Steuerabzug)',
  KapErt_tar_Est: '§20 i.V.m. §32d Abs.6 EStG (tarifliche Besteuerung)',
  St_Abz_Betr_Inl_u_Inv_Ert: '§43a EStG (Steuerabzugsbeträge)',
  // §21 EStG — Vermietung & Verpachtung
  Obj: '§21 EStG (V&V-Objekt)',
  Einn: '§21 EStG (V&V-Einnahmen)',
  // §15/§18 EStG — Gewinneinkünfte
  Gewinn: '§§13, 15, 18 EStG (Gewinneinkünfte)',
  Gew: '§15 EStG (Gewerbebetrieb)',
  VAe_Gew: '§16/§17 EStG (Veräußerung Gewerbe)',
  VAe_G_v_FB: '§16 EStG (Veräußerungsgewinn / Freibetrag)',
  // §13 EStG — Land- und Forstwirtschaft
  Tierhalt: '§13 Abs.1 Nr.1 EStG (Tierhaltung)',
  Tierhalt_JE: '§13 Abs.1 EStG (Tierhaltung Jahresergebnis)',
  Flaechen_Beginn_WJ: '§13 EStG (Flächen-Bestand)',
  Tierz_Tierh: '§13 EStG (Tierzucht/-haltung)',
  // §10 EStG — Sonderausgaben
  AVor: '§10 Abs.1 Nr.2 EStG (Altersvorsorge)',
  Beitr_g_KV_PV_Inl: '§10 Abs.1 Nr.3 EStG (Basis-KV/PV Inland)',
  Beitr_g_p_KV_PV_Ausl: '§10 Abs.1 Nr.3 EStG (Basis-KV/PV Ausland)',
  Weit_Sons_VorAW: '§10 Abs.1 Nr.3a EStG (sonstige Vorsorgeaufwendungen)',
  Erg_Ang: '§10 EStG (ergänzende Angaben)',
  KiSt: '§10 Abs.1 Nr.4 EStG (Kirchensteuer)',
  Zuw: '§10b EStG (Zuwendungen / Spenden)',
  // §32 EStG — Kinderbezogen
  KBK: '§32 Abs.6 EStG (Kinderbetreuungskosten)',
  K_Verh: '§32 EStG (Kindschaftsverhältnis)',
  Ang_Kind: '§32 EStG (Kind-Angaben)',
  EfA: '§24b EStG (Entlastungsbetrag für Alleinerziehende)',
  // §33 EStG — außergewöhnliche Belastungen
  And_Aufw: '§33 EStG (andere außergewöhnliche Aufwendungen)',
  Pflege_PB: '§33b EStG (Pflege-Pauschbetrag)',
  Beh: '§33b EStG (Behinderten-Pauschbetrag)',
  Hinterbl: '§33b EStG (Hinterbliebenen-Pauschbetrag)',
  AW_eig_BAusb: '§33a Abs.2 EStG (Berufsausbildung eig. Kind)',
  // §35a EStG
  St_Erm: '§35a EStG (Steuerermäßigung haushaltsnahe DL/Handwerker)',
  // Stammdaten / Allgemein
  Allg: '— (Allgemeine Stammdaten)',
  Staat: '— (Staatsangehörigkeit/Anschrift)',
  Rel_Wechs: '— (Religionswechsel)',
  Mitwirk: '§90 AO (Mitwirkungspflichten)',
  // Weitere
  Weit_Aufw: '§10 EStG (weitere Aufwendungen)',
  Eink_Ers: '§24 Nr.1 EStG (Einnahmen-Ersatz)',
};

/** §EStG-Klartextzitat für eine BMF-Einkunftsart. Lädt aus
 *  paragraph_estg.json im Container — Code hat keine eigene Mapping-Tabelle.
 *
 *  Async-Variante für korrektes Container-Driven-Verhalten. */
export async function paragraphFuer(einkunftsart: EinkunftsartCode, dataDir?: string): Promise<string> {
  const f = await loadParagraphEstg(dataDir);
  return f.mapping[einkunftsart] ?? `— (${einkunftsart}, nicht zugeordnet)`;
}

/** Sync-Variante (vorausgesetzt loadParagraphEstg() lief vorher).
 *  Für tight loops wenn der File-Read schon abgeschlossen ist. */
export function paragraphFuerSync(
  einkunftsart: EinkunftsartCode,
  loaded: ParagraphEstgFile,
): string {
  return loaded.mapping[einkunftsart] ?? `— (${einkunftsart}, nicht zugeordnet)`;
}

// Inline-Konstante bleibt für Tests/Migration, ist aber DEPRECATED.
// Neue Aufrufe MÜSSEN paragraphFuer() (async, container-driven) nutzen.
void PARAGRAPH_ESTG_DEPRECATED_INLINE;
