/**
 * elster-v3/quantum-ground — extract candidate eCodes from the OCR text BEFORE
 * Layer-1 runs.
 *
 * Strategy:
 *   1. Split the OCR markdown into "head phrasen" — visually salient lines that
 *      tend to be form labels (Drucktexte). We use a heuristic that selects
 *      short, all-caps/title-case, label-like lines from the top of each page
 *      plus any line that looks like a question/heading.
 *   2. Batch-embed those phrasen via EmbeddingGemma (query-side prompt).
 *   3. For each phrase, run the cascade and collect top-K candidate atoms.
 *   4. Union the per-phrase top-K sets, weight by score, return the global
 *      top-N candidate eCodes (default N=50).
 *
 * The output feeds Layer-1 via its `kandidatenECodes` input — the prompt then
 * tells Gemma-4 "look for these eCodes" instead of letting it guess across
 * all 2287. Constrains the vocabulary, lifts mapping accuracy.
 */
import { defineStage } from '../../../core/stage.ts';
import { embedQueries, type GemmaEmbedOptions } from '../../../lib/gemma-embed.ts';
import {
  einkunftsartVonAtom,
  type CatalogAtom,
  type EinkunftsartCode,
} from '../../../lib/elster-catalog.ts';
import type { CatalogHandle, RagIndexHandle } from '../../../core/tools/handles.ts';

// ─── Phrase extraction ───────────────────────────────────────────────────
// We're not building a full NLP layout-aware extractor here — the OCR text is
// markdown with line breaks, and we just want salient candidate-query phrasen.
// Empirically good heuristics for German tax forms:
//   • lines 6–80 chars (form labels are short)
//   • drop lines with currency symbols or pure digits (those are values, not labels)
//   • drop common boilerplate (Steuernummer, Datum, Unterschrift, etc.) where
//     the same word appears in 100+ unrelated forms — adds noise to top-K
//   • dedupe by case-insensitive trim

const BOILERPLATE_DROP = new Set([
  'datum', 'unterschrift', 'ort', 'name', 'seite', 'page', 'inhalt',
  'angaben', 'ja', 'nein', 'x',
]);

/** Extract candidate-query phrasen from OCR markdown. Pure / deterministic. */
export function extrahierePhrasen(text: string, maxPhrasen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length >= maxPhrasen) break;
    // Strip markdown decorations (#, *, |, leading bullets, etc.)
    const line = rawLine
      .replace(/^[#>\-\*\|\s]+/, '')
      .replace(/[\|]+/g, ' ')
      .trim();
    if (line.length < 6 || line.length > 80) continue;
    // Must contain at least one letter (drop "1.234,56 €" rows etc.)
    if (!/[A-Za-zÄÖÜäöüß]/.test(line)) continue;
    // Skip currency-tailed lines (label-only is fine — value rows are not)
    if (/€\s*$/.test(line)) continue;
    // Skip IBANs and long account-number strings (8+ consecutive digits) —
    // shorter digit runs like "2024" are fine and may be part of a heading.
    if (/\d{8,}/.test(line)) continue;
    // Skip rows that *start* with digits — postal codes ("12345 Stadt"),
    // dates ("2024-12-31"), invoice numbers etc. Headings starting with
    // letters but containing a year inline are still fine.
    if (/^\d{4,}/.test(line)) continue;
    const norm = line.toLowerCase();
    if (seen.has(norm)) continue;
    if (BOILERPLATE_DROP.has(norm)) continue;
    seen.add(norm);
    out.push(line);
  }
  return out;
}

// ─── Stage ───────────────────────────────────────────────────────────────

export interface QuantumGroundInput {
  /** OCR markdown — typically `${ocr.text}` from the workflow. */
  text: string;
  /** Doc-Class von der Klassifizierungs-Stage (z.B. "lohnsteuerbescheinigung"). */
  dokumenttyp_id?: string;
  /**
   * Anlagen-Whitelist von der Klassifizierungs-Stage (z.B. ["N", "VOR"] für
   * Lohnsteuerbescheinigung). Wenn gesetzt:
   *   • Pflicht-Atome dieser Anlagen werden als Scaffold IMMER aufgenommen
   *     (auch ohne Embedding-Treffer).
   *   • Cascade-Treffer werden auf diese Anlagen + kleinen out-of-anlage
   *     Tail beschränkt (gegen Fehlklassifikation).
   * Leer/undefined → keine Filterung (Default-Verhalten).
   */
  anlagen?: string[];
}

export interface QuantumGroundConfig {
  /** Override the data directory. */
  dataDir?: string;
  manifestFile?: string;
  atomsFile?: string;
  /** Max phrasen to extract from OCR. Default 30. */
  maxPhrasen?: number;
  /** Per-phrase cascade top-K (pre-aggregation). Default 10. */
  proPhraseK?: number;
  /** Final union size returned to Layer-1. Default 50. */
  finalK?: number;
  /** Wenn anlagen gesetzt: alle Pflicht-Atome dieser Anlagen als Scaffold
   *  einbeziehen, unabhängig vom Embedding-Score. Default true. */
  pflichtScaffold?: boolean;
  /** Wenn anlagen gesetzt: wie viele Cascade-Treffer aus anderen Anlagen
   *  trotzdem behalten werden (gegen Fehlklassifikation). Default 5. */
  outOfAnlageTail?: number;
  /** Forward to gemma-embed. */
  embed?: Pick<GemmaEmbedOptions, 'url' | 'model' | 'cpuOnly'>;
}

export interface KandidatECode {
  atom_id: string;
  field_name: string;
  /** ELSTER-Anlage (z.B. "N", "SA"). */
  anlage: string;
  /** Datentyp — treibt Layer-1-Normalisierung + Verifier-Regex-Check. */
  datentyp: 'string' | 'date' | 'currency';
  /** Ob das Feld pflicht=true ist. */
  pflicht: boolean;
  /** BMF-Vordruck-Zeile (Rechts-Zitat-Anker). */
  vordruckzeile: string;
  /** Feld-Label wie auf dem Vordruck gedruckt. */
  drucktext: string;
  /** Catalog-Bezeichnung (oft == drucktext; Fallback-Name). */
  bezeichnung: string;
  /** Atom-spezifisches ELSTER-Format-Regex (für Validierung). */
  formatRegex: string;
  /** Einkunftsart-Prefix aus metadata.kontextPaths (BMF-Vokabular,
   *  z.B. "ArbL" für §19 Arbeitslohn, "Zuw" für §10b Spenden). */
  einkunftsart: EinkunftsartCode | null;
  /** Provenance / Trust. "verified" = BMF primary source. */
  trustLevel: string;
  citationDocument: string;
  /**
   * Wie dieser Kandidat aufgenommen wurde:
   *   "scaffold"  → Pflicht-Atom in einer whitelisted Anlage; immer dabei.
   *   "cascade"   → Embedding-Retrieval-Treffer (typischer Fall).
   *   "out_of_anlage" → Cascade-Treffer außerhalb der whitelisted Anlagen
   *                     (Sicherheitsnetz gegen Fehlklassifikation).
   */
  quelle: 'scaffold' | 'cascade' | 'out_of_anlage';
  /** Summe der per-Phrase-Scores wenn dieses Atom auftauchte (0 für scaffold). */
  aggregatedScore: number;
  /** Wie oft das Atom in einer Phrase-Top-K erschien (0 für scaffold). */
  hitCount: number;
}

export interface QuantumGroundOutput {
  phrasen: string[];
  kandidatenECodes: KandidatECode[];
  /** Eindeutige Einkunftsarten in der Kandidaten-Liste (in Reihenfolge des
   *  ersten Vorkommens). Wird von Layer-1 für den §EStG-Prompt-Frame genutzt. */
  einkunftsarten: EinkunftsartCode[];
  stats: {
    phrasen: number;
    embedMs: number;
    retrieveMs: number;
    scaffoldAtome: number;
    cascadeTreffer: number;
    outOfAnlageTreffer: number;
    kandidatenZurueckgegeben: number;
    katalogAtome: number;
  };
}

export const quantumGroundStage = defineStage<QuantumGroundInput, QuantumGroundOutput, QuantumGroundConfig>({
  id: 'elster-v3/quantum-ground',
  name: 'Quantum-ground — pre-Layer-1 candidate-eCode shortlist',
  description:
    'Extracts label-like phrasen from OCR text, runs each through the EmbeddingGemma+TurboQuant cascade, and aggregates the union of per-phrase top-K into a dokumenttyp_id-scoped kandidatenECodes list (default top-50) that constrains Layer-1\'s eCode vocabulary.',
  hints: {
    inputs: 'text (OCR markdown) · optional: dokumenttyp_id',
    outputs: 'phrasen (extracted query strings), kandidatenECodes (top-N eCodes ranked by aggregate score), stats',
    configExample: JSON.stringify({ maxPhrasen: 30, proPhraseK: 10, finalK: 50 }, null, 2),
    acceptsContainers: ['embedding-index'],
    inputPorts: [{ name: 'text', type: 'text' }, { name: 'dokumenttyp_id', type: 'string' }],
    outputPorts: [
      { name: 'kandidatenECodes', type: 'candidates' },
      { name: 'phrasen', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    // dataDir/manifestFile/atomsFile config-Felder bleiben für Rückwärtskompat
    // im Schema, werden aber seit P10 nicht mehr gelesen — die Anwendung-Tools
    // `elster-rag` und `elster-catalog` liefern Index + Atome.
    const maxPhrasen = cfg.maxPhrasen ?? 30;
    const proPhraseK = cfg.proPhraseK ?? 10;
    const finalK = cfg.finalK ?? 50;
    const pflichtScaffold = cfg.pflichtScaffold ?? true;
    const outOfAnlageTail = cfg.outOfAnlageTail ?? 5;
    const embedOpts: GemmaEmbedOptions = { ...(cfg.embed ?? {}), signal: ctx.signal };
    const anlagenWhitelist = (input.anlagen ?? []).filter((a) => typeof a === 'string' && a.length > 0);
    const useWhitelist = anlagenWhitelist.length > 0;
    const whitelistSet = new Set(anlagenWhitelist);

    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new Error('quantum-ground: input.text required');
    }

    const phrasen = extrahierePhrasen(input.text, maxPhrasen);
    ctx.emit('phrasen_extracted', { count: phrasen.length, sample: phrasen.slice(0, 5) });

    // P10: `elster-rag` und `elster-catalog` sind required:true im
    // steuerfall-est-Roster. NullToolContainer wirft eine klare Fehlermeldung,
    // wenn der Workflow ohne Anwendung-Kontext läuft.
    const rag = ctx.tools.get<RagIndexHandle>('elster-rag');
    const cat = ctx.tools.get<CatalogHandle>('elster-catalog');
    const atoms: CatalogAtom[] = cat.get<CatalogAtom[]>('atoms');

    const baueKandidat = (
      a: CatalogAtom,
      quelle: KandidatECode['quelle'],
      aggregatedScore: number,
      hitCount: number,
    ): KandidatECode => ({
      atom_id: a.atom_id,
      field_name: a.field_name,
      anlage: a.metadata.anlage,
      datentyp: a.metadata.datentyp,
      pflicht: a.metadata.pflicht,
      vordruckzeile: a.metadata.vordruckzeile,
      drucktext: a.metadata.drucktext,
      bezeichnung: a.value,
      formatRegex: a.metadata.formatRegex,
      einkunftsart: einkunftsartVonAtom(a),
      trustLevel: a.trust_level,
      citationDocument: a.citation_document,
      quelle,
      aggregatedScore,
      hitCount,
    });

    // ── (1) Pflicht-Scaffold aus Anlagen-Whitelist ────────────────────
    // Sicherstellen, dass alle pflicht=true Atome der relevanten Anlagen
    // im Layer-1-Prompt landen, auch wenn die OCR-Phrasen sie nicht treffen.
    const scaffoldIdxs = new Set<number>();
    if (useWhitelist && pflichtScaffold) {
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        if (whitelistSet.has(a.metadata.anlage) && a.metadata.pflicht) {
          scaffoldIdxs.add(i);
        }
      }
    }

    // ── (2) Embedding-Cascade pro Phrase ──────────────────────────────
    let embedMs = 0;
    let retrieveMs = 0;
    const cascadeAgg = new Map<number, { sumScore: number; count: number }>();
    if (phrasen.length > 0) {
      const tEmb = Date.now();
      const queryVecs = await embedQueries(phrasen, embedOpts);
      embedMs = Date.now() - tEmb;

      const tRet = Date.now();
      for (const qv of queryVecs) {
        const ragHits = await rag.retrieve(Array.from(qv), { topK: proPhraseK, signal: ctx.signal });
        const scored: Array<{ idx: number; score: number }> = ragHits.map((h) => ({ idx: Number(h.id), score: h.score }));
        for (const h of scored) {
          const e = cascadeAgg.get(h.idx);
          if (e) { e.sumScore += h.score; e.count += 1; }
          else cascadeAgg.set(h.idx, { sumScore: h.score, count: 1 });
        }
      }
      retrieveMs = Date.now() - tRet;
    }

    // ── (3) Ranken: scaffold zuerst, dann in-whitelist cascade, dann
    //              out-of-anlage cascade-Tail (max outOfAnlageTail Einträge).
    const inAnlage: KandidatECode[] = [];
    const outOfAnlage: KandidatECode[] = [];
    for (const [idx, e] of cascadeAgg.entries()) {
      if (scaffoldIdxs.has(idx)) continue; // wird unten als scaffold ergänzt (höhere Priorität)
      const a = atoms[idx];
      if (useWhitelist && !whitelistSet.has(a.metadata.anlage)) {
        outOfAnlage.push(baueKandidat(a, 'out_of_anlage', e.sumScore, e.count));
      } else {
        inAnlage.push(baueKandidat(a, 'cascade', e.sumScore, e.count));
      }
    }
    inAnlage.sort((p, q) => q.aggregatedScore - p.aggregatedScore);
    outOfAnlage.sort((p, q) => q.aggregatedScore - p.aggregatedScore);

    const scaffold: KandidatECode[] = [];
    for (const idx of scaffoldIdxs) {
      const e = cascadeAgg.get(idx);
      scaffold.push(baueKandidat(atoms[idx], 'scaffold', e?.sumScore ?? 0, e?.count ?? 0));
    }
    // Scaffold sortieren wir nach Anlage + Vordruckzeile (deterministische
    // Reihenfolge, hilft Layer-1's Prompt-Lesbarkeit).
    scaffold.sort((p, q) => {
      if (p.anlage !== q.anlage) return p.anlage.localeCompare(q.anlage);
      const pz = Number(p.vordruckzeile) || 0;
      const qz = Number(q.vordruckzeile) || 0;
      return pz - qz;
    });

    const tail = outOfAnlage.slice(0, outOfAnlageTail);
    let ranked: KandidatECode[] = [...scaffold, ...inAnlage, ...tail];
    if (ranked.length > finalK) ranked = ranked.slice(0, finalK);

    // Eindeutige Einkunftsarten in Reihenfolge des ersten Vorkommens
    // (BMF-Vokabular aus den kontextPaths der Atome).
    const einkunftsartenSet = new Set<string>();
    const einkunftsarten: EinkunftsartCode[] = [];
    for (const k of ranked) {
      if (k.einkunftsart && !einkunftsartenSet.has(k.einkunftsart)) {
        einkunftsartenSet.add(k.einkunftsart);
        einkunftsarten.push(k.einkunftsart);
      }
    }

    const cascadeTreffer = inAnlage.length;
    const outOfAnlageTreffer = tail.length;

    ctx.emit('kandidaten_grounded', {
      kandidaten: ranked.length,
      scaffold: scaffold.length,
      cascade: cascadeTreffer,
      out_of_anlage: outOfAnlageTreffer,
      anlagen_whitelist: anlagenWhitelist,
      einkunftsarten,
      top_eCode: ranked[0]?.field_name,
      top_score: ranked[0]?.aggregatedScore,
    });
    await ctx.artifacts.write('kandidaten_ecodes.json', ranked);

    return {
      phrasen,
      kandidatenECodes: ranked,
      einkunftsarten,
      stats: {
        phrasen: phrasen.length,
        embedMs,
        retrieveMs,
        scaffoldAtome: scaffold.length,
        cascadeTreffer,
        outOfAnlageTreffer,
        kandidatenZurueckgegeben: ranked.length,
        katalogAtome: atoms.length,
      },
    };
  },
});
