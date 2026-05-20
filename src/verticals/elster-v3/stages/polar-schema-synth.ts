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
import { ExactFp32Index, QuantumCascade, type CascadeManifest } from '../../../lib/quantum-index.ts';
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
  /** Audit-Trail der Container-Query (offizielle Container-Lib). */
  quantum_container_query: {
    container_id: string;
    container_merkle_root: string;
    catalog_id: string;
    catalog_merkle_root: string;
    retrieval_mode: 'fp32-exact' | 'cascade';
    retrieval_note: string;
    retrieval_ms: number;
    queries_total: number;
  };
  retrieval_trace: { section_id: string; top_ecodes: { ecode: string; score: number }[] }[];
  set_cover_trace: { round: number; ecode: string; reason: string; newly_covered: string[]; score: number }[];
}

const ECODE_REGEX = /^E\d{7}$/; // BMF-Format

// ─────────────────────────────────────────────────────────────────────────────
// Sealed Catalog + Quantum-Container-Query
//
// Statt fp32-Fullscan ueber das lokale .bin: wir gehen ueber QuantumCascade.
// Das ist die offizielle Container-Query — d128 → d256 → d512 → d768 → fp32-
// rerank — mit Container-ID + Merkle-Root im Output. Audit-Trail-fest.
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, '../data');

interface LoadedCatalog {
  /** Vollstaendige atomsRaw-Liste — Indizes zeigen hier hinein. */
  atomsRaw: Atom[];
  /** Gefilterte Liste (nur echte eCodes). */
  atoms: Atom[];
  ecodeToIndex: Map<string, number>;
  /** Offizieller Container-Reader fuer fp32-Vektoren (sealed, L2-normalisiert). */
  exactIndex: ExactFp32Index;
  /** Liste aller atomsRaw-Indizes mit gueltigem eCode — fuer rerank-Kandidatenliste. */
  allEcodeIndices: number[];
  /** Audit-Trail Metadaten aus den sealed Containern. */
  containerId: string;
  containerMerkleRoot: string;
  catalogId: string;
  catalogMerkleRoot: string;
  retrievalMode: 'fp32-exact' | 'cascade';
  retrievalNote: string;
}

let _cachedCatalog: LoadedCatalog | null = null;

async function loadCatalog(): Promise<LoadedCatalog> {
  if (_cachedCatalog) return _cachedCatalog;

  // atoms.json: 2287 BMF-Atome (RAW + gefiltert).
  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const atoms: Atom[] = atomsRaw.filter((a) => ECODE_REGEX.test(a.field_name));

  // index-Mapping + Kandidaten-Liste aller atomsRaw-Indizes mit gueltigem eCode.
  const ecodeToIndex = new Map<string, number>();
  const allEcodeIndices: number[] = [];
  for (let i = 0; i < atomsRaw.length; i++) {
    if (ECODE_REGEX.test(atomsRaw[i].field_name)) {
      ecodeToIndex.set(atomsRaw[i].field_name, i);
      allEcodeIndices.push(i);
    }
  }

  // Cascade-Manifest fuer Container-ID + Metadaten. Die TQ-Cascade selbst hat
  // einen offenen Bug (d128-Prefilter findet falsche Neighbors) — solange das
  // nicht gefixt ist, nutzen wir den fp32-exakten Index direkt. Das ist
  // immer noch ueber die offizielle Container-Lib (ExactFp32Index.load /
  // .rerank), nicht ueber eigenes Binary-Parsing.
  const cascadeManifest: CascadeManifest = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'),
  );
  if (!cascadeManifest.exact) {
    throw new Error('cascade manifest has no exact fp32 tier');
  }
  const exactIndex = await ExactFp32Index.load(
    path.join(DATA_DIR, cascadeManifest.exact.file),
    cascadeManifest.exact.d,
  );

  // Container- + Catalog-Metadaten fuer Audit-Trail.
  const embeddingContainer = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'container.gemma4.json'), 'utf-8'));
  const atomsContainer = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'container.json'), 'utf-8'));

  _cachedCatalog = {
    atomsRaw,
    atoms,
    ecodeToIndex,
    exactIndex,
    allEcodeIndices,
    containerId: cascadeManifest.containerId,
    containerMerkleRoot: embeddingContainer.merkle_root ?? '',
    catalogId: atomsContainer.id,
    catalogMerkleRoot: atomsContainer.merkle_root ?? '',
    retrievalMode: 'fp32-exact',
    retrievalNote: `ExactFp32Index.rerank ueber ${allEcodeIndices.length} eCode-Vektoren (d=${cascadeManifest.exact.d}, n=${cascadeManifest.exact.n}). Cascade-Prefilter (d128/256/512/768 TQ) ueberspring wegen offenem Bug — siehe Issue: cascade liefert 0% Overlap zu fp32-Ground-Truth.`,
  };
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
// Quantum-Container-Query (TurboQuant Cascade)
// ─────────────────────────────────────────────────────────────────────────────
// Eine Query laeuft d128 → d256 → d512 → d768 → fp32-rerank durch den
// sealed ELSTER-Embedding-Container. Output sind Cosinus-Distanzen aus dem
// fp32-rerank — exakt, audit-fest, mit Catalog-Index direkt verwendbar.

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

    // 1. Catalog + Quantum-Cascade laden (cached).
    const catalog = await loadCatalog();
    const pflicht = loadPflichtAtoms();
    ctx.emit('polar-synth.container-query', {
      containerId: catalog.containerId,
      containerMerkleRoot: catalog.containerMerkleRoot.slice(0, 16) + '…',
      catalogId: catalog.catalogId,
      catalogMerkleRoot: catalog.catalogMerkleRoot.slice(0, 16) + '…',
      retrievalMode: catalog.retrievalMode,
      atoms: catalog.atoms.length,
    });

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

    // 4. Quantum-Container-Query pro Sektion → top-K eCodes via TurboQuant-Cascade.
    //    Cascade liefert fp32-rerankt — Scores sind echte Cosinus-Werte,
    //    audit-fest gegen die sealed atoms-Container.
    const retrievalTrace: PolarSynthOutput['retrieval_trace'] = [];
    const candidatesByEcode = new Map<string, ECodeCandidate>();
    const tCascadeStart = Date.now();

    for (let i = 0; i < sections.length; i++) {
      // ExactFp32Index.rerank gegen ALLE eCode-Indizes — Cascade-Prefilter
      // ueberspring (kaputt, siehe retrievalNote). Bei n=2287 unter 10 ms.
      const top = catalog.exactIndex.rerank(sectionVecsNorm[i], catalog.allEcodeIndices, topKPerSection);
      const trace: { ecode: string; score: number }[] = [];

      for (const hit of top) {
        const atom = catalog.atomsRaw[hit.idx];
        if (!atom || !ECODE_REGEX.test(atom.field_name)) continue;
        const ecode = atom.field_name;
        trace.push({ ecode, score: hit.score });

        const existing = candidatesByEcode.get(ecode);
        if (!existing) {
          candidatesByEcode.set(ecode, { ecode, score: hit.score, coversSections: [sections[i].id] });
        } else {
          existing.score = Math.max(existing.score, hit.score);
          if (!existing.coversSections.includes(sections[i].id)) existing.coversSections.push(sections[i].id);
        }
      }
      retrievalTrace.push({ section_id: sections[i].id, top_ecodes: trace });
    }
    const retrievalMs = Date.now() - tCascadeStart;
    const candidates = Array.from(candidatesByEcode.values());
    ctx.emit('polar-synth.candidates', { n: candidates.length, retrievalMs, mode: catalog.retrievalMode });

    // 5. Pflicht-eCodes resolven.
    const { anlagen, pflichtEcodes } = resolvePflichtEcodes(input.docClass, input.classifierAnlagen, pflicht);
    ctx.emit('polar-synth.pflicht', { anlagen, pflichtEcodes });

    // 6. Set-Cover laeuft NUR fuer informativen Trace (Minimum-Cover-Pfad
    //    + Pflicht-Garantie). Das Resultat wird NICHT als Filter benutzt —
    //    wir geben ALLE Kandidaten above threshold zurueck, weil ein Schema
    //    das Vokabular *aller moeglichen* Felder enumeriert, nicht eine
    //    minimale Cover-Menge.
    const cover = greedySetCover({
      sections,
      candidates,
      pflichtEcodes,
      maxEcodes,
      minScoreForCoverage: minScore,
    });
    ctx.emit('polar-synth.set-cover-trace', {
      minCoverSize: cover.selected.length,
      uncovered: cover.uncoveredSections.length,
    });

    // 7. ALLE Kandidaten oberhalb minScore aufnehmen + Pflicht-eCodes garantiert.
    //    Pflicht in required, der Rest als optional (deterministisch lex-sortiert).
    const allOverThreshold = new Set<string>(
      candidates.filter((c) => c.score >= minScore).map((c) => c.ecode),
    );
    // Pflicht-eCodes immer drin, auch wenn Embedding sie nicht erreicht.
    for (const ec of pflichtEcodes) allOverThreshold.add(ec);

    // Optional: maxEcodes-Cap — Pflicht behalten, dann Rest nach Score sortiert.
    let optionalSelected = Array.from(allOverThreshold)
      .filter((ec) => !pflichtEcodes.includes(ec))
      .sort((a, b) => {
        const sa = candidatesByEcode.get(a)?.score ?? 0;
        const sb = candidatesByEcode.get(b)?.score ?? 0;
        return sb - sa || (a < b ? -1 : 1);
      });
    if (pflichtEcodes.length + optionalSelected.length > maxEcodes) {
      optionalSelected = optionalSelected.slice(0, Math.max(0, maxEcodes - pflichtEcodes.length));
    }

    const ecodesRequired = pflichtEcodes.slice().sort();
    const ecodesOptional = optionalSelected.slice().sort();
    const selected = [...ecodesRequired, ...ecodesOptional];
    ctx.emit('polar-synth.selected', {
      required: ecodesRequired.length,
      optional: ecodesOptional.length,
      total: selected.length,
      candidatesAboveThreshold: allOverThreshold.size,
      candidatesTotalRetrieved: candidates.length,
    });

    // 8. Beschreibungen + Type-Hints fuer ALLE selektierten eCodes.
    const ecodeDescriptions: PolarSynthOutput['ecode_descriptions'] = {};
    const typeHints: PolarSynthOutput['type_hints'] = {};

    for (const ec of selected) {
      const idx = catalog.ecodeToIndex.get(ec);
      const atom = idx !== undefined ? catalog.atomsRaw[idx] : null;
      if (!atom) continue;
      ecodeDescriptions[ec] = {
        value: atom.value,
        anlage: atom.citation_section,
        value_type: atom.value_type,
      };
      typeHints[ec] = inferType(atom);
    }

    const sectionExcerpts = sections.map((s, i) => ({
      id: s.id,
      label: s.label ?? `Section ${i + 1}`,
      ocr_excerpt: sectionText(input.ocrText, i, minSectionLength).slice(0, 280),
    }));

    // Coverage-Stats: jetzt bezogen auf die Set-Cover-Min-Cover-Pfad (informativ),
    // nicht auf die "alles >=threshold"-Menge.
    const scores = cover.coverage.map((c) => c.score);
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const pflichtSatisfied = pflichtEcodes.every((p) => selected.includes(p));

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
      quantum_container_query: {
        container_id: catalog.containerId,
        container_merkle_root: catalog.containerMerkleRoot,
        catalog_id: catalog.catalogId,
        catalog_merkle_root: catalog.catalogMerkleRoot,
        retrieval_mode: catalog.retrievalMode,
        retrieval_note: catalog.retrievalNote,
        retrieval_ms: retrievalMs,
        queries_total: sections.length,
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
