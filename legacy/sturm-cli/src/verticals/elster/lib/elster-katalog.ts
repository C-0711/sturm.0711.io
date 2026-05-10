/**
 * ELSTER catalog loaders. Reads the bundled JSON files produced by
 * scripts/preprocess-jahresdokumentation.mjs (and, when available,
 * scripts/preprocess-feldkatalog.mjs which exports cb-chat Postgres tables
 * as JSON).
 *
 * All catalogs are version-pinned and bundled — no runtime DB dependency.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, '..', 'data');

// ─────────────────────────────────────────────────────────────────────────────
// Types — mirror what scripts/preprocess-jahresdokumentation.mjs emits
// ─────────────────────────────────────────────────────────────────────────────

export interface ElsterFieldEntry {
  eCode: string;
  bezeichnung: string;
  datentyp: 'string' | 'integer' | 'currency' | 'date' | 'boolean';
  format: string;
  formatkennzeichen: string;
  formatRegex: string;
  minLaenge: number | null;
  maxLaenge: number | null;
  maxZeilen: number | null;
  pflicht: boolean;
  vordruckzeile: string;
  drucktext: string;
  kontextPaths: string[];
}

export interface ElsterAnlageBucket {
  anlage: string;
  codeCount: number;
  codes: ElsterFieldEntry[];
}

export interface FeldKatalogFull {
  schemaId: 'elster';
  catalogVersion: string;
  generatedAt: string;
  anlagenCount: number;
  totalCodes: number;
  anlagen: Record<string, ElsterAnlageBucket>;
}

export interface ElsterRule {
  name: string;
  kontext: string;
  fehlercode: string;
  beschreibung: string;
  pruefbedingung: string;
  fehlertext: string;
  mehrereVordrucke: string;
  mehrereZeilen: string;
  severity: 'fehler' | 'hinweis' | 'unknown';
  referencedECodes: string[];
}

export interface HinweisregelnAnlageBucket {
  anlage: string;
  ruleCount: number;
  rules: ElsterRule[];
}

export interface HinweisregelnFull {
  schemaId: 'elster';
  catalogVersion: string;
  generatedAt: string;
  anlagenCount: number;
  totalRules: number;
  anlagen: Record<string, HinweisregelnAnlageBucket>;
}

// Optional: cb-chat Postgres exports. May be absent if Postgres isn't accessible
// at preprocess time — the cascade gracefully skips missing layers.
export interface BmfElsterZuordnungEntry {
  bmfFeld: string;
  elsterCode: string;
  priority: number;
  isPrimary: boolean;
  mappingSource: string;
  confidence: number;
  reasoning: string;
}

export interface KonzeptZuordnungEntry {
  conceptSlug: string;
  conceptLabelDe: string;
  searchKeywords: string[];
  description: string;
  fieldGroup: string;
  elsterCodes: string[];
  mappingConfidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite catalog used by the cascade
// ─────────────────────────────────────────────────────────────────────────────

export interface ElsterCatalog {
  feldKatalog: FeldKatalogFull;
  hinweisregeln: HinweisregelnFull;
  bmfElsterZuordnung: BmfElsterZuordnungEntry[];
  konzeptZuordnung: KonzeptZuordnungEntry[];
  /** O(1) lookup: bezeichnung-text (normalized) → eCode candidates */
  bezeichnungIndex: Map<string, string[]>;
  /** O(1) lookup: drucktext (normalized) → eCode candidates */
  drucktextIndex: Map<string, string[]>;
  /** O(1) lookup: bmf-slug → eCode (primary) */
  bmfSlugIndex: Map<string, string>;
  /** O(1) lookup: concept-slug → eCode candidates */
  conceptIndex: Map<string, string[]>;
  /** O(1) lookup: eCode → field metadata */
  byCode: Map<string, ElsterFieldEntry>;
}

let catalogCache: ElsterCatalog | null = null;

export async function loadCatalog(): Promise<ElsterCatalog> {
  if (catalogCache) return catalogCache;

  const feldKatalog = await loadJsonOrEmpty<FeldKatalogFull>(
    'feld_katalog_full.json',
    {
      schemaId: 'elster',
      catalogVersion: 'unknown',
      generatedAt: new Date().toISOString(),
      anlagenCount: 0,
      totalCodes: 0,
      anlagen: {},
    },
  );
  const hinweisregeln = await loadJsonOrEmpty<HinweisregelnFull>(
    'hinweisregeln.json',
    {
      schemaId: 'elster',
      catalogVersion: 'unknown',
      generatedAt: new Date().toISOString(),
      anlagenCount: 0,
      totalRules: 0,
      anlagen: {},
    },
  );
  const bmfElsterZuordnung = await loadJsonArrayOrEmpty<BmfElsterZuordnungEntry>(
    'bmf_elster_zuordnung.json',
  );
  const konzeptZuordnung = await loadJsonArrayOrEmpty<KonzeptZuordnungEntry>(
    'konzept_zuordnung.json',
  );

  const bezeichnungIndex = new Map<string, string[]>();
  const drucktextIndex = new Map<string, string[]>();
  const byCode = new Map<string, ElsterFieldEntry>();

  for (const bucket of Object.values(feldKatalog.anlagen)) {
    for (const f of bucket.codes) {
      byCode.set(f.eCode, f);
      const bz = norm(f.bezeichnung);
      if (bz) addToMap(bezeichnungIndex, bz, f.eCode);
      const dt = norm(f.drucktext);
      if (dt) addToMap(drucktextIndex, dt, f.eCode);
    }
  }

  // Integrity gate: every eCode in any seed file MUST exist in the official
  // catalog. Fail fast at startup — never let a rotten reference reach the
  // cascade where it would silently emit wrong canonical IDs.
  const rottenRefs: Array<{ file: string; key: string; rottenCode: string }> = [];
  const bmfSlugIndex = new Map<string, string>();
  for (const e of bmfElsterZuordnung) {
    if (!byCode.has(e.elsterCode)) {
      rottenRefs.push({ file: 'bmf_elster_zuordnung.json', key: e.bmfFeld, rottenCode: e.elsterCode });
      continue;
    }
    if (e.isPrimary) bmfSlugIndex.set(norm(e.bmfFeld), e.elsterCode);
  }

  const conceptIndex = new Map<string, string[]>();
  for (const c of konzeptZuordnung) {
    const validCodes = (c.elsterCodes ?? []).filter((code) => {
      if (!byCode.has(code)) {
        rottenRefs.push({ file: 'konzept_zuordnung.json', key: c.conceptSlug, rottenCode: code });
        return false;
      }
      return true;
    });
    addAllToMap(conceptIndex, norm(c.conceptSlug), validCodes);
    for (const kw of c.searchKeywords ?? []) {
      addAllToMap(conceptIndex, norm(kw), validCodes);
    }
  }

  if (rottenRefs.length > 0) {
    const sample = rottenRefs.slice(0, 8).map((r) =>
      `  ${r.file}: "${r.key}" → ${r.rottenCode} (NOT in catalog)`,
    ).join('\n');
    throw new Error(
      `Catalog integrity violation: ${rottenRefs.length} rotten eCode reference(s).\n` +
      `Every elsterCode in seed data must exist in feld_katalog_full.json.\n` +
      `${sample}\n` +
      (rottenRefs.length > 8 ? `… and ${rottenRefs.length - 8} more\n` : '') +
      `Fix the seed file or regenerate the catalog from a newer Jahresdokumentation.`,
    );
  }

  catalogCache = {
    feldKatalog,
    hinweisregeln,
    bmfElsterZuordnung,
    konzeptZuordnung,
    bezeichnungIndex,
    drucktextIndex,
    bmfSlugIndex,
    conceptIndex,
    byCode,
  };
  return catalogCache;
}

async function loadJsonOrEmpty<T>(filename: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(join(DATA_ROOT, filename), 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

async function loadJsonArrayOrEmpty<T>(filename: string): Promise<T[]> {
  try {
    const raw = await readFile(join(DATA_ROOT, filename), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export function norm(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function addToMap(m: Map<string, string[]>, key: string, value: string): void {
  const cur = m.get(key);
  if (cur) {
    if (!cur.includes(value)) cur.push(value);
  } else {
    m.set(key, [value]);
  }
}

function addAllToMap(m: Map<string, string[]>, key: string, values: string[]): void {
  for (const v of values) addToMap(m, key, v);
}
