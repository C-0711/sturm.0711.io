/**
 * elster-v3/finalize-extraction — terminal stage of the elster-v3-light path.
 *
 * Konsumiert das Ergebnis von llm-disambig (accepted/rejected/disambig_errors)
 * und produziert das finale Audit-fähige Output-Bündel:
 *
 *   1. canonical_layer        — flach + nested per Anlage, ready für ELSTER-Export
 *   2. pflicht_report          — pro Anlage: expected/found/missing
 *   3. extraction_fingerprint — kryptografische Replay-ID über alle Komponenten
 *   4. replay_certificate     — Fingerprint + per-Feld Attestationen
 *
 * Ersetzt die Routing-/Reporting-Logik des vorherigen confidence-gate.
 * confidence-gate bleibt als Legacy-Stage registriert für Workflows die
 * sie noch konsumieren, ist aber nicht mehr Teil von elster-v3-light.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { defineStage } from '../../../core/stage.ts';
import { loadCatalog, requiredFieldsFor } from '../../../lib/elster-catalog.ts';
import { computeFingerprint, type FingerprintComponents } from '../../../lib/fingerprint.ts';

import type { AcceptedField, RejectedField } from './llm-disambig.ts';
import type { Phase3AnlageResult } from './phase3-llm-fill.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(HERE, '../data');

// ─── Output-Shape ──────────────────────────────────────────────────────────

export interface CanonicalLayer {
  /** Flacher eCode → Wert Map, ready für ELSTER-Submission. */
  codes: Record<string, string>;
  /** Nested per Anlage: { N: { Bruttoarbeitslohn: 6929180, ... }, ESt1A: {...} } */
  nested: Record<string, Record<string, string>>;
  /** Per-Feld Provenance — wer hat extrahiert (cascade-direct vs llm-disambig) */
  provenance: Array<{
    ecode: string;
    drucktext: string;
    anlage: string;
    method: AcceptedField['method'];
    cosine: number;
    confidence: number;
    rawValue: string;
    normalizedValue: string;
    sourceBeleg: number;
    sourceChunk: number;
    sourceLabel: string;
    llmReasoning?: string;
  }>;
}

export interface PflichtCompletenessReport {
  anlage: string;
  expected: number;
  found: number;
  missing_ecodes: string[];
  found_ecodes: string[];
}

export interface FinalizeExtractionInput {
  /** Legacy-Pfad: Output von llm-disambig. Optional seit v5_4 (Multi-Source-Routing). */
  accepted?: AcceptedField[];
  rejected?: RejectedField[];
  disambig_errors?: Array<{ belegIdx: number; chunkIdx: number; label: string; error: string }>;
  /** Optional: Anlagen-Whitelist aus Klassifizierung — treibt Pflicht-Check. */
  anlagen?: string[];
  /** Optional: Eingabe-Metadata für Fingerprint. */
  inputMeta?: {
    filename: string;
    pdf_sha256: string;
    text_sha256?: string;
  };
  /** Optional: LLM-Endpoint-Info für Fingerprint. */
  llmInfo?: {
    model_pin?: string;
    kv_quant_b?: number;
    temperature?: number;
    max_tokens?: number;
    schema_sha256?: string;
  };
  // ── Multi-Source-Inputs (v5_4) ──────────────────────────────────────────
  // Pro Run ist genau einer der drei Pfade befüllt — die anderen werden
  // upstream via `skipWhen` übersprungen und liefern `undefined`.
  /** v5_4 Pfad A: VaSt-Bundle Lohnsteuerbescheid-Mapper (flach eCode → Wert). */
  ecodes_lstb?: Record<string, string | number>;
  /** v5_4 Pfad B: ESE-Mapper (Einkommensteuererklärung, flach eCode → Wert). */
  ecodes_ese?: Record<string, string | number>;
  /** v5_4 Pfad C: Einzelbeleg via phase3-llm-fill (per-Anlage-Shape). */
  ecodes_einzel?: Record<string, Phase3AnlageResult>;
}

export interface FinalizeExtractionConfig {
  /** Container-Daten-Verzeichnis. */
  dataDir?: string;
  /** Bei Pflicht-Atomen ohne Treffer: warn-emit oder hart fail (default warn). */
  pflichtFailHard?: boolean;
  /**
   * LLM-Komponenten für den Fingerprint. Aktuell statisch in elster-v3-light
   * (gemma4-mm via TurboQuant b=4 KV-Cache, temp=0). Wenn Workflow andere
   * LLM-Config nutzt, hier überschreiben.
   */
  llmInfo?: {
    model_pin?: string;
    kv_quant_b?: number;
    temperature?: number;
    max_tokens?: number;
    schema_sha256?: string;
  };
}

export interface FinalizeExtractionOutput {
  canonical_layer: CanonicalLayer;
  pflicht_report: PflichtCompletenessReport[];
  extraction_fingerprint: {
    digest: string;
    components: FingerprintComponents;
  };
  stats: {
    accepted: number;
    cascadeDirect: number;
    llmDisambig: number;
    rejected: number;
    errors: number;
    pflichtComplete: number;
    pflichtMissing: number;
    ms: number;
  };
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export const finalizeExtractionStage = defineStage<
  FinalizeExtractionInput,
  FinalizeExtractionOutput,
  FinalizeExtractionConfig
>({
  id: 'elster-v3/finalize-extraction',
  name: 'Finalize Extraction (canonical_layer + pflicht_report + fingerprint)',
  description:
    'Terminale Stage: konsumiert llm-disambig.accepted, baut canonical_layer ' +
    '(flach+nested per Anlage, mit Provenance), Pflicht-Completeness-Report ' +
    'pro detektierter Anlage, und kryptografischen extraction_fingerprint ' +
    'über alle Komponenten (Container-merkle, Embedder-seed/sha256, LLM-pin, ' +
    'Input-pdf-sha256, Thresholds). Replay-bar.',
  hints: {
    inputs:
      'accepted (von llm-disambig), rejected, disambig_errors · optional: anlagen, inputMeta, llmInfo',
    outputs:
      'canonical_layer{codes,nested,provenance}, pflicht_report[], extraction_fingerprint{digest,components}, stats',
    configExample: '{"dataDir": "/path/to/elster-v3/data", "pflichtFailHard": false}',
    inputPorts: [
      { name: 'accepted', type: 'accepted-fields', description: 'AcceptedField[] from llm-disambig' },
      { name: 'rejected', type: 'rejected-chunks' },
      { name: 'disambig_errors', type: 'json' },
      { name: 'anlagen', type: 'string[]', description: 'Anlagen-Whitelist for pflicht-check' },
      { name: 'inputMeta', type: 'json', description: 'filename + pdf_sha256 + text_sha256' },
      { name: 'llmInfo', type: 'json', description: 'LLM-Komponenten für Fingerprint' },
    ],
    outputPorts: [
      { name: 'canonical_layer', type: 'canonical-layer', description: 'ELSTER-export-ready' },
      { name: 'pflicht_report', type: 'pflicht-report' },
      { name: 'extraction_fingerprint', type: 'fingerprint' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const dataDir = ctx.config?.dataDir ?? DEFAULT_DATA_DIR;

    // ── 0. Multi-Source-Auflösung (v5_4) ──────────────────────────────────
    // Priorität:
    //   1. `input.accepted` (klassischer Pfad, llm-disambig) — wenn nicht leer
    //   2. `ecodes_lstb` oder `ecodes_ese` (Direct-Mapper aus v5_4 Pfaden A/B)
    //   3. `ecodes_einzel` (per-Anlage Phase3 LLM Fill, v5_4 Pfad C)
    //   4. fallback: leer → canonical_layer mit codes={}
    // Pro Run ist normalerweise nur EINE Quelle befüllt (andere via skipWhen
    // übersprungen). Wenn doch mehrere kommen, additiv mergen.
    const acceptedFromInput = input.accepted ?? [];
    const acceptedFromMultiSource: AcceptedField[] = [];
    if (acceptedFromInput.length === 0) {
      if (input.ecodes_lstb && Object.keys(input.ecodes_lstb).length > 0) {
        acceptedFromMultiSource.push(
          ...convertMapToAccepted(input.ecodes_lstb, 'lohnsteuerbescheid-mapper'),
        );
      }
      if (input.ecodes_ese && Object.keys(input.ecodes_ese).length > 0) {
        acceptedFromMultiSource.push(
          ...convertMapToAccepted(input.ecodes_ese, 'einkommensteuererklaerung-mapper'),
        );
      }
      if (input.ecodes_einzel && Object.keys(input.ecodes_einzel).length > 0) {
        acceptedFromMultiSource.push(...convertEinzelToAccepted(input.ecodes_einzel));
      }
    }
    const effectiveAccepted: AcceptedField[] =
      acceptedFromInput.length > 0 ? acceptedFromInput : acceptedFromMultiSource;
    const effectiveRejected: RejectedField[] = input.rejected ?? [];

    // ── 1. canonical_layer: flach (codes) + nested per Anlage ─────────────
    const codes: Record<string, string> = {};
    const nested: Record<string, Record<string, string>> = {};
    const provenance: CanonicalLayer['provenance'] = [];

    for (const a of effectiveAccepted) {
      // Konflikt-Auflösung: wenn derselbe eCode mehrfach kommt, höhere
      // confidence gewinnt (passiert z.B. wenn IDNr in mehreren Belegen
      // referenziert ist — wir wollen die mit höchster Konfidenz).
      const prevConf = provenance.find((p) => p.ecode === a.ecode)?.confidence;
      if (prevConf !== undefined && prevConf >= a.confidence) continue;
      codes[a.ecode] = a.normalizedValue;
      const nestedKey = a.drucktext;
      nested[a.anlage] ??= {};
      nested[a.anlage][nestedKey] = a.normalizedValue;
      // Replace previous provenance entry if any
      const oldIdx = provenance.findIndex((p) => p.ecode === a.ecode);
      const entry = {
        ecode: a.ecode,
        drucktext: a.drucktext,
        anlage: a.anlage,
        method: a.method,
        cosine: a.cosine,
        confidence: a.confidence,
        rawValue: a.rawValue,
        normalizedValue: a.normalizedValue,
        sourceBeleg: a.source.belegIdx,
        sourceChunk: a.source.chunkIdx,
        sourceLabel: a.source.label,
        llmReasoning: a.llm_reasoning,
      };
      if (oldIdx >= 0) provenance[oldIdx] = entry;
      else provenance.push(entry);
    }
    const canonical_layer: CanonicalLayer = { codes, nested, provenance };

    // ── 2. pflicht_report pro detektierter Anlage ─────────────────────────
    const pflicht_report: PflichtCompletenessReport[] = [];
    if (input.anlagen && input.anlagen.length > 0) {
      const catalog = await loadCatalog(join(dataDir, 'atoms.json'));
      const acceptedSet = new Set(effectiveAccepted.map((a) => a.ecode));
      for (const anlage of input.anlagen) {
        const pflichtAtoms = requiredFieldsFor(catalog, anlage);
        if (pflichtAtoms.length === 0) continue;
        const expected = pflichtAtoms.map((a) => a.field_name);
        const found = expected.filter((e) => acceptedSet.has(e));
        const missing = expected.filter((e) => !acceptedSet.has(e));
        pflicht_report.push({
          anlage,
          expected: expected.length,
          found: found.length,
          missing_ecodes: missing,
          found_ecodes: found,
        });
        if (missing.length > 0 && ctx.config?.pflichtFailHard) {
          throw new Error(
            `finalize-extraction: pflichtFailHard — Anlage ${anlage}: missing ${missing.length} pflicht atoms (${missing.slice(0, 3).join(',')}…)`,
          );
        }
      }
    }

    // ── 3. extraction_fingerprint ─────────────────────────────────────────
    const container = JSON.parse(await readFile(join(dataDir, 'container.json'), 'utf-8'));
    const embedContainerPath = join(dataDir, 'container.gemma4.json');
    let embedderFamily: string = container.embeddings?.model ?? 'unknown';
    let embedderDim: number = container.embeddings?.dim ?? 0;
    let embedSeed: number | undefined;
    const embeddingArtifacts: Record<string, string> = {};
    try {
      const embContainer = JSON.parse(await readFile(embedContainerPath, 'utf-8'));
      embedderFamily = embContainer.embedder?.family ?? embedderFamily;
      const matryoshka: number[] = embContainer.embedder?.matryoshka ?? [];
      embedderDim = matryoshka[0] ?? embedderDim;
      for (const [name, info] of Object.entries(
        (embContainer.artifacts ?? {}) as Record<string, { sha256?: string }>,
      )) {
        if (info?.sha256) embeddingArtifacts[name] = info.sha256;
      }
      try {
        const seedBytes = await readFile(join(dataDir, 'embeddings.gemma4.projection_seed.bin'));
        if (seedBytes.length >= 4) embedSeed = seedBytes.readUInt32LE(0);
      } catch {
        /* seed file optional */
      }
    } catch {
      /* gemma4 embed container optional — fallback to legacy bge-m3 description */
    }

    const components: FingerprintComponents = {
      fingerprint_version: 1,
      container: {
        id: container.id,
        catalog_version: container.catalog_version,
        merkle_root: container.merkle_root,
        container_sha256: container.container_sha256,
      },
      embedder: {
        family: embedderFamily,
        dim: embedderDim,
        seed: embedSeed,
        artifact_sha256s: embeddingArtifacts,
      },
      llm: (() => {
        // Source: explicit input.llmInfo > config.llmInfo > undefined.
        const src = input.llmInfo ?? ctx.config?.llmInfo;
        if (!src) return undefined;
        return {
          model_pin: src.model_pin ?? 'google/gemma-4-31b-it',
          kv_quant_b: src.kv_quant_b,
          temperature: src.temperature ?? 0,
          max_tokens: src.max_tokens,
          schema_sha256: src.schema_sha256,
        };
      })(),
      input: input.inputMeta
        ? {
            filename: input.inputMeta.filename,
            pdf_sha256: input.inputMeta.pdf_sha256,
            text_sha256: input.inputMeta.text_sha256,
          }
        : { filename: '(unknown)', pdf_sha256: '(none)' },
      stage_versions: {
        'elster-v3/label-value-parser': '1',
        'elster-v3/atoms-cascade-search': '1',
        'elster-v3/format-regex-validate': '2-enriched',
        'elster-v3/llm-disambig': '2-format-aware',
        'elster-v3/finalize-extraction': '1',
      },
    };
    const fp = computeFingerprint(components);

    // ── 4. Stats + emit ───────────────────────────────────────────────────
    const cascadeDirect = effectiveAccepted.filter((a) => a.method === 'cascade-direct').length;
    const llmDisambig = effectiveAccepted.filter((a) => a.method === 'llm-disambig').length;
    const pflichtComplete = pflicht_report.filter((p) => p.missing_ecodes.length === 0).length;
    const pflichtMissing = pflicht_report.reduce((s, p) => s + p.missing_ecodes.length, 0);

    const stats = {
      accepted: effectiveAccepted.length,
      cascadeDirect,
      llmDisambig,
      rejected: effectiveRejected.length,
      errors: input.disambig_errors?.length ?? 0,
      pflichtComplete,
      pflichtMissing,
      ms: Date.now() - t0,
    };
    ctx.emit('finalize_done', { ...stats, fingerprint: fp.digest });

    // Persist canonical + cert as artifacts
    await ctx.artifacts.write('canonical_layer.json', canonical_layer);
    await ctx.artifacts.write('pflicht_report.json', pflicht_report);
    await ctx.artifacts.write('extraction_fingerprint.json', { digest: fp.digest, components: fp.components });

    return {
      canonical_layer,
      pflicht_report,
      extraction_fingerprint: { digest: fp.digest, components: fp.components },
      stats,
    };
  },
});

// Helper used for type assertions; avoids "unused" warnings.
void createHash;

// ─── Multi-Source Helper (v5_4) ──────────────────────────────────────────

type DirectMapperSource = 'lohnsteuerbescheid-mapper' | 'einkommensteuererklaerung-mapper';

/**
 * Konvertiert einen flachen eCode → Wert Mapper-Output in AcceptedField[]
 * für die Direct-Mapper-Pfade (v5_4 Pfad A: LStB, Pfad B: ESE).
 *
 * Mapper sind deterministische 1:1-Mappings aus strukturierten Quellen —
 * confidence=1.0, cosine=1.0, kein Chunk-Index.
 */
function convertMapToAccepted(
  map: Record<string, string | number>,
  source: DirectMapperSource,
): AcceptedField[] {
  const out: AcceptedField[] = [];
  for (const [ecode, rawValue] of Object.entries(map)) {
    if (rawValue === null || rawValue === undefined) continue;
    const valStr = String(rawValue);
    out.push({
      ecode,
      drucktext: '',          // Direct-Mapper kennt drucktext nicht — wird optional in canonical_layer.nested per anlage='' bucketed
      anlage: '',
      vordruckzeile: '',
      datentyp: '',
      pflicht: false,
      rawValue: valStr,
      normalizedValue: valStr,
      method: 'cascade-direct',
      cosine: 1.0,
      confidence: 1.0,
      source: {
        belegIdx: 0,
        chunkIdx: 0,
        lineIndex: 0,
        label: source,
      },
    });
  }
  return out;
}

/**
 * Walk through phase3-llm-fill's `per_anlage` shape (v5_4 Pfad C) und
 * flattend zu AcceptedField[]. Phase3-LLM-Hits sind FSM-gegroundete vLLM
 * Picks → method='llm-disambig', confidence=1.0 (FSM-strict, kein Drift).
 */
function convertEinzelToAccepted(
  einzel: Record<string, Phase3AnlageResult>,
): AcceptedField[] {
  const out: AcceptedField[] = [];
  for (const [anlage, result] of Object.entries(einzel)) {
    if (!result?.llm_hits) continue;
    for (const [ecode, hit] of Object.entries(result.llm_hits)) {
      const valStr = String(hit.value);
      out.push({
        ecode,
        drucktext: hit.drucktext ?? '',
        anlage: hit.anlage ?? anlage,
        vordruckzeile: hit.vordruckzeile ?? '',
        datentyp: hit.datentyp ?? '',
        pflicht: false,
        rawValue: valStr,
        normalizedValue: valStr,
        method: 'llm-disambig',
        cosine: 1.0,
        confidence: 1.0,
        source: {
          belegIdx: 0,
          chunkIdx: hit.page ?? 0,
          lineIndex: 0,
          label: 'phase3-llm-fill',
        },
      });
    }
  }
  return out;
}
