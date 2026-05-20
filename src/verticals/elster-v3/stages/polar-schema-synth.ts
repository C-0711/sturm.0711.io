/**
 * Polar-Turbo-Gemma — Schema-Skelett-Synthese fuer neue Belegtypen.
 *
 * Loop: Beleg kommt, kein Schema passt → Skelett wird deterministisch aus
 *   1) OCR-Sektionen + EmbeddingGemma-Vektoren
 *   2) Polar-Cone-Retrieval gegen sealed atoms.json (2287 eCodes)
 *   3) Greedy Set-Cover mit Pflicht-Atom-Forcing
 * gebaut. Downstream nimmt Mistral Small (schema-finisher-mistral) das Skelett
 * und macht daraus ein vollstaendiges nested_schema. Set-Cover-Skelett ist
 * eingefroren — der Finisher darf keine eCodes hinzufuegen oder weglassen.
 *
 * Determinismus: gleiche OCR + gleiche atoms.json → bit-exakt gleiches Skelett.
 * Catalog-Containment: jeder ausgewaehlte eCode existiert per Konstruktion in
 * atoms.json (kein LLM-Halluzinations-Surface).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../../core/stage.ts';
import { embedQueries, l2normalize, EMBEDDINGGEMMA_DIM } from '../../../lib/gemma-embed.ts';
import { greedySetCover, type ECodeCandidate, type SectionRef } from '../lib/set-cover.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Atom {
  atom_id: string;
  field_name: string; // = eCode (z.B. "E2001203")
  value: string; // BMF-Bezeichnung (z.B. "Krankenversicherungsbeitrag")
  citation_section: string; // z.B. "Anlage Vorsorge - Z.11"
  value_type: string;
}

interface PflichtAtomsMap {
  by_anlage: Record<
    string,
    {
      description: string;
      pflicht_ecodes: { ecode: string; bedeutung: string }[];
      optional_typisch?: string[];
    }
  >;
}

interface PolarSynthInput {
  ocrText: string;
  ocrPages?: { index: number; chars: number }[];
  docClass: string;
  classifierAnlagen?: string[]; // aus klassifizierung-stage
  minScore?: number; // default 0.55
  topKPerSection?: number; // default 8
  maxEcodes?: number; // default 30
  minSectionLength?: number; // default 60 chars
}

interface PolarSynthOutput {
  doc_class: string;
  anlage_hints: string[];
  sections: { id: string; label: string; ocr_excerpt: string }[];
  ecodes_required: string[];
  ecodes_optional: string[];
  ecode_descriptions: Record<string, { value: string; anlage: string; value_type: string }>;
  type_hints: Record<string, 'geldbetrag' | 'datum' | 'string' | 'integer' | 'idnr' | 'steuernummer'>;
  coverage_stats: {
    sections_total: number;
    sections_covered: number;
    coverage_ratio: number;
    pflicht_satisfied: boolean;
    average_score: number;
  };
  retrieval_trace: { section_id: string; top_ecodes: { ecode: string; score: number }[] }[];
  set_cover_trace: { round: number; ecode: string; reason: string; newly_covered: string[]; score: number }[];
}

const ECODE_REGEX = /^E\d{7}$/; // BMF-Format

// ─────────────────────────────────────────────────────────────────────────────
// Sealed Catalog Loader
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, '../data');

interface LoadedCatalog {
  atoms: Atom[];
  embeddings: Float32Array[]; // L2-normalisiert
  ecodeToIndex: Map<string, number>;
}

let _cachedCatalog: LoadedCatalog | null = null;

function loadCatalog(): LoadedCatalog {
  if (_cachedCatalog) return _cachedCatalog;

  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8'));
  const atoms: Atom[] = atomsRaw.filter((a: Atom) => ECODE_REGEX.test(a.field_name));

  const fp32Buf = fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.fp32.bin'));
  const f32 = new Float32Array(fp32Buf.buffer, fp32Buf.byteOffset, fp32Buf.byteLength / 4);
  const n = f32.length / EMBEDDINGGEMMA_DIM;
  if (n !== atomsRaw.length) {
    // Manche atoms haben keine eCode (system-rows). Embedding-Bin ist parallel zu atomsRaw,
    // nicht zur gefilterten eCode-Liste. Wir indexen via ursprueglicher Position.
  }

  const embeddings: Float32Array[] = [];
  const ecodeToIndex = new Map<string, number>();
  for (let i = 0; i < atomsRaw.length; i++) {
    if (!ECODE_REGEX.test(atomsRaw[i].field_name)) continue;
    const vec = new Float32Array(f32.buffer, fp32Buf.byteOffset + i * EMBEDDINGGEMMA_DIM * 4, EMBEDDINGGEMMA_DIM);
    const normalized = l2normalize(new Float32Array(vec)); // copy + normalize
    ecodeToIndex.set(atomsRaw[i].field_name, embeddings.length);
    embeddings.push(normalized);
  }

  _cachedCatalog = { atoms, embeddings, ecodeToIndex };
  return _cachedCatalog;
}

function loadPflichtAtoms(): PflichtAtomsMap {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pflicht_atoms.json'), 'utf-8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section-Splitter (v1: paragraph-basiert)
// ─────────────────────────────────────────────────────────────────────────────

function splitIntoSections(ocrText: string, minLen: number): SectionRef[] {
  const blocks = ocrText
    .split(/\n\s*\n/g)
    .map((b) => b.trim())
    .filter((b) => b.length >= minLen);

  const sections: SectionRef[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const head = blocks[i].slice(0, 80).replace(/\s+/g, ' ').trim();
    sections.push({ id: `s${i + 1}`, label: head });
  }
  return sections;
}

function sectionText(ocrText: string, sectionIndex: number, minLen: number): string {
  const blocks = ocrText
    .split(/\n\s*\n/g)
    .map((b) => b.trim())
    .filter((b) => b.length >= minLen);
  return blocks[sectionIndex] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cosine Polar Retrieval
// ─────────────────────────────────────────────────────────────────────────────

function cosineSorted(query: Float32Array, atomEmbeds: Float32Array[], topK: number): { idx: number; score: number }[] {
  const scores: { idx: number; score: number }[] = [];
  for (let j = 0; j < atomEmbeds.length; j++) {
    const a = atomEmbeds[j];
    let dot = 0;
    for (let k = 0; k < query.length; k++) dot += query[k] * a[k];
    scores.push({ idx: j, score: dot });
  }
  scores.sort((a, b) => b.score - a.score || (a.idx - b.idx));
  return scores.slice(0, topK);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typ-Inferenz (deterministisch, regex)
// ─────────────────────────────────────────────────────────────────────────────

function inferType(atom: Atom): PolarSynthOutput['type_hints'][string] {
  const vt = atom.value_type.toLowerCase();
  const val = atom.value.toLowerCase();
  if (vt.includes('integer') || vt.includes('int') || vt.includes('zahl')) return 'integer';
  if (vt.includes('date') || vt.includes('datum')) return 'datum';
  if (vt.includes('euro') || vt.includes('betrag') || vt.includes('decimal') || val.includes('betrag')) return 'geldbetrag';
  if (val.includes('identifikationsnummer') || val.includes('idnr')) return 'idnr';
  if (val.includes('steuernummer')) return 'steuernummer';
  return 'string';
}

// ─────────────────────────────────────────────────────────────────────────────
// Anlage-Detection aus Klassifizierer + Pflicht-Atome-Lookup
// ─────────────────────────────────────────────────────────────────────────────

function resolvePflichtEcodes(
  docClass: string,
  classifierAnlagen: string[] | undefined,
  pflicht: PflichtAtomsMap,
): { anlagen: string[]; pflichtEcodes: string[] } {
  const anlagen = new Set<string>();
  for (const a of classifierAnlagen ?? []) anlagen.add(a);

  // Heuristik: doc_class -> default-Anlagen wenn Klassifizierer nichts liefert
  if (anlagen.size === 0) {
    if (docClass.includes('lohnsteuer') || docClass.includes('versorgung')) anlagen.add('N');
    if (docClass.includes('kapital') || docClass.includes('zinsen') || docClass.includes('aktien')) anlagen.add('KAP');
    if (docClass.includes('kranken') || docClass.includes('pflege') || docClass.includes('vorsorge')) anlagen.add('Vorsatz');
    if (docClass.includes('spende')) anlagen.add('SA');
    if (docClass.includes('haushalt')) anlagen.add('HA_35a');
    if (docClass.includes('rente') || docClass.includes('rentenbezug')) anlagen.add('R');
    if (docClass.includes('hauptvordruck') || docClass.includes('stammdat') || docClass.includes('religion'))
      anlagen.add('ESt1A');
    if (docClass.includes('bescheid')) anlagen.add('Bescheid');
  }

  const pflichtEcodes = new Set<string>();
  for (const a of anlagen) {
    const cfg = pflicht.by_anlage[a];
    if (!cfg) continue;
    for (const p of cfg.pflicht_ecodes) pflichtEcodes.add(p.ecode);
  }
  return { anlagen: Array.from(anlagen).sort(), pflichtEcodes: Array.from(pflichtEcodes).sort() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage Definition
// ─────────────────────────────────────────────────────────────────────────────

export const polarSchemaSynthStage = defineStage<PolarSynthInput, PolarSynthOutput>({
  id: 'elster-v3/polar-schema-synth',
  name: 'Polar-Turbo-Gemma — Schema-Skelett-Synthese',
  description:
    'Deterministische Synthese eines Schema-Skeletts fuer einen unbekannten Belegtyp. ' +
    'Section-Embedding (EmbeddingGemma) + Polar-Cone-Retrieval gegen sealed atoms.json + ' +
    'Greedy-Set-Cover mit Pflicht-Atom-Forcing. Kein LLM in der Schleife — die Halluzinations-' +
    'Surface ist strukturell null. Downstream konsumiert von schema-finisher-mistral.',

  async run(input, ctx) {
    const minScore = input.minScore ?? 0.55;
    const topKPerSection = input.topKPerSection ?? 8;
    const maxEcodes = input.maxEcodes ?? 30;
    const minSectionLength = input.minSectionLength ?? 60;

    ctx.emit('polar-synth.start', { docClass: input.docClass });

    // 1. Catalog laden (cached).
    const catalog = loadCatalog();
    const pflicht = loadPflichtAtoms();
    ctx.emit('polar-synth.catalog-loaded', { atoms: catalog.atoms.length });

    // 2. Sektionen extrahieren.
    const sections = splitIntoSections(input.ocrText, minSectionLength);
    if (sections.length === 0) {
      throw new Error('polar-synth: no sections after split (min length too high or empty OCR)');
    }
    ctx.emit('polar-synth.sections', { n: sections.length });

    // 3. Sections embedden (Query-Format weil wir "suchen" gegen atoms-Dokumente).
    const sectionTexts = sections.map((_, i) => sectionText(input.ocrText, i, minSectionLength));
    const sectionVecs = await embedQueries(sectionTexts);
    const sectionVecsNorm = sectionVecs.map((v) => l2normalize(new Float32Array(v)));
    ctx.emit('polar-synth.embedded-sections', { n: sectionVecsNorm.length });

    // 4. Polar-Cone-Retrieval pro Sektion → top-K eCodes.
    const retrievalTrace: PolarSynthOutput['retrieval_trace'] = [];
    const candidatesByEcode = new Map<string, ECodeCandidate>();

    for (let i = 0; i < sections.length; i++) {
      const top = cosineSorted(sectionVecsNorm[i], catalog.embeddings, topKPerSection);
      const trace = top.map((t) => ({ ecode: catalog.atoms[t.idx].field_name, score: t.score }));
      retrievalTrace.push({ section_id: sections[i].id, top_ecodes: trace });

      for (const t of top) {
        const ecode = catalog.atoms[t.idx].field_name;
        const existing = candidatesByEcode.get(ecode);
        if (!existing) {
          candidatesByEcode.set(ecode, { ecode, score: t.score, coversSections: [sections[i].id] });
        } else {
          // hoechster Score gewinnt; alle covering sections sammeln
          existing.score = Math.max(existing.score, t.score);
          if (!existing.coversSections.includes(sections[i].id)) existing.coversSections.push(sections[i].id);
        }
      }
    }
    const candidates = Array.from(candidatesByEcode.values());
    ctx.emit('polar-synth.candidates', { n: candidates.length });

    // 5. Pflicht-eCodes resolven.
    const { anlagen, pflichtEcodes } = resolvePflichtEcodes(input.docClass, input.classifierAnlagen, pflicht);
    ctx.emit('polar-synth.pflicht', { anlagen, pflichtEcodes });

    // 6. Set-Cover.
    const cover = greedySetCover({
      sections,
      candidates,
      pflichtEcodes,
      maxEcodes,
      minScoreForCoverage: minScore,
    });
    ctx.emit('polar-synth.set-cover', {
      selected: cover.selected.length,
      uncovered: cover.uncoveredSections.length,
    });

    // 7. Output: Skelett mit Metadaten.
    const ecodeDescriptions: PolarSynthOutput['ecode_descriptions'] = {};
    const typeHints: PolarSynthOutput['type_hints'] = {};

    for (const ec of cover.selected) {
      const idx = catalog.ecodeToIndex.get(ec);
      const atom = idx !== undefined ? catalog.atoms[idx] : null;
      if (!atom) continue;
      ecodeDescriptions[ec] = {
        value: atom.value,
        anlage: atom.citation_section,
        value_type: atom.value_type,
      };
      typeHints[ec] = inferType(atom);
    }

    const ecodesRequired = pflichtEcodes.filter((ec) => cover.selected.includes(ec));
    const ecodesOptional = cover.selected.filter((ec) => !ecodesRequired.includes(ec));

    const sectionExcerpts = sections.map((s, i) => ({
      id: s.id,
      label: s.label ?? `Section ${i + 1}`,
      ocr_excerpt: sectionText(input.ocrText, i, minSectionLength).slice(0, 280),
    }));

    const scores = cover.coverage.map((c) => c.score);
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    const pflichtSatisfied = pflichtEcodes.every((p) => cover.selected.includes(p));

    return {
      doc_class: input.docClass,
      anlage_hints: anlagen,
      sections: sectionExcerpts,
      ecodes_required: ecodesRequired,
      ecodes_optional: ecodesOptional,
      ecode_descriptions: ecodeDescriptions,
      type_hints: typeHints,
      coverage_stats: {
        sections_total: sections.length,
        sections_covered: sections.length - cover.uncoveredSections.length,
        coverage_ratio: 1 - cover.uncoveredSections.length / Math.max(sections.length, 1),
        pflicht_satisfied: pflichtSatisfied,
        average_score: Number(avgScore.toFixed(4)),
      },
      retrieval_trace: retrievalTrace,
      set_cover_trace: cover.selectionTrace.map((t) => ({
        round: t.round,
        ecode: t.ecode,
        reason: t.reason,
        newly_covered: t.newlyCovered,
        score: Number(t.score.toFixed(4)),
      })),
    };
  },
});
