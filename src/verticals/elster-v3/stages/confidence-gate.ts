/**
 * elster-v3/confidence-gate — routet Verdicts in drei Buckets:
 *
 *   • confidence ≥ acceptThreshold   → ACCEPTED  (direkt ins canonical_layer)
 *   • acceptThreshold > c ≥ disambig → DISAMBIG   (Hop zu LLM-Disambig)
 *   • confidence < disambig          → REJECTED   (ehrliches null)
 *
 * Plus: bei Beleg-Klassen mit nested_schema im Container wird zusätzlich ein
 * Pflicht-Completeness-Report gebaut: "welche pflicht=true eCodes der erkannten
 * Anlagen wurden NICHT gefunden?". Das ist der Vollständigkeits-Gate, der bei
 * VAST-Belegen praktisch immer triggern sollte (Pflicht-Atome sind ja schon
 * vorausgefüllt vom Finanzamt).
 *
 * Output trägt einen `extraction_fingerprint`-Header mit allen Provenance-Daten,
 * der von canonical-merge in das Replay-Cert geschrieben wird.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineStage } from '../../../core/stage.ts';
import { loadCatalog, requiredFieldsFor } from '../../../lib/elster-catalog.ts';
import { computeFingerprint, type FingerprintComponents } from '../../../lib/fingerprint.ts';
import { readFile } from 'node:fs/promises';

import type { ChunkVerdict } from './format-regex-validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(HERE, '../data');

// ─── Gate-Resultate ───────────────────────────────────────────────────────

export interface AcceptedField {
  ecode: string;
  drucktext: string;
  anlage: string;
  vordruckzeile: string;
  datentyp: string;
  pflicht: boolean;
  /** Roh-Wert wie er im Beleg stand. */
  rawValue: string;
  /** ELSTER-normalisierte Form (z.B. "6929180"). */
  normalizedValue: string;
  /** Cosine-Score (range 0..1). */
  cosine: number;
  /** Konsens-Confidence (range 0..1). */
  confidence: number;
  /** Audit-Trace. */
  components: ChunkVerdict['winner'] extends infer W
    ? W extends { components: infer C } ? C : never
    : never;
  /** Provenance: Beleg + Zeile + Label aus dem Original-Text. */
  source: {
    belegIdx: number;
    chunkIdx: number;
    lineIndex: number;
    label: string;
    zeile?: string;
  };
}

export interface DisambigCandidate {
  belegIdx: number;
  chunkIdx: number;
  label: string;
  rawValue: string;
  /** Die K Atom-Kandidaten die der LLM disambiguieren soll. */
  candidate_ecodes: string[];
  /** Maximale Confidence aus dem besten Verdict — zum Sortieren. */
  topConfidence: number;
}

export interface RejectedChunk {
  belegIdx: number;
  chunkIdx: number;
  label: string;
  rawValue: string;
  reason: string;
}

export interface PflichtCompletenessReport {
  anlage: string;
  expected: number;
  found: number;
  /** Pflicht-eCodes die in keiner ACCEPTED-Liste auftauchen. */
  missing_ecodes: string[];
  /** Gefundene Pflicht-eCodes (für Audit-Trail). */
  found_ecodes: string[];
}

// ─── Stage I/O ────────────────────────────────────────────────────────────

export interface ConfidenceGateInput {
  verdicts: ChunkVerdict[];
  /** Optional: Anlagen-Whitelist für Pflicht-Completeness-Check. */
  anlagen?: string[];
  /**
   * Optional: PDF + Filename-Metadata für den Fingerprint-Header. Falls
   * nicht gegeben, wird der Fingerprint ohne input-Sektion gebaut.
   */
  inputMeta?: {
    filename: string;
    pdf_sha256: string;
    text_sha256?: string;
  };
}

export interface ConfidenceGateConfig {
  /** Direkt akzeptieren ab dieser Confidence. Default 0.80. */
  acceptThreshold?: number;
  /** Disambig-Hop ab dieser Confidence. Default 0.40. */
  disambigThreshold?: number;
  /** Anlage-Whitelist auch nutzen um Verdicts auf out-of-anlage zu filtern? Default true. */
  scopeToAnlagen?: boolean;
  /** Container-Daten-Verzeichnis für Pflicht-Lookup. */
  dataDir?: string;
}

export interface ConfidenceGateOutput {
  accepted: AcceptedField[];
  disambig: DisambigCandidate[];
  rejected: RejectedChunk[];
  pflicht_report: PflichtCompletenessReport[];
  /**
   * Vorläufiger Fingerprint (ohne LLM-Komponente). Wenn der Disambig-Hop
   * tatsächlich feuert, fügt canonical-merge die LLM-Sektion nach und
   * berechnet den finalen Digest neu.
   */
  fingerprint_preview: {
    digest: string;
    components: FingerprintComponents;
  };
  stats: {
    accepted: number;
    disambig: number;
    rejected: number;
    pflicht_anlagen: number;
    pflicht_complete: number;
    pflicht_missing: number;
    avgAcceptedConfidence: number;
  };
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export const confidenceGateStage = defineStage<
  ConfidenceGateInput,
  ConfidenceGateOutput,
  ConfidenceGateConfig
>({
  id: 'elster-v3/confidence-gate',
  name: 'Confidence-Gate + Pflicht-Completeness',
  description:
    'Routet Verdicts in {accepted, disambig, rejected} basierend auf Konsens-Confidence. ' +
    'Schwellen kalibriert: ≥0.80 direkt akzeptieren (kein LLM nötig), ≥0.40 zur Disambig. ' +
    'Zusätzlich Pflicht-Completeness-Report pro erkannter Anlage. Liefert ' +
    'fingerprint_preview mit allen Container-/Embedder-/Input-Hashes für Audit.',
  hints: {
    inputs: 'verdicts[] · optional: anlagen[] · optional: inputMeta',
    outputs: 'accepted[], disambig[], rejected[], pflicht_report[], fingerprint_preview',
    configExample: '{"acceptThreshold": 0.80, "disambigThreshold": 0.40, "scopeToAnlagen": true}',
    inputPorts: [
      { name: 'verdicts', type: 'verdicts' },
      { name: 'anlagen', type: 'string[]' },
      { name: 'inputMeta', type: 'json' },
    ],
    outputPorts: [
      { name: 'accepted', type: 'accepted-fields' },
      { name: 'disambig', type: 'disambig-candidates' },
      { name: 'rejected', type: 'rejected-chunks' },
      { name: 'pflicht_report', type: 'pflicht-report' },
      { name: 'fingerprint_preview', type: 'fingerprint' },
    ],
  },

  async run(input, ctx) {
    const accept = ctx.config?.acceptThreshold ?? 0.80;
    const disambig = ctx.config?.disambigThreshold ?? 0.40;
    const scopeToAnlagen = ctx.config?.scopeToAnlagen ?? true;
    const dataDir = ctx.config?.dataDir ?? DEFAULT_DATA_DIR;
    const anlagenSet =
      scopeToAnlagen && input.anlagen && input.anlagen.length > 0
        ? new Set(input.anlagen)
        : null;

    const accepted: AcceptedField[] = [];
    const disambigOut: DisambigCandidate[] = [];
    const rejected: RejectedChunk[] = [];

    for (const v of input.verdicts) {
      if (!v.winner) {
        rejected.push({
          belegIdx: v.belegIdx,
          chunkIdx: v.chunkIdx,
          label: v.label,
          rawValue: v.rawValue,
          reason: v.reject_reason ?? 'no winner',
        });
        continue;
      }
      // Anlage-Filter: wenn Klassifizierung sagt "Anlage N + KAP",
      // dann ein Verdict mit anlage=R verwerfen.
      if (anlagenSet && !anlagenSet.has(v.winner.anlage)) {
        rejected.push({
          belegIdx: v.belegIdx,
          chunkIdx: v.chunkIdx,
          label: v.label,
          rawValue: v.rawValue,
          reason: `out-of-anlage: ${v.winner.anlage} not in [${[...anlagenSet].join(',')}]`,
        });
        continue;
      }

      const c = v.winner.confidence;
      if (c >= accept) {
        accepted.push({
          ecode: v.winner.ecode,
          drucktext: v.winner.drucktext,
          anlage: v.winner.anlage,
          vordruckzeile: v.winner.vordruckzeile,
          datentyp: v.winner.datentyp,
          pflicht: v.winner.pflicht,
          rawValue: v.rawValue,
          normalizedValue: v.winner.normalized,
          cosine: v.winner.cosine,
          confidence: c,
          components: v.winner.components,
          source: {
            belegIdx: v.belegIdx,
            chunkIdx: v.chunkIdx,
            lineIndex: v.lineIndex,
            label: v.label,
            zeile: v.zeile,
          },
        });
      } else if (c >= disambig) {
        // Disambig-Bucket: nimm Top-K eCodes als Kandidaten-Set
        disambigOut.push({
          belegIdx: v.belegIdx,
          chunkIdx: v.chunkIdx,
          label: v.label,
          rawValue: v.rawValue,
          candidate_ecodes: [v.winner.ecode], // Light-Pfad: nur winner. Heavy-Pfad würde alle K vom Cascade-Output behalten.
          topConfidence: c,
        });
      } else {
        rejected.push({
          belegIdx: v.belegIdx,
          chunkIdx: v.chunkIdx,
          label: v.label,
          rawValue: v.rawValue,
          reason: `confidence ${c.toFixed(3)} < disambigThreshold ${disambig}`,
        });
      }
    }

    // ── Pflicht-Completeness pro Anlage ───────────────────────────────────
    const pflicht_report: PflichtCompletenessReport[] = [];
    if (input.anlagen && input.anlagen.length > 0) {
      const catalog = await loadCatalog(join(dataDir, 'atoms.json'));
      const acceptedECodes = new Set(accepted.map((a) => a.ecode));
      for (const anlage of input.anlagen) {
        const pflichtAtoms = requiredFieldsFor(catalog, anlage);
        if (pflichtAtoms.length === 0) continue;
        const expected = pflichtAtoms.map((a) => a.field_name);
        const found = expected.filter((e) => acceptedECodes.has(e));
        const missing = expected.filter((e) => !acceptedECodes.has(e));
        pflicht_report.push({
          anlage,
          expected: expected.length,
          found: found.length,
          missing_ecodes: missing,
          found_ecodes: found,
        });
      }
    }

    // ── Fingerprint-Preview ───────────────────────────────────────────────
    const containerJsonPath = join(dataDir, 'container.json');
    const container = JSON.parse(await readFile(containerJsonPath, 'utf-8'));
    // Embedding-Container (Gemma-quantum)
    const embedContainerJsonPath = join(dataDir, 'container.gemma4.json');
    let embeddingArtifacts: Record<string, string> = {};
    let embedderFamily = container.embeddings?.model ?? 'unknown';
    let embedderDim = container.embeddings?.dim ?? 0;
    let embedSeed: number | undefined;
    try {
      const embContainer = JSON.parse(await readFile(embedContainerJsonPath, 'utf-8'));
      embedderFamily = embContainer.embedder?.family ?? embedderFamily;
      // Native dim is the last matryoshka entry (largest).
      const matryoshka: number[] = embContainer.embedder?.matryoshka ?? [];
      embedderDim = matryoshka[0] ?? embedderDim;
      // sha256 jedes Embedding-Artefakts:
      for (const [name, info] of Object.entries(
        (embContainer.artifacts ?? {}) as Record<string, { sha256?: string }>,
      )) {
        if (info?.sha256) embeddingArtifacts[name] = info.sha256;
      }
      // Seed-Datei lesen (4 bytes uint32 LE)
      try {
        const seedBytes = await readFile(join(dataDir, 'embeddings.gemma4.projection_seed.bin'));
        if (seedBytes.length >= 4) embedSeed = seedBytes.readUInt32LE(0);
      } catch { /* seed file optional */ }
    } catch { /* gemma4 embed container optional */ }

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
        'elster-v3/format-regex-validate': '1',
        'elster-v3/confidence-gate': '1',
      },
    };
    const fpFull = computeFingerprint(components);

    // ── Stats ─────────────────────────────────────────────────────────────
    const acceptedAvg = accepted.length > 0
      ? accepted.reduce((s, a) => s + a.confidence, 0) / accepted.length
      : 0;
    const pflichtComplete = pflicht_report.filter((p) => p.missing_ecodes.length === 0).length;
    const pflichtMissing = pflicht_report.reduce((s, p) => s + p.missing_ecodes.length, 0);

    const stats = {
      accepted: accepted.length,
      disambig: disambigOut.length,
      rejected: rejected.length,
      pflicht_anlagen: pflicht_report.length,
      pflicht_complete: pflichtComplete,
      pflicht_missing: pflichtMissing,
      avgAcceptedConfidence: Number(acceptedAvg.toFixed(4)),
    };
    ctx.emit('confidence_gate_done', stats);

    return {
      accepted,
      disambig: disambigOut,
      rejected,
      pflicht_report,
      fingerprint_preview: {
        digest: fpFull.digest,
        components: fpFull.components,
      },
      stats,
    };
  },
});
