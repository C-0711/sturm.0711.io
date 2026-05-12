/**
 * Container-Field-Resolver — maps schema-leaf names (snake_case, German) to
 * canonical eCode atoms from the ELSTER container.
 *
 * Strategy (in order):
 *   1. Bridge override (hand-curated per dokumenttyp_id, see `bridge/`)
 *   2. Exact normalized drucktext match (case-, umlaut-, whitespace-insensitive)
 *   3. Substring/token match in drucktext or value
 *   4. Filter candidates by `anlageHint` if provided
 *
 * Output is the canonical `ElsterAtom` so downstream stages get everything:
 * eCode, formatRegex, datentyp, vordruckzeile, anlage, drucktext, pflicht.
 */
import type { ElsterAtom } from '../../verticals/elster-v3/lib/container-reader.ts';
import { loadV3Bundle } from '../../verticals/elster-v3/lib/container-reader.ts';

// ── Per-doc-class bridge: explicit schema-leaf → eCode overrides. Used when
//    fuzzy matching would otherwise pick the wrong atom (synonyms, abbreviations).
const BRIDGES: Record<string, Record<string, string>> = {
  // Lohnsteuerbescheinigung (Schema: lohn.bruttoarbeitslohn, arbeitnehmer.steuer_id, …)
  lohnsteuerbescheinigung: {
    // Arbeitnehmer (Anlage N + ESt1A Stammdaten)
    'arbeitnehmer.steuer_id': 'E0100081',
    'arbeitnehmer.name': 'E0100201',
    'arbeitnehmer.familienname': 'E0100201',
    'arbeitnehmer.vorname': 'E0100301',
    'arbeitnehmer.konfession': 'E0100402',
    'arbeitnehmer.steuerklasse': 'E0200002',
    // Lohn (Anlage N)
    'lohn.bruttoarbeitslohn': 'E0200201',
    'lohn.lohnsteuer_einbehalten': 'E0200301',
    'lohn.solidaritaetszuschlag_einbehalten': 'E0200401',
    'lohn.kirchensteuer_arbeitnehmer_einbehalten': 'E0200501',
    'lohn.kirchensteuer_ehegatte_einbehalten': 'E0200601',
    // Versorgungsbezüge (Anlage N)
    'versorgungsbezug.versorgungsbezug_brutto': 'E0200801',
    'versorgungsbezug.bemessungsgrundlage_freibetrag': 'E0200902',
    'versorgungsbezug.versorgungsbeginn_jahr': 'E0201307',
    // Sozialversicherung → Anlage Vorsorgeaufwand (VOR)
    'sozialversicherung.rv_arbeitnehmer': 'E2000401',
    'sozialversicherung.kv_arbeitnehmer': 'E2001203',
    'sozialversicherung.pv_arbeitnehmer': 'E2001505',
    'sozialversicherung.av_arbeitnehmer': 'E2004403',
  },
};

export interface FieldResolution {
  /** The matched atom. */
  atom: ElsterAtom;
  /** How we matched it — for debug + Critic-citation. */
  matchMethod: 'bridge' | 'exact-drucktext' | 'normalized-drucktext' | 'substring' | 'leaf-token';
  /** Confidence 0..1 from the matcher. Always 1 for bridge. */
  confidence: number;
}

/**
 * Normalize a German label or snake_case name for fuzzy comparison:
 *  - lowercase
 *  - replace umlauts (ä→ae, ö→oe, ü→ue, ß→ss)
 *  - strip _ / - / whitespace / punctuation
 *  - drop leading "einbehaltene"/"einbehaltener"/"einbehaltenes" (frequent prefix in LStB)
 */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/^(einbehaltene[rsn]?\s+)/, '')
    .replace(/[\s_\-./()[\]]/g, '');
}

/** Tokenize for substring match — split on snake_case + spaces, normalize each token. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/[\s_\-./()[\]]+/)
    .filter((t) => t.length >= 3);
}

let bundleCache: Awaited<ReturnType<typeof loadV3Bundle>> | null = null;
async function getBundle() {
  if (!bundleCache) bundleCache = await loadV3Bundle();
  return bundleCache;
}

/**
 * Resolve a single schema-leaf path to its container atom.
 * Returns null if no candidate has confidence ≥ 0.5.
 */
export async function resolveLeafToAtom(
  leafPath: string,
  opts: { dokumenttyp_id?: string; anlageHint?: string } = {},
): Promise<FieldResolution | null> {
  const bundle = await getBundle();
  const atoms = bundle.atoms;

  // 1. Bridge override (highest priority — explicit human curation)
  const bridge = opts.dokumenttyp_id ? BRIDGES[opts.dokumenttyp_id] : undefined;
  if (bridge && bridge[leafPath]) {
    const code = bridge[leafPath];
    const atom = bundle.byCode.get(code);
    if (atom) return { atom, matchMethod: 'bridge', confidence: 1.0 };
  }

  // 2. Leaf name (last dotted segment) — that's what's most often the field name
  const leafName = leafPath.split('.').pop() ?? leafPath;
  const normLeaf = normalizeLabel(leafName);
  const normLeafPath = normalizeLabel(leafPath);

  // Filter to atoms with drucktext (= extractable, end-user-visible fields)
  const candidates = atoms.filter((a) => !!a.metadata?.drucktext);
  // Optional anlage filter
  const filtered = opts.anlageHint
    ? candidates.filter((a) => a.metadata.anlage === opts.anlageHint)
    : candidates;
  const pool = filtered.length > 0 ? filtered : candidates;

  // 2a. Exact drucktext match (case-fold + umlaut-fold + whitespace-strip)
  for (const atom of pool) {
    const normDrucktext = normalizeLabel(atom.metadata.drucktext);
    if (normDrucktext === normLeaf) {
      return { atom, matchMethod: 'normalized-drucktext', confidence: 1.0 };
    }
  }

  // 3. Substring match — leaf name appears in drucktext or vice versa
  const subMatches: Array<{ atom: ElsterAtom; score: number }> = [];
  for (const atom of pool) {
    const normDrucktext = normalizeLabel(atom.metadata.drucktext);
    if (!normDrucktext) continue;
    if (normDrucktext.includes(normLeaf) || normLeaf.includes(normDrucktext)) {
      // Longer match → higher confidence
      const overlap = Math.min(normDrucktext.length, normLeaf.length);
      const total = Math.max(normDrucktext.length, normLeaf.length);
      subMatches.push({ atom, score: overlap / total });
    }
  }
  if (subMatches.length > 0) {
    subMatches.sort((a, b) => b.score - a.score);
    return { atom: subMatches[0].atom, matchMethod: 'substring', confidence: subMatches[0].score };
  }

  // 4. Token match — at least one ≥3-char token from leaf path appears in drucktext
  const leafTokens = tokenize(leafPath);
  if (leafTokens.length > 0) {
    let best: { atom: ElsterAtom; score: number } | null = null;
    for (const atom of pool) {
      const druckTokens = tokenize(atom.metadata.drucktext);
      const intersection = leafTokens.filter((t) => druckTokens.includes(t));
      if (intersection.length === 0) continue;
      const score = intersection.length / Math.max(leafTokens.length, druckTokens.length);
      if (!best || score > best.score) best = { atom, score };
    }
    if (best && best.score >= 0.5) {
      return { atom: best.atom, matchMethod: 'leaf-token', confidence: best.score };
    }
  }

  return null;
}

/**
 * Resolve every leaf in a nested object to its atom in one pass.
 * Returns a flat map `dottedPath → FieldResolution | null`.
 */
export async function resolveAllLeaves(
  obj: unknown,
  opts: { dokumenttyp_id?: string; anlageHint?: string } = {},
): Promise<Record<string, FieldResolution | null>> {
  const out: Record<string, FieldResolution | null> = {};
  const queue: Array<{ value: unknown; path: string }> = [{ value: obj, path: '' }];
  while (queue.length > 0) {
    const { value, path } = queue.shift()!;
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => queue.push({ value: v, path: path ? `${path}[${i}]` : `[${i}]` }));
      continue;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k.startsWith('_')) continue; // skip meta keys like _span, _validation
        queue.push({ value: v, path: path ? `${path}.${k}` : k });
      }
      continue;
    }
    // Leaf value — try to resolve
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (path) out[path] = await resolveLeafToAtom(path, opts);
    }
  }
  return out;
}
