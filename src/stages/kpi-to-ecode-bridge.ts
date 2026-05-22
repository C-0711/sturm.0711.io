/**
 * kpi-to-ecode-bridge — KPI→eCode mit ZWEI Filter-Stufen:
 *
 *   Stufe 1: Polar Tier-1 (atoms.json fp32 embedding-match via vLLM :11436)
 *            — bekommt die Top-K Kandidaten pro KPI.
 *   Stufe 2: Bridge-Filter aus `shared.bmf_elster_zuordnung` + Lane-1
 *            `module_mappings` — behalte nur eCodes die Lane-1 wirklich
 *            konsumiert (= Triggerlogik feuert).
 *
 * Ohne Stufe 2 mapped Polar oft auf "ähnliche aber tote" eCodes (z. B.
 * E0201007 statt E0200201 für "Bruttoarbeitslohn"). Das war der ZvE=0 Bug.
 *
 * Stage liefert canonical_layer mit eCodes die DIREKT in `elster_felder`
 * an Lane-1 V2 gehen können — keine zusätzliche Übersetzung nötig.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { defineStage } from '../core/stage.ts';
import { embedBatch, formatQuery, l2normalize } from '../lib/gemma-embed.ts';
import { ExactFp32Index, type CascadeManifest } from '../lib/quantum-index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../verticals/elster-v3/data');
const ECODE_RX = /^E\d{7}$/;

const CTAX_DB_URL = process.env.CTAX_DB_URL
  ?? 'postgres://ctax:d4521c0def2d5c0347585cf3c70f4d5ecee9abffceb854f0@host.docker.internal:12432/ctax';

export interface Kpi {
  key: string;
  value: string | number;
  belegtyp?: string;
  doc?: string;
}

export interface KpiToEcodeBridgeInput {
  kpis: Kpi[];
  minScore?: number;
  defaultBelegtyp?: string;
  allowedAnlagen?: string[];
  /** topK candidates from Polar before Lane-1-filter applied. Default 5. */
  topK?: number;
  /** Optional OCR-markdown für Beleg-Kontext (Aktivlohn vs Versorgungsbezug-Detection). */
  ocrMarkdown?: string;
}

export interface CanonicalEntry {
  ecode: string;
  anlage: string;
  drucktext: string;
  bmf_field?: string;
  bridge_source?: string;
  bridge_confidence?: number;
  values: Array<{
    value: string | number;
    source_doc?: string;
    source_kpi_key?: string;
    score: number;
    rank_in_topk: number;
    tier: 'bridge-exact' | 'bridge-filtered-tier1';
    via?: 'bmf_field-exact' | 'polar-embedding';
  }>;
}

export interface KpiToEcodeBridgeOutput {
  canonical_layer: Record<string, CanonicalEntry>;
  stats: {
    kpis_in: number;
    accepted: number;
    rejected: number;
    rejected_no_polar_hit: number;
    rejected_not_lane1: number;
    distinct_ecodes: number;
    embed_ms: number;
    rerank_ms: number;
    total_ms: number;
  };
  unmatched: Array<{ key: string; value: any; top_polar_ecode?: string; top_polar_score?: number }>;
}

// ─── Atoms.json Cache ───────────────────────────────────────────────────────
interface Atom {
  field_name: string;
  value: string;
  metadata?: {
    anlage?: string;
    drucktext?: string;
    vordruckzeile?: string;
    datentyp?: string;
  };
}
interface CatalogCache {
  atomsRaw: Atom[];
  ecodeIndices: number[];
  exact: ExactFp32Index;
}
let _catalogCache: CatalogCache | null = null;
async function loadCatalog(): Promise<CatalogCache> {
  if (_catalogCache) return _catalogCache;
  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const cm: CascadeManifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'));
  if (!cm.exact) throw new Error('cascade manifest has no exact tier');
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact.file), cm.exact.d);
  const ecodeIndices: number[] = [];
  for (let i = 0; i < atomsRaw.length; i++) {
    if (ECODE_RX.test(atomsRaw[i].field_name)) ecodeIndices.push(i);
  }
  _catalogCache = { atomsRaw, ecodeIndices, exact };
  return _catalogCache;
}

// ─── Bridge Cache (postgres) ────────────────────────────────────────────────
interface BridgeCache {
  // Lane-1 konsumierbare eCodes (was berechne_vollstaendige_steuer_v2 wirklich nutzt)
  lane1Consumable: Set<string>;
  // Bridge: eCode → primary bmf_field (für Reporting)
  bridgePrimary: Map<string, { bmf_field: string; mapping_source: string; confidence: number | null; reasoning: string }>;
  // REVERSE: normalized bmf_field → eCode (für direkten Lookup ohne Embedding).
  // Nur Lane-1-konsumierbare eCodes, primary mappings, höchste confidence wins.
  bmfFieldToEcode: Map<string, { ecode: string; bmf_field: string; confidence: number | null; reasoning: string }>;
}

/**
 * Normalisiere einen kpi.key oder bmf_field auf eine vergleichbare Form:
 *   "Bruttoarbeitslohn Person A" → "bruttoarbeitslohn"
 *   "einbehaltene Lohnsteuer" → "lohnsteuer" (drop "einbehaltene")
 *   "Höhe geleisteter Beiträge Krankenversicherung Person A" → "krankenversicherung"
 *
 * Drop-Wörter sind generisch-funktional, keine semantik-tragenden Begriffe.
 */
const DROP_WORDS = new Set([
  'person', 'a', 'b', 'der', 'die', 'das', 'des', 'dem', 'den',
  'einbehaltene', 'einbehaltener', 'einbehaltenes', 'einbehalten',
  'höhe', 'gesamtbetrag', 'gesamtbeitrag', 'geleisteter', 'geleistete', 'nachgewiesene',
  'beitrag', 'beiträge',
  'für', 'zu', 'zur', 'zum',
  'arbeitnehmer', 'arbeitgeber',
]);
const UMLAUT_MAP: Record<string, string> = { 'ä':'ae','ö':'oe','ü':'ue','ß':'ss','Ä':'ae','Ö':'oe','Ü':'ue' };
function normalizeFieldName(s: string): string {
  const lower = s.replace(/[äöüßÄÖÜ]/g, c => UMLAUT_MAP[c] ?? c).toLowerCase();
  const tokens = lower.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  const kept = tokens.filter(t => t && !DROP_WORDS.has(t) && t.length > 1);
  return kept.join('_');
}

/**
 * OCR-Markdown-Tabellen abräumen — extrahiert Label↔Wert-Paare die als
 * Markdown-Tabellenzeile auftauchen ("|  Label  |  Wert  |") und die Mistral
 * Small NICHT als kpi-Eintrag erfasst hat. Speist diese als zusätzliche kpis
 * in die bmf_field-exact-Matching-Phase.
 *
 * Keine Whitelist, keine Remaps — nur "alles was nach Wert aussieht und in
 * einer Tabellenzeile mit Label steht, ist ein potenzielles kpi".
 */
function supplementKpisFromOcrMarkdown(md: string): Kpi[] {
  if (!md) return [];
  const out: Kpi[] = [];
  const seen = new Set<string>();
  for (const line of md.split('\n')) {
    // Markdown-Tabellenzeile mit pipe-separator
    const m = line.match(/^\s*\|\s*([^|]{3,200}?)\s*\|\s*([^|]{1,200}?)\s*\|/);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2].trim();
    // Skip header / separator rows
    if (/^[-:\s]+$/.test(label) || /^[-:\s]+$/.test(value)) continue;
    if (!label || !value) continue;
    if (label === value) continue;
    // Skip leere oder Trennzeichen-werte
    if (/^[-—\s]+$/.test(value)) continue;
    // Skip kpi-keys ohne Buchstaben (zahlen-only labels)
    if (!/[a-zA-ZäöüÄÖÜ]/.test(label)) continue;
    const key = `${label}↦${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: label, value, doc: 'ocr-supplement' });
  }
  return out;
}
let _bridgeCache: BridgeCache | null = null;
let _bridgeCachePromise: Promise<BridgeCache> | null = null;

async function loadBridge(): Promise<BridgeCache> {
  if (_bridgeCache) return _bridgeCache;
  if (_bridgeCachePromise) return _bridgeCachePromise;
  _bridgeCachePromise = (async () => {
    const pool = new Pool({ connectionString: CTAX_DB_URL, max: 2 });
    try {
      const lane1Q = await pool.query(`
        SELECT DISTINCT unnest(elster_code_quelle) AS ec
          FROM bmf_steuerrechner.modul_zuordnungen
      `);
      const lane1Consumable = new Set<string>(lane1Q.rows.map((r: any) => String(r.ec)));

      const bridgeQ = await pool.query(`
        SELECT elster_code, bmf_field, mapping_source, confidence, reasoning, is_primary, priority
          FROM shared.bmf_elster_zuordnung
         WHERE is_primary
         ORDER BY priority DESC, confidence DESC NULLS LAST
      `);
      const bridgePrimary = new Map<string, any>();
      const bmfFieldToEcode = new Map<string, any>();
      for (const r of bridgeQ.rows) {
        const ec = r.elster_code as string;
        const bmfRaw = r.bmf_field as string;
        if (!bridgePrimary.has(ec)) {
          bridgePrimary.set(ec, {
            bmf_field: bmfRaw,
            mapping_source: r.mapping_source,
            confidence: r.confidence != null ? Number(r.confidence) : null,
            reasoning: r.reasoning ?? '',
          });
        }
        // Reverse-map: nur eCodes die Lane-1 wirklich konsumiert
        if (lane1Consumable.has(ec)) {
          const normKey = normalizeFieldName(bmfRaw);
          if (normKey && !bmfFieldToEcode.has(normKey)) {
            bmfFieldToEcode.set(normKey, {
              ecode: ec, bmf_field: bmfRaw,
              confidence: r.confidence != null ? Number(r.confidence) : null,
              reasoning: r.reasoning ?? '',
            });
          }
        }
      }

      _bridgeCache = { lane1Consumable, bridgePrimary, bmfFieldToEcode };
      console.log(`[kpi-to-ecode-bridge] cache: lane1Consumable=${lane1Consumable.size} bridgePrimary=${bridgePrimary.size} bmfFieldToEcode=${bmfFieldToEcode.size}`);
      return _bridgeCache;
    } finally {
      await pool.end().catch(() => {});
    }
  })();
  return _bridgeCachePromise;
}

export const kpiToEcodeBridgeStage = defineStage<KpiToEcodeBridgeInput, KpiToEcodeBridgeOutput>({
  id: 'kpi-to-ecode-bridge',
  name: 'KPI → eCode (Bridge-filtered Polar Tier-1)',
  description: 'Polar embedding top-K + Filter auf Lane-1-konsumierbare eCodes via bmf_elster_zuordnung',

  async run(input, _ctx) {
    const t0 = Date.now();
    const minScore = input.minScore ?? 0.45;
    const topK = input.topK ?? 5;
    const kpis = (input.kpis ?? []).filter(k => k?.key);

    if (kpis.length === 0) {
      return {
        canonical_layer: {}, unmatched: [],
        stats: { kpis_in: 0, accepted: 0, rejected: 0, rejected_no_polar_hit: 0, rejected_not_lane1: 0,
                 distinct_ecodes: 0, embed_ms: 0, rerank_ms: 0, total_ms: 0 },
      };
    }

    const [catalog, bridge] = await Promise.all([loadCatalog(), loadBridge()]);

    // OCR-Nachernte: extrahiere "Label | Wert"-Tabellenzeilen aus OCR-Markdown
    // die Mistral nicht als separate kpis erfasst hat. Speist die bmf_field-
    // exact-Phase mit zusätzlichen kpis — KEINE remap-shortcuts.
    const ocrKpis = supplementKpisFromOcrMarkdown(input.ocrMarkdown ?? '');
    if (ocrKpis.length > 0) {
      console.log(`[kpi-to-ecode-bridge] OCR-Nachernte: +${ocrKpis.length} kpis aus markdown-Tabellen`);
    }
    const kpisAll = [...kpis, ...ocrKpis];

    // anlage-whitelist mit IMMER-DABEI ESt1A (Stammdaten können aus jedem Beleg kommen)
    let candidateIndices = catalog.ecodeIndices;
    const wl = (input.allowedAnlagen ?? []).filter(Boolean);
    if (wl.length > 0) {
      const wlSet = new Set([...wl, 'ESt1A'].map(a => a.toUpperCase()));
      candidateIndices = catalog.ecodeIndices.filter(i => {
        const a = catalog.atomsRaw[i].metadata?.anlage;
        return a ? wlSet.has(String(a).toUpperCase()) : false;
      });
      if (candidateIndices.length === 0) candidateIndices = catalog.ecodeIndices;
    }

    // Type-aware filter: parse kpi.value semantik
    // currency: deutsches Format mit Komma+2 Decimals
    // date: dd.mm.yyyy
    // id: 10-12 Ziffern (mit/ohne Leerzeichen)
    const kpiValueType = (v: any): 'currency' | 'date' | 'id' | 'integer' | 'string' => {
      const s = String(v ?? '').trim();
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return 'date';
      if (/^[\d.,€\s-]+,\d{2}\s*€?$/.test(s)) return 'currency';
      if (/^\d+\s*\d+\s*\d+\s*\d+$/.test(s)) return 'id'; // "57 438 590 613"
      if (/^\d{10,12}$/.test(s.replace(/\s/g,''))) return 'id';
      if (/^-?\d+$/.test(s)) return 'integer';
      return 'string';
    };
    const atomCompatible = (atomDatentyp: string | undefined, kpiType: string): boolean => {
      const dt = (atomDatentyp ?? '').toLowerCase();
      if (kpiType === 'currency') return dt === 'currency' || dt === 'integer' || dt === '';
      if (kpiType === 'date') return dt === 'date' || dt === '';
      if (kpiType === 'id') return dt === 'string' || dt === '' || dt === 'integer';
      if (kpiType === 'integer') return dt === 'integer' || dt === 'currency' || dt === '';
      return true; // string passes everything
    };

    // Embed
    const tE0 = Date.now();
    const queries = kpisAll.map(k => formatQuery(
      `${k.belegtyp ?? input.defaultBelegtyp ?? ''}: ${k.key}`.replace(/^:\s*/, ''),
    ));
    const vecs = await embedBatch(queries, { provider: 'vllm' });
    const vecsNorm = vecs.map(v => l2normalize(new Float32Array(v)));
    const embedMs = Date.now() - tE0;

    // Rerank top-K, then Lane-1-Filter
    const tR0 = Date.now();
    const canonical: Record<string, CanonicalEntry> = {};
    const unmatched: KpiToEcodeBridgeOutput['unmatched'] = [];
    let accepted = 0;
    let rejNoHit = 0;
    let rejNotLane1 = 0;
    let acceptedViaBridge = 0;

    for (let i = 0; i < kpisAll.length; i++) {
      const kpi = kpisAll[i];
      const kpiType = kpiValueType(kpi.value);

      // ─── PHASE A: bmf_field exact-Lookup zuerst (deterministisch) ────
      const normKey = normalizeFieldName(kpi.key);
      const directHit = normKey ? bridge.bmfFieldToEcode.get(normKey) : null;
      if (directHit) {
        const ec = directHit.ecode;
        const atomIdx = catalog.atomsRaw.findIndex(a => a.field_name === ec);
        if (atomIdx >= 0) {
          const atom = catalog.atomsRaw[atomIdx];
          const meta = atom.metadata ?? {};
          if (atomCompatible(meta.datentyp, kpiType)) {
            const bridgeInfo = bridge.bridgePrimary.get(ec);
            if (!canonical[ec]) {
              canonical[ec] = {
                ecode: ec,
                anlage: meta.anlage ?? '?',
                drucktext: (meta.drucktext ?? atom.value)?.slice(0, 160) ?? '',
                bmf_field: bridgeInfo?.bmf_field ?? directHit.bmf_field,
                bridge_source: bridgeInfo?.mapping_source ?? 'bmf_field-exact',
                bridge_confidence: bridgeInfo?.confidence ?? directHit.confidence ?? undefined,
                values: [],
              };
            }
            canonical[ec].values.push({
              value: kpi.value,
              source_doc: kpi.doc,
              source_kpi_key: kpi.key,
              score: 1.0,
              rank_in_topk: 0,
              tier: 'bridge-exact',
              via: 'bmf_field-exact',
            });
            accepted++;
            acceptedViaBridge++;
            continue;
          }
        }
      }

      // ─── PHASE B: Polar embedding fallback ───────────────────────────
      const top = catalog.exact.rerank(vecsNorm[i], candidateIndices, topK);
      if (top.length === 0) { rejNoHit++; unmatched.push({ key: kpi.key, value: kpi.value }); continue; }

      // Pick first eCode that:
      //   - Lane-1 wirklich konsumiert (Bridge-Filter)
      //   - typ-kompatibel ist (currency-Wert nicht auf String-eCode)
      let chosen: { idx: number; score: number; rank: number } | null = null;
      for (let r = 0; r < top.length; r++) {
        const cand = top[r];
        if (cand.score < minScore) break;
        const ec = catalog.atomsRaw[cand.idx].field_name;
        const atomDt = catalog.atomsRaw[cand.idx].metadata?.datentyp;
        if (!bridge.lane1Consumable.has(ec)) continue;
        if (!atomCompatible(atomDt, kpiType)) continue;
        chosen = { idx: cand.idx, score: cand.score, rank: r };
        break;
      }

      if (!chosen) {
        rejNotLane1++;
        const t0 = top[0];
        unmatched.push({
          key: kpi.key, value: kpi.value,
          top_polar_ecode: catalog.atomsRaw[t0.idx].field_name,
          top_polar_score: t0.score,
        });
        continue;
      }

      const atom = catalog.atomsRaw[chosen.idx];
      const ec = atom.field_name;
      const meta = atom.metadata ?? {};
      const bridgeInfo = bridge.bridgePrimary.get(ec);
      if (!canonical[ec]) {
        canonical[ec] = {
          ecode: ec,
          anlage: meta.anlage ?? '?',
          drucktext: (meta.drucktext ?? atom.value)?.slice(0, 160) ?? '',
          bmf_field: bridgeInfo?.bmf_field,
          bridge_source: bridgeInfo?.mapping_source,
          bridge_confidence: bridgeInfo?.confidence ?? undefined,
          values: [],
        };
      }
      canonical[ec].values.push({
        value: kpi.value,
        source_doc: kpi.doc,
        source_kpi_key: kpi.key,
        score: chosen.score,
        rank_in_topk: chosen.rank,
        tier: 'bridge-filtered-tier1',
        via: 'polar-embedding',
      });
      accepted++;
    }
    const rerankMs = Date.now() - tR0;

    return {
      canonical_layer: canonical,
      unmatched,
      stats: {
        kpis_in: kpis.length,
        kpis_total_with_ocr_supplement: kpisAll.length,
        kpis_supplemented_from_ocr: ocrKpis.length,
        accepted, rejected: rejNoHit + rejNotLane1,
        rejected_no_polar_hit: rejNoHit,
        rejected_not_lane1: rejNotLane1,
        accepted_via_bridge_exact: acceptedViaBridge,
        accepted_via_polar: accepted - acceptedViaBridge,
        distinct_ecodes: Object.keys(canonical).length,
        embed_ms: embedMs,
        rerank_ms: rerankMs,
        total_ms: Date.now() - t0,
      } as any,
    };
  },
});
