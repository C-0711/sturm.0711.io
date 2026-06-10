/**
 * e10-xml — E10 Steuererklärung-XML-Generator
 *
 * Nimmt deterministische `MappedField[]` (aus field-mapper) entgegen und
 * erzeugt ein gegen `E10-2024.xsd` validierbares XML-Dokument.
 *
 * Pipeline:
 *   1. Felder-Metadaten aus Postgres laden (kontext.pfad, format_typ.kanonisch,
 *      kontext.max_wiederhol für Person-Indexfeld-Erkennung).
 *   2. Felder gruppieren nach (anlage, person, kontext_pfad).
 *   3. Pro Anlage eine Tree-Struktur aufbauen, dabei
 *      - kontext.pfad-Segmente als Container-Elemente nesten,
 *      - bei Pfaden mit max_wiederhol='2' ein `<Person>PersonA|PersonB</Person>`
 *        als ersten Child injizieren,
 *      - E-Code-Leaves mit normalisiertem `<wert/>` einsetzen.
 *   4. Top-Level-Anlagen in der von E10_CType.xs:sequence vorgegebenen
 *      Reihenfolge serialisieren.
 *
 * Quelle der XSD-Sequenz: E10-2024.xsd / E10_CType (verifiziert per
 * direkter Inspektion).
 *
 * Anti-Goals:
 *   - Kein LLM-Fallback; nur deterministisches Mapping.
 *   - Keine Geschäfts­regel-Validierung (das macht ERiC später).
 *   - Keine Vorsatz-Generierung (Steuernummer, FA-Nummer, etc.) — diese
 *     Felder müssen explizit als MappedField mit eCode='E0100053' etc.
 *     eingespeist werden.
 *
 * Verifikation:
 *   xmllint --schema E10-2024.xsd out.xml --noout
 */
import type pg from 'pg';
import type { MappedField, Person } from './types.ts';

// ─── XSD-defined orderings (E10-2024.xsd) ────────────────────────────────

/** Reihenfolge der Top-Level-Anlagen wie in E10_CType.xs:sequence. */
const E10_TOPLEVEL_ORDER: ReadonlyArray<string> = [
  'ESt1A',
  'SA',
  'AgB',
  'HA_35a',
  'EM_35c',
  'Sonst',
  'WA_ESt',
  'ESt1A_U',
  'Kind',
  'L',
  'Anl_34b',
  'G',
  'Zins',
  'S',
  'Corona',
  'N_GRE',
  'N',
  'N_DHH',
  'N_AUS',
  'KAP',
  'KAP_BET',
  'KAP_I',
  'AUS',
  'R',
  'RAV_bAV',
  'R_AUS',
  'SO',
  'V',
  'V_FeWo',
  'V_Sonstige',
  'FW',
  'VOR',
  'AV',
  'Mob',
  'Vorsatz',
];

/**
 * Reihenfolge der Sub-Container innerhalb der jeweiligen Anlage
 * (xs:sequence aus der XSD). Nicht aufgeführte Anlagen serialisieren
 * Sub-Container alphabetisch — das ist nur ein Fallback; sobald wir
 * Felder in einer "neuen" Anlage haben, gehört die Reihenfolge hier rein.
 */
const ANLAGE_CHILD_ORDER: Record<string, ReadonlyArray<string>> = {
  ESt1A: ['Art_Erkl', 'Belege', 'Finanzamt', 'Allg', 'Mitwirk', 'AN_Sp_Zul', 'Eink_Ers', 'OG_Ber', 'Erg_Ang', 'Rel_Wechs'],
  N: ['Person', 'ArbL', 'Wk', 'WW_Familienheim', 'Reise', 'Fortb', 'Bewerb', 'sonst_Wk', 'WK_Sum', 'AG_LE', 'StPfl_Eink', 'Erg_Ang'],
  R: ['Person', 'Leibr_gesetzl', 'Leibr_priv', 'Leibr_sonst', 'WK_Leibr', 'Erg_Ang'],
  VOR: ['AVor', 'Beitr_g_KV_PV_Inl', 'Beitr_p_KV_PV_Inl', 'Beitr_g_p_KV_PV_Ausl', 'Stfr_AG_Zusch', 'Uebern_KV_PV_Beitr', 'Weit_Sons_VorAW', 'Erg_Ang'],
  KAP: ['Person', 'KapErt_inl_StAbz', 'KapErt_inl_o_StAbz', 'KapErt_Ausl', 'St_Abz_Betr_Inl_u_Inv_Ert', 'Sp_PB', 'Erg_Ang'],
};

/** Reihenfolge der Children eines Allg-Containers in ESt1A. */
const ESt1A_ALLG_ORDER: ReadonlyArray<string> = ['E0100008', 'A', 'Vlg_Art', 'B', 'BV'];

// ─── DB-Lookup ──────────────────────────────────────────────────────────

interface FieldMeta {
  eCode: string;
  anlage: string;
  kontextPfad: string | null;  // absoluter Pfad, z.B. '/N/ArbL/LStB_1_5_Sum'
  kanonisch: string | null;    // format_typ.kanonisch, z.B. 'int_euro'
  /** Optional: format_typ.regex (XSD-Pattern). Wird genutzt, um bei
   *  string-Feldern auto-zu-strippen wenn das Pattern Whitespace verbietet. */
  formatRegex: string | null;
  /** Wenn true: XSD-Typ verbietet den Wert 0 (typisch Sterbegeld,
   *  Anpassung). Abgeleitet aus xsd_type_name containing "NichtNull".
   *  formatValue() unterdrückt das Element wenn der Wert 0/0,00 ist. */
  forbidsZero: boolean;
  /** feld_id (auto-increment); ASC == XSD-Sequence-Reihenfolge. */
  feldId: number;
}

interface CatalogLookup {
  /** Pro E-Code die Catalog-Metadata. Mehrere Treffer pro E-Code möglich
   *  (gleiches E0200201 in mehreren Kontexten); wir nehmen den der zum
   *  MappedField passenden kontextSubpath gehört. */
  fields: Map<string, FieldMeta[]>;
  /** Set aller kontext_pfade mit max_wiederhol='2' (Person-indexfeld nötig). */
  personIndexedPaths: Set<string>;
}

async function loadCatalogLookup(
  pool: pg.Pool,
  eCodes: string[],
  vz: number,
): Promise<CatalogLookup> {
  const uniq = [...new Set(eCodes)];
  if (uniq.length === 0) return { fields: new Map(), personIndexedPaths: new Set() };

  // Felder + Metadaten
  const { rows: fieldRows } = await pool.query<{
    feld_id: string;
    e_code: string;
    anlage: string;
    pfad: string | null;
    kanonisch: string | null;
    regex: string | null;
    xsd_type_name: string | null;
  }>(
    `SELECT f.feld_id::text     AS feld_id,
            f.name              AS e_code,
            a.name              AS anlage,
            k.pfad              AS pfad,
            ft.kanonisch        AS kanonisch,
            ft.regex            AS regex,
            ft.xsd_type_name    AS xsd_type_name
       FROM elster.feld f
       JOIN elster.anlage a       USING (anlage_id)
  LEFT JOIN elster.kontext k       ON k.kontext_id = f.kontext_id
  LEFT JOIN elster.format_typ ft   ON ft.format_id = f.format_id
      WHERE f.name = ANY ($1::text[])
        AND a.vz  = $2`,
    [uniq, vz],
  );

  const fields = new Map<string, FieldMeta[]>();
  for (const row of fieldRows) {
    const arr = fields.get(row.e_code) ?? [];
    // "NichtNull" im XSD-Type-Namen heißt: 0 ist nicht zulässig (ELSTER-
    // Konvention "Wert 0 = kein Eintrag, Element weglassen"). Beispiele:
    //   GanzzahlNichtNullOhneFuehrNull_MaxVK12_...   verbietet 0
    //   GanzzahlOhneFuehrNull_MaxVK12_...            erlaubt 0
    const xsdType = row.xsd_type_name ?? '';
    const forbidsZero = /NichtNull/i.test(xsdType);
    arr.push({
      eCode: row.e_code,
      anlage: row.anlage,
      kontextPfad: row.pfad,
      kanonisch: row.kanonisch,
      formatRegex: row.regex,
      forbidsZero,
      feldId: Number(row.feld_id),
    });
    fields.set(row.e_code, arr);
  }

  // Person-indexed pfade
  const { rows: pfadRows } = await pool.query<{ pfad: string }>(
    `SELECT k.pfad
       FROM elster.kontext k
       JOIN elster.anlage a USING (anlage_id)
      WHERE k.max_wiederhol = '2'
        AND a.vz = $1`,
    [vz],
  );
  const personIndexedPaths = new Set(pfadRows.map((r) => r.pfad));

  return { fields, personIndexedPaths };
}

// ─── Wert-Formatierung pro kanonisch-Typ ────────────────────────────────

/**
 * Konvertiert den vom Normalisierer gelieferten `wert` in die XML-Form
 * gemäß `format_typ.kanonisch`.
 *
 * Das Field-Mapper-Normalisierer-Output ist bereits größtenteils XML-fertig
 * (deutsches Komma bei Dezimalen, gerundete Ganzzahlen bei int_euro etc.).
 * Hier wird nur leicht nach-normalisiert und XML-escaped.
 */
/**
 * ELSTER-Konvention: für Felder deren XSD-Pattern keine 0 zulässt
 * (typisch `-?[1-9].*` oder `[1-9].*`), wird ein Null-Wert NICHT als
 * `<E…>0</E…>` serialisiert — das Element muss komplett weggelassen
 * werden ("missing-equivalent"). buildTreeFromFields skippt Leaves
 * deren formatValue() leerstring zurückgibt.
 */
function isZeroIntValue(formatted: string): boolean {
  return /^-?0+$/.test(formatted) || /^-?0+,0{0,2}$/.test(formatted);
}

function regexAllowsZero(regex: string | null): boolean {
  if (!regex) return true;          // kein Pattern → 0 erlaubt
  try {
    const re = new RegExp(`^${regex}$`, 'u');
    // Wir testen mehrere 0-Schreibweisen: int "0" oder decimal "0,00"
    // — abhängig vom Pattern. Erlaubt eine davon → 0 ist generell ok.
    return re.test('0') || re.test('0,00') || re.test('-0') || re.test('-0,00');
  } catch {
    return true;                    // unbenutzbare Regex → konservativ erlauben
  }
}

/** Schickt die XSD-Restriction-Chain berücksichtigt: forbidsZero (XSD-
 *  Typname signaliert "NichtNull") UND regex erlaubt 0 in der eigenen
 *  Pattern-Stufe — beide gemeinsam entscheiden ob 0 erlaubt ist. */
function zeroAllowed(meta: FieldMeta): boolean {
  if (meta.forbidsZero) return false;
  return regexAllowsZero(meta.formatRegex);
}

function formatValue(wert: string, meta: FieldMeta): string {
  const t = wert.trim();
  const kanonisch = meta.kanonisch;
  const regex = meta.formatRegex;
  /**
   * Strippt Whitespace nur wenn nötig: Pattern-Match probieren — wenn der
   * Original-Wert das XSD-Pattern verletzt aber die stripped-Variante es
   * erfüllen würde, dann strippen. So bleibt "Am Schwanenteich" intakt
   * (Pattern erlaubt Spaces) aber "DE93 5775 ..." wird zu "DE93577..."
   * (IBAN-Pattern erlaubt keine Spaces).
   */
  const maybeStrip = (s: string): string => {
    if (!regex || !/\s/.test(s)) return s;
    let re: RegExp;
    try {
      re = new RegExp(`^${regex}$`, 'u');
    } catch {
      return s; // unbenutzbare regex → unverändert
    }
    if (re.test(s)) return s;
    const stripped = s.replace(/\s+/g, '');
    if (re.test(stripped)) return stripped;
    return s;
  };
  switch (kanonisch) {
    case 'int_euro':
    case 'int_nn_euro': {
      // Ganzzahlen ohne Komma. Normalizer hat schon gerundet.
      const v = t.replace(/\D/g, '').replace(/^0+(?=\d)/, '') || '0';
      // ELSTER-Konvention: Wert 0 + Pattern/Typ verbietet 0 → Element weglassen
      if (isZeroIntValue(v) && !zeroAllowed(meta)) return '';
      return v;
    }

    case 'decimal_eur_cent':
    case 'decimal_eur_no_cent':
    case 'decimal': {
      // Deutsches Komma. Normalizer-Output passt direkt.
      if (isZeroIntValue(t) && !zeroAllowed(meta)) return '';
      return t;
    }

    case 'date':
    case 'Datum mit Format MM.JJ':
    case 'date_partial':
      // ELSTER erwartet TT.MM.JJJJ; year_JJJJ als 4 stellige Zahl; MM als 2 stellig.
      return t;

    case 'idnr':
    case 'IDNr':
    case 'W_IdNr_mit_U_Merkmal':
    case 'IBAN':
    case 'BIC':
    case 'bic':
      // alle Leerzeichen entfernen
      return t.replace(/\s+/g, '');

    case 'bool_ja1':
      // "1" oder leer
      return t === '1' || /^(ja|x|true)$/i.test(t) ? '1' : '';

    case 'bool_ja':
    case 'bool_ja_nein':
    case 'bool_jax':
      return /^(ja|x|true|1)$/i.test(t) ? 'ja' : '';

    case 'enum':
    case 'enum_inline':
    case 'string':
    case 'string_pattern':
    case 'EMail':
    case 'Steuernummer im Elster-Format':
    case 'steuernummer':
    case 'Bundesfinanzamtsnummer':
    default:
      // string-Felder: Pattern-Match probieren — bei Verletzung durch
      // Whitespace strippen (IBAN/BIC/Steuernummer), sonst original.
      return maybeStrip(t);
  }
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Tree-Konstruktion ─────────────────────────────────────────────────

interface TreeNode {
  name: string;
  /** Gesetzt nur an Leaf-Knoten (E-Code-Elemente). */
  value?: string;
  /** Gesetzt nur an Person-Indexfeldern. */
  isPersonIndex?: boolean;
  /** feld_id aus der Postgres-Catalog — bestimmt XSD-Sequence-Reihenfolge.
   *  Bei E-Code-Leaves zwingend; bei Sub-Containern (z.B. ArbL, VBez) optional
   *  (siehe `sortedChildKeys`). */
  feldId?: number;
  /** Reihenfolge-erhaltend; Map(name → Node). Person-Container haben
   *  einen `Person`-Child sowie Sub-Container/Leaves dahinter. */
  children: Map<string, TreeNode>;
}

function newNode(name: string): TreeNode {
  return { name, children: new Map() };
}

interface GenerationWarning {
  eCode: string;
  reason: string;
}

/**
 * Wählt für einen MappedField den passenden Catalog-Eintrag.
 * Falls mehrere Pfade (z.B. E1900701 in inl_StAbz vs. ausl) existieren, wird
 * der mit übereinstimmendem kontextSubpath-Suffix bevorzugt.
 */
function resolveCatalogEntry(
  field: MappedField,
  lookup: CatalogLookup,
): FieldMeta | null {
  const hits = lookup.fields.get(field.eCode) ?? [];
  if (hits.length === 0) return null;
  // Wähle anhand des kontextSubpath
  const sub = field.kontextSubpath ?? '';
  const wanted = `/${field.anlage}/${sub}`.replace(/\/+$/, '');
  // Exakter Match
  const exact = hits.find((h) => (h.kontextPfad ?? '') === wanted);
  if (exact) return exact;
  // Suffix-Match (sub könnte verkürzt sein)
  if (sub) {
    const suffix = `/${sub}`;
    const suff = hits.find(
      (h) => h.anlage === field.anlage && (h.kontextPfad ?? '').endsWith(suffix),
    );
    if (suff) return suff;
  }
  // Anlagen-Match
  const byAnlage = hits.find((h) => h.anlage === field.anlage);
  if (byAnlage) return byAnlage;
  return hits[0];
}

function buildTreeFromFields(
  fields: MappedField[],
  lookup: CatalogLookup,
): { roots: Map<string, TreeNode[]>; warnings: GenerationWarning[] } {
  // roots: Map(anlage → liste von Anlage-Knoten (pro Person ggf. einer))
  // Pro Top-Level-Anlage halten wir bis zu 2 Knoten (PersonA, PersonB).
  // Für nicht-personenindizierte Top-Level-Anlagen (ESt1A, VOR, …) gibt es
  // nur einen Knoten; A/B-Trennung passiert intern in Sub-Containern.
  const roots = new Map<string, TreeNode[]>();
  const warnings: GenerationWarning[] = [];

  /** Hole oder erstelle Top-Level-Anlage-Knoten. */
  const getOrCreateAnlage = (anlage: string, person: Person): TreeNode => {
    const isPersonIndexed = lookup.personIndexedPaths.has(`/${anlage}`);
    let arr = roots.get(anlage);
    if (!arr) {
      arr = [];
      roots.set(anlage, arr);
    }
    if (isPersonIndexed) {
      let node = arr.find((n) => n.children.get('Person')?.value === `Person${person}`);
      if (node) return node;
      node = newNode(anlage);
      const personNode: TreeNode = {
        name: 'Person',
        value: `Person${person}`,
        isPersonIndex: true,
        children: new Map(),
      };
      node.children.set('Person', personNode);
      arr.push(node);
      return node;
    }
    if (arr.length === 0) arr.push(newNode(anlage));
    return arr[0];
  };

  for (const field of fields) {
    const meta = resolveCatalogEntry(field, lookup);
    if (!meta) {
      warnings.push({
        eCode: field.eCode,
        reason: `E-Code im Catalog nicht gefunden (anlage=${field.anlage}, kontextSubpath=${field.kontextSubpath ?? '∅'})`,
      });
      continue;
    }
    const pfad = meta.kontextPfad ?? `/${field.anlage}`;
    const segments = pfad.split('/').filter(Boolean); // ['VOR','Beitr_p_KV_PV_Inl']
    if (segments.length === 0 || segments[0] !== field.anlage) {
      warnings.push({
        eCode: field.eCode,
        reason: `Pfad ${pfad} passt nicht zur Anlage ${field.anlage}`,
      });
      continue;
    }

    // Anlage-Knoten holen (mit ggf. PersonA/B-Indexfeld)
    const anlageNode = getOrCreateAnlage(field.anlage, field.person);
    let cursor = anlageNode;
    let currentPfadAcc = `/${field.anlage}`;

    // Sub-Container traversieren (alle Segmente nach dem ersten)
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      currentPfadAcc += `/${seg}`;
      let child = cursor.children.get(seg);
      if (!child) {
        child = newNode(seg);
        // Person-Indexfeld injizieren falls Sub-Container max_wiederhol=2 hat
        // (z.B. VOR/Beitr_p_KV_PV_Inl ist person-indexed obwohl VOR es nicht ist).
        if (lookup.personIndexedPaths.has(currentPfadAcc)) {
          child.children.set('Person', {
            name: 'Person',
            value: `Person${field.person}`,
            isPersonIndex: true,
            children: new Map(),
          });
        }
        cursor.children.set(seg, child);
      } else if (
        lookup.personIndexedPaths.has(currentPfadAcc) &&
        child.children.get('Person')?.value !== `Person${field.person}`
      ) {
        // gleicher Container existiert bereits für andere Person — wir brauchen
        // einen zweiten Container am gleichen Pfad. Wir nutzen einen "synthetischen"
        // Key, damit beide Container co-existieren können.
        const altKey = `${seg}__Person${field.person}`;
        let alt = cursor.children.get(altKey);
        if (!alt) {
          alt = newNode(seg); // selber XML-Name, anderer Map-Key
          alt.children.set('Person', {
            name: 'Person',
            value: `Person${field.person}`,
            isPersonIndex: true,
            children: new Map(),
          });
          cursor.children.set(altKey, alt);
        }
        child = alt;
      }
      cursor = child;
    }

    // Leaf: das E-Code-Element. feldId trägt die XSD-Sequence-Position.
    const xmlValue = formatValue(field.wert, meta);
    // ELSTER-"missing-equivalent": Leaf NICHT emittieren wenn formatValue
    // leerstring liefert (z.B. int_euro Wert 0 + Pattern verbietet 0).
    if (xmlValue === '') {
      warnings.push({
        eCode: field.eCode,
        reason: `Wert "${field.wert}" wäre nach Catalog-Pattern ungültig (typisch 0 für Sterbegeld/Anpassung) — Element weggelassen.`,
      });
      continue;
    }
    cursor.children.set(field.eCode, {
      name: field.eCode,
      value: xmlValue,
      feldId: meta.feldId,
      children: new Map(),
    });
  }

  return { roots, warnings };
}

// ─── Serialisierung ────────────────────────────────────────────────────

/** Min feldId aller Descendant-Leaves; Infinity wenn keiner. */
function minDescendantFeldId(node: TreeNode): number {
  if (node.feldId !== undefined) return node.feldId;
  let min = Number.POSITIVE_INFINITY;
  for (const c of node.children.values()) {
    const m = minDescendantFeldId(c);
    if (m < min) min = m;
  }
  return min;
}

function sortedChildKeys(
  parentName: string,
  childKeys: string[],
  childMap: Map<string, TreeNode>,
): string[] {
  // Person immer first (XSD-pflicht in indexierten Containern)
  const personFirst: string[] = [];
  const rest: string[] = [];
  for (const k of childKeys) {
    if (childMap.get(k)?.isPersonIndex) personFirst.push(k);
    else rest.push(k);
  }
  // Bestimmte Anlagen haben hartkodierte XSD-Reihenfolge (Top-Level
  // Sub-Container, deren Position nicht aus feldId ableitbar ist weil
  // sie selbst keine Leaves enthalten oder feldIds in unbekannter Reihe).
  const order = ANLAGE_CHILD_ORDER[parentName];
  if (order) {
    const inOrder = order.filter((n) => rest.some((k) => childMap.get(k)?.name === n));
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const expected of inOrder) {
      const keys = rest.filter((k) => childMap.get(k)?.name === expected);
      orderedKeys.push(...keys);
      keys.forEach((k) => seen.add(k));
    }
    const remaining = rest.filter((k) => !seen.has(k)).sort();
    return [...personFirst, ...orderedKeys, ...remaining];
  }
  if (parentName === 'Allg') {
    const inOrder = ESt1A_ALLG_ORDER.filter((n) => rest.some((k) => childMap.get(k)?.name === n));
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const expected of inOrder) {
      const keys = rest.filter((k) => childMap.get(k)?.name === expected);
      orderedKeys.push(...keys);
      keys.forEach((k) => seen.add(k));
    }
    const remaining = rest.filter((k) => !seen.has(k)).sort();
    return [...personFirst, ...orderedKeys, ...remaining];
  }
  // Default: Mischung aus E-Code-Leaves und Sub-Containern — beides nach
  // feldId (bzw. min-feldId der Descendants) sortieren. Das spiegelt die
  // XSD-Sequence, weil Postgres feld_id == XSD-document-order ist.
  const withKey = rest.map((k) => ({ k, sortKey: minDescendantFeldId(childMap.get(k)!) }));
  withKey.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    // Fallback: alphabetisch nach Element-Name
    const an = childMap.get(a.k)!.name;
    const bn = childMap.get(b.k)!.name;
    return an.localeCompare(bn);
  });
  return [...personFirst, ...withKey.map((w) => w.k)];
}

function serializeNode(node: TreeNode, indent: number): string {
  const pad = '  '.repeat(indent);
  if (node.value !== undefined && node.children.size === 0) {
    // Leaf
    const v = xmlEscape(node.value);
    if (v === '') return `${pad}<${node.name}/>`;
    return `${pad}<${node.name}>${v}</${node.name}>`;
  }
  // Container
  if (node.children.size === 0) return `${pad}<${node.name}/>`;
  const sortedKeys = sortedChildKeys(node.name, [...node.children.keys()], node.children);
  const inner = sortedKeys.map((k) => serializeNode(node.children.get(k)!, indent + 1));
  return `${pad}<${node.name}>\n${inner.join('\n')}\n${pad}</${node.name}>`;
}

// ─── Public API ────────────────────────────────────────────────────────

export interface BuildE10XMLOptions {
  /** Pflicht: Veranlagungszeitraum. Steuert nur die Catalog-Lookups. */
  vz: number;
  /** Postgres-Pool gegen elster.* Schema. */
  pool: pg.Pool;
  /** XSD-Version (default '2024'). */
  xsdVersion?: string;
}

export interface BuildE10XMLResult {
  xml: string;
  warnings: GenerationWarning[];
  /** E-Codes die in der XML geschrieben wurden. */
  emittedECodes: string[];
}

/**
 * Hauptfunktion: MappedField[] → E10-XML.
 *
 * Voraussetzungen:
 *   - Felder enthalten die `wert`-Form wie sie der Normalisierer ausgibt
 *     (deutsches Komma, kaufmännisch gerundet etc.).
 *   - Vor­satz-Felder (E0100053 etc.) müssen ggf. als MappedField mit
 *     anlage='Vorsatz' und passendem kontextSubpath übergeben werden — der
 *     Generator setzt sie nicht implizit.
 *
 * Output:
 *   - XML-String mit `<E10 xmlns="..." version="2024">…</E10>` Wrapper.
 *   - `warnings` zu E-Codes die nicht im Catalog gefunden wurden.
 */
export async function buildE10XML(
  fields: MappedField[],
  opts: BuildE10XMLOptions,
): Promise<BuildE10XMLResult> {
  const xsdVersion = opts.xsdVersion ?? '2024';
  const namespace = `http://finkonsens.de/elster/elstererklaerung/est/e10/v${xsdVersion}`;

  const lookup = await loadCatalogLookup(
    opts.pool,
    fields.map((f) => f.eCode),
    opts.vz,
  );

  const { roots, warnings } = buildTreeFromFields(fields, lookup);

  // Top-Level-Anlagen in xs:sequence-Reihenfolge ausgeben.
  const knownAnlagen = new Set(E10_TOPLEVEL_ORDER);
  const unknownAnlagen = [...roots.keys()].filter((a) => !knownAnlagen.has(a));
  for (const a of unknownAnlagen) {
    warnings.push({
      eCode: '(any)',
      reason: `Anlage "${a}" ist nicht in E10_CType.xs:sequence aufgeführt — wird an's Ende verschoben.`,
    });
  }

  const orderedAnlagen = [
    ...E10_TOPLEVEL_ORDER.filter((a) => roots.has(a)),
    ...unknownAnlagen.sort(),
  ];

  const body: string[] = [];
  for (const anlage of orderedAnlagen) {
    const list = roots.get(anlage)!;
    // Bei personenindizierten Anlagen mehrere Knoten (A, B), in fester Reihenfolge.
    // PersonA zuerst.
    list.sort((a, b) => {
      const pa = a.children.get('Person')?.value ?? 'PersonA';
      const pb = b.children.get('Person')?.value ?? 'PersonA';
      return pa.localeCompare(pb);
    });
    for (const node of list) {
      body.push(serializeNode(node, 1));
    }
  }

  const emittedECodes = fields
    .filter((f) => lookup.fields.has(f.eCode))
    .map((f) => f.eCode);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<E10 xmlns="${namespace}" version="${xsdVersion}">\n` +
    body.join('\n') +
    `\n</E10>\n`;

  return { xml, warnings, emittedECodes };
}
