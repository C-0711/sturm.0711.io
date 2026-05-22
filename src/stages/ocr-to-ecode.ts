/**
 * ocr-to-ecode — OCR-Markdown → {eCode, wert} via PolarQuant Tier-1.
 *
 * Schritte (alle deterministisch, kein LLM):
 *   1. splitSections(markdown) — H-Header / Tabellen-Blöcke
 *   2. extractBelegContext(markdown) — Belegtyp, Übermittler, kontextPaths
 *   3. polarMatchSection — Embedding-Match je Section gegen 2287 atoms
 *      (anlage-whitelist via BelegContext.allowedAnlagen)
 *   4. tier1Extract — Strategy-Cascade:
 *      A) vordruckzeile-anchor   (Layout B mit "(Zeile NN)" + Zahl)
 *      B) drucktext-proximity    (Höhe / Tabellen-Format)
 *      C) section-single         (eindeutige Zahl in Sektion)
 *   5. Audit-fest: container_atom_id + polar_score + polar_margin + strategy.
 *
 * Latenz: ~150-300 ms je Beleg (Embed-Batch via vLLM :11436 + fp32-Rerank).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../core/stage.ts';
import { ExactFp32Index, type CascadeManifest } from '../lib/quantum-index.ts';
import {
  splitSections,
  extractBelegContext,
  polarMatchSection,
  tier1Extract,
  loadContainerAtoms,
  type AtomMeta,
  type Tier1Result,
} from '../verticals/elster-v3/lib/polarquant-tier1.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../verticals/elster-v3/data');

export interface OcrToEcodeInput {
  markdown: string;
  belegtyp?: string;
  /** Override: zusätzliche Anlagen freigeben (über default-Liste hinaus). */
  extraAllowedAnlagen?: string[];
  /** Minimaler Cosinus für Akzeptanz. Default 0.55. */
  minScore?: number;
  /** Minimaler Margin top1-top2. Default 0.02 (sehr permissiv). */
  minMargin?: number;
  /** Pro-Beleg-Source-Tag (Dateiname). */
  doc?: string;
}

export interface CanonicalEntry {
  ecode: string;
  anlage: string;
  drucktext: string;
  vordruckzeile?: string | null;
  values: Array<{
    value: string;
    value_numeric?: number | null;
    value_elster_xml?: string | null;
    strategy: string;
    polar_score: number;
    polar_margin: number;
    source_doc?: string;
    section_heading?: string;
  }>;
}

export interface OcrToEcodeOutput {
  canonical_layer: Record<string, CanonicalEntry>;
  beleg_context: any;
  sections_total: number;
  sections_with_hit: number;
  stats: {
    embed_ms: number;
    match_ms: number;
    extract_ms: number;
    total_ms: number;
    distinct_ecodes: number;
  };
}

// ─── Cached Catalog ─────────────────────────────────────────────────────────
interface CatalogCache {
  atomsByIdx: AtomMeta[];
  exact: ExactFp32Index;
}
let _cached: CatalogCache | null = null;
async function loadCatalog(): Promise<CatalogCache> {
  if (_cached) return _cached;
  const cm: CascadeManifest = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'),
  );
  if (!cm.exact) throw new Error('cascade manifest missing exact tier');
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact.file), cm.exact.d);
  const { atomsByIdx } = await loadContainerAtoms(path.join(DATA_DIR, 'atoms.json'));
  _cached = { atomsByIdx, exact };
  return _cached;
}

export const ocrToEcodeStage = defineStage<OcrToEcodeInput, OcrToEcodeOutput>({
  id: 'ocr-to-ecode',
  name: 'OCR → eCode (PolarQuant Tier-1)',
  description:
    'Deterministic section → atom matching: splitSections + extractBelegContext + ' +
    'polarMatchSection (Embedding via vLLM :11436) + tier1Extract (Vordruckzeile/Drucktext-Strategie).',

  async run(input, _ctx) {
    const t0 = Date.now();
    const md = input.markdown ?? '';
    const minScore = input.minScore ?? 0.55;
    const minMargin = input.minMargin ?? 0.02;
    if (!md.trim()) {
      return {
        canonical_layer: {}, beleg_context: {},
        sections_total: 0, sections_with_hit: 0,
        stats: { embed_ms: 0, match_ms: 0, extract_ms: 0, total_ms: 0, distinct_ecodes: 0 },
      };
    }

    const catalog = await loadCatalog();
    const beleg = extractBelegContext(md);
    if (input.belegtyp && !beleg.belegtyp) beleg.belegtyp = input.belegtyp;
    if (input.extraAllowedAnlagen?.length) {
      const merged = new Set([...(beleg.allowedAnlagen ?? []), ...input.extraAllowedAnlagen]);
      beleg.allowedAnlagen = Array.from(merged);
    }

    const sections = splitSections(md);
    const canonical: Record<string, CanonicalEntry> = {};
    let embedMs = 0;
    let matchMs = 0;
    let extractMs = 0;
    let sectionsWithHit = 0;

    let secProbed = 0;
    let secEmbedFail = 0;
    for (const sec of sections) {
      if (sec.body.trim().length < 4) continue;
      secProbed++;
      const tM0 = Date.now();
      let matchResult;
      try {
        matchResult = await polarMatchSection(sec, catalog.exact, catalog.atomsByIdx, beleg,
          5, process.env.EMBED_URL ?? 'http://host.docker.internal:11436');
      } catch (e) {
        secEmbedFail++;
        console.error('[ocr-to-ecode] polarMatchSection fail:', (e as Error).message);
        continue;
      }
      const dtM = Date.now() - tM0;
      matchMs += dtM;
      // First call dominated by embed; rough split
      embedMs += Math.round(dtM * 0.7);

      if (!matchResult || matchResult.candidates.length === 0) continue;
      const top = matchResult.candidates[0];
      if (top.score < minScore || matchResult.margin < minMargin) continue;

      const tE0 = Date.now();
      const result: Tier1Result = tier1Extract(sec, top.atom, top.score, matchResult.margin);
      extractMs += Date.now() - tE0;

      if (result.strategy === 'no-match' || !result.wert) continue;

      sectionsWithHit++;
      const ec = result.ecode;
      if (!canonical[ec]) {
        canonical[ec] = {
          ecode: ec,
          anlage: top.atom.anlage ?? '?',
          drucktext: (top.atom.drucktext ?? '').slice(0, 160),
          vordruckzeile: top.atom.vordruckzeile,
          values: [],
        };
      }
      canonical[ec].values.push({
        value: result.wert,
        value_numeric: result.wert_numeric,
        value_elster_xml: result.wert_elster_xml,
        strategy: result.strategy,
        polar_score: result.audit.polar_score,
        polar_margin: result.audit.polar_margin,
        source_doc: input.doc,
        section_heading: sec.heading,
      });
    }

    console.error('[ocr-to-ecode]',
      'sections_total=' + sections.length,
      'probed=' + secProbed,
      'embed_fail=' + secEmbedFail,
      'hits=' + sectionsWithHit,
      'belegtyp=' + beleg.belegtyp,
      'allowed=' + (beleg.allowedAnlagen?.length ?? 0));
    return {
      canonical_layer: canonical,
      beleg_context: beleg,
      sections_total: sections.length,
      sections_with_hit: sectionsWithHit,
      stats: {
        embed_ms: embedMs,
        match_ms: matchMs - embedMs,
        extract_ms: extractMs,
        total_ms: Date.now() - t0,
        distinct_ecodes: Object.keys(canonical).length,
        sections_probed: secProbed,
        embed_fails: secEmbedFail,
      } as any,
    };
  },
});
