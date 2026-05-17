/**
 * Layer 2: Entity-resolution and OCR post-correction.
 *
 * H200V's `legal_entity` table turned out to be skeletal extraction artifacts
 * (just `{label: "entity_60"}`), NOT a real registry of German non-profits.
 * So this resolver is LLM-driven by default, with an optional curated whitelist
 * for high-frequency entities.
 *
 * Strategy per resolveEntity() call:
 *   1. Curated whitelist exact match (e.g. "BUND e.V.", "DRK", "Caritas")
 *   2. Curated whitelist fuzzy match (Jaro-Winkler ≥ 0.92)
 *   3. LLM disambiguation with context window (Gemma-4 / Mistral-small):
 *      "Given the document context and this raw mention, what is the
 *       canonical organization name? Is it a recognized German charity
 *       (gemeinnützig) under § 52 AO?"
 *   4. Mark _resolution.is_charitable_certified accordingly
 *
 * The OCR post-correction (e.g. "Bolthasar" → "Balthasar") falls out
 * naturally from cosine + LLM disambiguation in steps 2+3.
 */

import { chatJson } from '../../../lib/llm-chat.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Curated whitelist — small, hand-maintained, high-precision
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownEntity {
  /** Canonical display name */
  canonical: string;
  /** Aliases / known variants (incl. common OCR errors) */
  aliases: string[];
  /** Entity type */
  type: 'verein' | 'stiftung' | 'gmbh' | 'koerperschaft' | 'finanzamt' | 'bank' | 'other';
  /** True if officially gemeinnützig per § 52 AO */
  isCharitableCertified: boolean;
  /** Country (ISO) */
  country: string;
  /** Optional region (DE, EU, EWR, OTHER) */
  region?: 'DE' | 'EU' | 'EWR' | 'OTHER';
  /** Optional Steuernummer / FA-Nummer of the certifying tax office */
  certifyingTaxOffice?: string;
  /** Optional Bezirk for tax classification */
  bezirk?: string;
  /** Free-form note */
  note?: string;
}

/**
 * Hand-curated whitelist. Grow this organically as documents introduce
 * new entities; each entry must be verified against the BfJ Vereinsregister
 * or the entity's own Freistellungsbescheid. NEVER guess certification status.
 */
export const WHITELIST: KnownEntity[] = [
  {
    canonical: 'BUND e.V. (Bund für Umwelt und Naturschutz Deutschland)',
    aliases: ['BUND', 'BUND e.V.', 'Bund für Umwelt und Naturschutz Deutschland', 'Bund für Umwelt und Naturschutz Deutschland e.V.'],
    type: 'verein',
    isCharitableCertified: true,
    country: 'DE',
    region: 'DE',
    note: 'Anerkannter Naturschutzverband, gemeinnützig § 52 AO',
  },
  {
    canonical: 'Kinder- und Jugendhospizstiftung Balthasar',
    aliases: [
      'Kinder- und Jugendhospizstiftung Balthasar',
      'Hospizstiftung Balthasar',
      'Hospiz Balthasar',
      'Hospiz Bolthasar',  // OCR typo seen in Hildburg's Spendenquittung
      'Hospitz Balthasar', // common alt-spelling
      'Balthasar Stiftung',
    ],
    type: 'stiftung',
    isCharitableCertified: true,
    country: 'DE',
    region: 'DE',
    certifyingTaxOffice: 'Finanzamt Olpe (StNr. 338/5859/1016)',
    note: 'Inländische Stiftung des privaten Rechts, gemeinnützig § 52 Abs. 2 Satz 1 Nr. 4 AO',
  },
  {
    canonical: 'Deutsches Rotes Kreuz (DRK)',
    aliases: ['DRK', 'Deutsches Rotes Kreuz', 'Deutsches Rotes Kreuz e.V.'],
    type: 'verein',
    isCharitableCertified: true,
    country: 'DE',
    region: 'DE',
  },
  {
    canonical: 'Caritas Deutschland',
    aliases: ['Caritas', 'Deutscher Caritasverband', 'Caritasverband'],
    type: 'verein',
    isCharitableCertified: true,
    country: 'DE',
    region: 'DE',
  },
  {
    canonical: 'Ärzte ohne Grenzen Deutschland',
    aliases: ['Ärzte ohne Grenzen', 'Doctors without Borders', 'MSF Deutschland'],
    type: 'verein',
    isCharitableCertified: true,
    country: 'DE',
    region: 'DE',
  },
  {
    canonical: 'Augustinum Seniorenresidenzen / Collegium Augustinum gemeinnützige GmbH',
    aliases: ['Augustinum', 'Augustinum Seniorenresidenz', 'Collegium Augustinum', 'Augustinum Bad Neuenahr'],
    type: 'gmbh',
    isCharitableCertified: true,  // gemeinnützige GmbH, AGB München HRB 144565
    country: 'DE',
    region: 'DE',
    note: 'Betreiber Hildburgs Wohnstift Bad Neuenahr',
  },
];

// Pre-build normalized alias index
const ALIAS_INDEX = new Map<string, KnownEntity>();
for (const e of WHITELIST) {
  for (const a of [e.canonical, ...e.aliases]) {
    ALIAS_INDEX.set(normalize(a), e);
  }
}

function normalize(s: string): string {
  return String(s ?? '').toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ßẞ]/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Jaro-Winkler — for fuzzy whitelist match
// ─────────────────────────────────────────────────────────────────────────────

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(b.length, i + matchDistance + 1);
    for (let j = start; j < end; j++) {
      if (bMatched[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const t = transpositions / 2;
  const jaro = (m / a.length + m / b.length + (m - t) / m) / 3;
  // Winkler boost up to first 4 matching chars
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolutionResult {
  /** Canonical name (from whitelist or LLM-cleaned raw) */
  canonical: string;
  /** Original raw text from extraction */
  raw: string;
  /** Was an OCR / typo correction applied? */
  correctionApplied: boolean;
  /** Resolved entity type */
  type: KnownEntity['type'] | 'unknown';
  /** True if certified gemeinnützig under § 52 AO; false if NOT certified;
   *  null if unknown (proceed with caution downstream) */
  isCharitableCertified: boolean | null;
  /** Country / region for cross-border deductibility */
  country: string;
  region?: 'DE' | 'EU' | 'EWR' | 'OTHER';
  /** Confidence 0..1 */
  confidence: number;
  /** Which stage matched */
  source: 'whitelist-exact' | 'whitelist-fuzzy' | 'llm-grounded' | 'llm-uncertain' | 'unresolved';
  /** Explanatory note */
  reasoning: string;
}

export interface ResolveOptions {
  /** Optional surrounding context — sentence/paragraph from document */
  context?: string;
  /** Expected entity type hint */
  typeHint?: KnownEntity['type'];
  /** Whether to call the LLM if no whitelist match (default true) */
  allowLlm?: boolean;
  chatProvider?: 'mistral' | 'ollama' | 'vllm';
  chatModel?: string;
}

export async function resolveEntity(
  raw: string,
  opts: ResolveOptions = {},
): Promise<ResolutionResult> {
  const original = String(raw ?? '').trim();
  const norm = normalize(original);

  // Stage 1: exact whitelist
  const exact = ALIAS_INDEX.get(norm);
  if (exact) {
    const correctionApplied = normalize(exact.canonical) !== norm;
    return {
      canonical: exact.canonical,
      raw: original,
      correctionApplied,
      type: exact.type,
      isCharitableCertified: exact.isCharitableCertified,
      country: exact.country,
      region: exact.region,
      confidence: 1.0,
      source: 'whitelist-exact',
      reasoning: `whitelist exact match${correctionApplied ? ' (correction applied)' : ''}`,
    };
  }

  // Stage 2: fuzzy whitelist (Jaro-Winkler ≥ 0.92)
  let bestFuzzy: { entity: KnownEntity; matchedAlias: string; score: number } | null = null;
  for (const e of WHITELIST) {
    for (const a of [e.canonical, ...e.aliases]) {
      const score = jaroWinkler(norm, normalize(a));
      if (score >= 0.92 && (!bestFuzzy || score > bestFuzzy.score)) {
        bestFuzzy = { entity: e, matchedAlias: a, score };
      }
    }
  }
  if (bestFuzzy) {
    return {
      canonical: bestFuzzy.entity.canonical,
      raw: original,
      correctionApplied: true,
      type: bestFuzzy.entity.type,
      isCharitableCertified: bestFuzzy.entity.isCharitableCertified,
      country: bestFuzzy.entity.country,
      region: bestFuzzy.entity.region,
      confidence: 0.85 + (bestFuzzy.score - 0.92) * 1.5, // 0.92→0.85, 1.0→0.97
      source: 'whitelist-fuzzy',
      reasoning: `whitelist Jaro-Winkler ${bestFuzzy.score.toFixed(3)} → "${bestFuzzy.matchedAlias}"`,
    };
  }

  // Stage 3: LLM disambiguation
  if (opts.allowLlm === false) {
    return {
      canonical: original,
      raw: original,
      correctionApplied: false,
      type: opts.typeHint ?? 'unknown',
      isCharitableCertified: null,
      country: 'DE',
      confidence: 0.3,
      source: 'unresolved',
      reasoning: 'No whitelist match, LLM disabled',
    };
  }

  const provider = opts.chatProvider ??
    (process.env.CHAT_PROVIDER as 'mistral' | 'ollama' | undefined) ?? 'ollama'; // lint-no-env: allow — pre-P10 elster-v1 lib, not yet migrated to ctx.tools
  const model = opts.chatModel ??
    (provider === 'mistral' ? 'mistral-small-latest' : 'gemma4:e4b');

  const prompt = [
    `Du bist ein Steuerberater-Experte. Identifiziere die folgende Organisation, die in einem deutschen Steuerdokument erwähnt wird.`,
    `Möglicherweise ist der Name durch OCR-Fehler verfälscht.`,
    ``,
    `Roher Text: "${original}"`,
    opts.context ? `\nKontext aus dem Dokument: "${opts.context.slice(0, 500)}"` : '',
    opts.typeHint ? `\nVermuteter Typ: ${opts.typeHint}` : '',
    ``,
    `Antworte als JSON:`,
    `{`,
    `  "canonical": "korrekter offizieller Name (oder leer wenn unbekannt)",`,
    `  "type": "verein" | "stiftung" | "gmbh" | "koerperschaft" | "finanzamt" | "bank" | "other" | "unknown",`,
    `  "is_charitable_certified": true | false | null,  // gemeinnützig nach § 52 AO`,
    `  "country": "DE" | "AT" | "CH" | ...,`,
    `  "region": "DE" | "EU" | "EWR" | "OTHER",`,
    `  "ocr_correction_applied": true | false,`,
    `  "confidence": 0.0..1.0,`,
    `  "begruendung": "warum dieser Name; wenn unsicher, sei explizit"`,
    `}`,
    ``,
    `WICHTIG: Wenn du dir bei is_charitable_certified nicht sicher bist, setze null — nicht raten.`,
    `Nur erkannte deutsche Großspendenempfänger (BUND, DRK, Caritas, Ärzte ohne Grenzen, Misereor, Brot für die Welt etc.)`,
    `und Stiftungen mit bekannter Freistellungsbescheid sind sicher gemeinnützig.`,
  ].filter(Boolean).join('\n');

  try {
    const { parsed } = await chatJson<{
      canonical?: string;
      type?: string;
      is_charitable_certified?: boolean | null;
      country?: string;
      region?: 'DE' | 'EU' | 'EWR' | 'OTHER';
      ocr_correction_applied?: boolean;
      confidence?: number;
      begruendung?: string;
    }>(prompt, { provider, model, temperature: 0 });
    const canonical = (parsed.canonical ?? '').trim() || original;
    return {
      canonical,
      raw: original,
      correctionApplied: parsed.ocr_correction_applied === true,
      type: (parsed.type as KnownEntity['type']) ?? 'unknown',
      isCharitableCertified: parsed.is_charitable_certified ?? null,
      country: parsed.country ?? 'DE',
      region: parsed.region,
      confidence: Math.max(0.3, Math.min(0.9, parsed.confidence ?? 0.5)),
      source: parsed.confidence && parsed.confidence >= 0.7 ? 'llm-grounded' : 'llm-uncertain',
      reasoning: `llm-${model}: ${parsed.begruendung ?? 'no reason'}`,
    };
  } catch (e) {
    return {
      canonical: original,
      raw: original,
      correctionApplied: false,
      type: opts.typeHint ?? 'unknown',
      isCharitableCertified: null,
      country: 'DE',
      confidence: 0.2,
      source: 'unresolved',
      reasoning: `LLM error: ${(e as Error).message}`,
    };
  }
}
