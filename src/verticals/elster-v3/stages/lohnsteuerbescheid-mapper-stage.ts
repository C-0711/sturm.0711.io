/**
 * elster-v3/lohnsteuerbescheid-mapper — Stage-Wrapper für die deterministische
 * VaSt-Beleg-Extraktion (Lohnsteuerbescheinigung + Religionszugehörigkeit +
 * Mitteilung freigestellte Kapitalerträge).
 *
 * Konsumiert Output von `elster-v3/label-value-parser` (BelegBlocks mit
 * doc_class + chunks), produziert eine flache eCode-Map.
 *
 * Pipeline-Position:
 *   ocr → label-value-parser → lohnsteuerbescheid-mapper → finalize-extraction
 *
 * Engine: O(1) Zeile-Number-Match → Levenshtein-Ratio-Fallback @ 0.85.
 * Person-A/B-Disambig per Steuer-Identifikationsnummer-Carry-Across.
 */
import { defineStage } from '../../../core/stage.ts';
import { felderFuerAnlage } from '../../../lib/elster-catalog.ts';
import {
  LohnsteuerbescheidMapper,
  type Atom,
  type Chunk,
  type ExtractionResult,
} from './lohnsteuerbescheid-mapper.ts';
import type { BelegBlock, LabelValueChunk } from './label-value-parser.ts';

export interface LStBMapperInput {
  belege: BelegBlock[];
}

export interface LStBMapperConfig {
  /** Levenshtein-Threshold für Fallback-Match. Default 0.85. */
  ratioThreshold?: number;
}

export interface LStBMapperOutput {
  /** eCode → value (cents for currency, raw string for strings). */
  ecodes: ExtractionResult;
  /** How many distinct eCodes were locked. */
  lockCount: number;
  /** Per-beleg counts (transparency for debug). */
  perBeleg: Array<{
    index: number;
    docClass: string;
    chunks: number;
    locksContributed: number;
  }>;
  ms: number;
}

// ─── Container → Atom-Shape adapter ────────────────────────────────────────

async function loadAtomsForLStB(): Promise<Atom[]> {
  // LStB-Mapper liest Anlagen N, VOR, AV
  const out: Atom[] = [];
  for (const anlage of ['N', 'VOR', 'AV', 'ESt1A', 'KAP'] as const) {
    try {
      const liste = await felderFuerAnlage(anlage);
      for (const f of liste.felder) {
        out.push({
          ecode: f.eCode,
          anlage: liste.anlage,
          drucktext: f.drucktext,
          zeile: f.vordruckzeile,
        });
      }
    } catch {
      // anlage may not exist in container — skip
    }
  }
  return out;
}

// ─── Convert LabelValueChunk → Mapper.Chunk ────────────────────────────────

function toMapperChunk(c: LabelValueChunk): Chunk {
  return {
    zeile: c.zeile ?? null,
    label: c.label,
    value: c.value,
  };
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export const lohnsteuerbescheidMapperStage = defineStage<
  LStBMapperInput,
  LStBMapperOutput,
  LStBMapperConfig
>({
  id: 'elster-v3/lohnsteuerbescheid-mapper',
  name: 'Lohnsteuerbescheid-Mapper (VaSt-Belege → eCodes)',
  description:
    'Deterministische eCode-Zuordnung für VaSt-Belege (Lohnsteuerbescheinigung, ' +
    'Religionszugehörigkeit, Mitteilung freigestellte Kapitalerträge). ' +
    'Fast-Path über atom.zeile, Fallback Levenshtein-Ratio gegen drucktext.',
  hints: {
    inputs: 'belege: BelegBlock[] (aus elster-v3/label-value-parser)',
    outputs: 'ecodes: { [ecode]: cents | string }, lockCount, perBeleg[], ms',
    configExample: '{"ratioThreshold": 0.85}',
    inputPorts: [
      { name: 'belege', type: 'belege', description: 'BelegBlocks aus label-value-parser' },
    ],
    outputPorts: [
      { name: 'ecodes', type: 'ecodes', description: 'Flache eCode-Map (cents für currency)' },
      { name: 'lockCount', type: 'number' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const belege = input?.belege ?? [];
    if (belege.length === 0) {
      ctx.logger.warn('lohnsteuerbescheid-mapper: keine Belege im Input');
      return { ecodes: {}, lockCount: 0, perBeleg: [], ms: 0 };
    }

    const threshold = ctx.config?.ratioThreshold ?? 0.85;
    const atoms = await loadAtomsForLStB();
    ctx.logger.info(`Loaded ${atoms.length} LStB-relevant atoms (N/VOR/AV/ESt1A/KAP)`);

    const mapper = new LohnsteuerbescheidMapper(atoms, threshold);
    const perBeleg: LStBMapperOutput['perBeleg'] = [];

    for (const beleg of belege) {
      const before = Object.keys(mapper.extractedData).length;
      const chunks = beleg.chunks.map(toMapperChunk);
      mapper.processBeleg(beleg.doc_class, chunks);
      const after = Object.keys(mapper.extractedData).length;
      perBeleg.push({
        index: beleg.index,
        docClass: beleg.doc_class,
        chunks: beleg.chunks.length,
        locksContributed: after - before,
      });
    }

    const ecodes = mapper.extractedData;
    const lockCount = Object.keys(ecodes).length;
    const ms = Date.now() - t0;

    ctx.emit('lstb_mapper_completed', {
      lockCount,
      belege: belege.length,
      personMapping: mapper.personMapping,
      ms,
    });

    return { ecodes, lockCount, perBeleg, ms };
  },
});
