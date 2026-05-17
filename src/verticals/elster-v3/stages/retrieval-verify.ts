/**
 * elster-v3/retrieval-verify — post-Layer-1 sanity check.
 *
 * Walks Layer 1's nested JSON, finds every (label-ish key → value, eCode-ish
 * marker) pair, and asks the quantum cascade: "if you searched for this
 * label/value, would the chosen eCode be in your top-K?". Anything Gemma-4
 * extracted that doesn't survive this round-trip is flagged as suspect.
 *
 * The stage is **non-destructive** — it never edits the nested JSON. It
 * produces a `verdaechtigeFelder` array that downstream consumers (or a human reviewer)
 * can act on.
 *
 * Two flagging modes:
 *   1. **eCode-presence**: if the nested JSON carries an explicit `eCode`
 *      field next to a value, verify that eCode is in the cascade's top-K
 *      for the value/label.
 *   2. **label-novelty**: for any leaf label not seen in the catalog at all
 *      (cascade top-1 score below `unbekanntGrenze`), flag — Gemma may have
 *      hallucinated a field for which there is no corresponding eCode.
 *
 * The current Layer-1 nested schemas don't always include eCode (mapping is
 * done in Layer 4). In that case mode (2) is the useful signal.
 */
import { defineStage } from '../../../core/stage.ts';
import { embedQueries, type GemmaEmbedOptions } from '../../../lib/gemma-embed.ts';
import {
  checkFormat,
  normalizeForElster,
  type CatalogAtom,
} from '../../../lib/elster-catalog.ts';
import type { CatalogHandle, RagIndexHandle } from '../../../core/tools/handles.ts';

// Local "CatalogAtom" shape removed — we use the canonical type from
// src/lib/elster-catalog.ts (imported above) which has the full metadata
// (datentyp, formatRegex, pflicht, vordruckzeile, …) needed for the new
// format/datentyp/pflicht validators.

// ─── nested-JSON walker ──────────────────────────────────────────────────

interface Leaf {
  /** Dotted path from the root, e.g. "donations[0].recipient.name". */
  path: string;
  /** The terminal key, e.g. "name". */
  key: string;
  /** The leaf value as a string. */
  value: string;
  /** Optional explicit eCode that was attached to this leaf. */
  eCode?: string;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function walkLeaves(node: unknown, path: string, leaves: Leaf[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkLeaves(v, `${path}[${i}]`, leaves));
    return;
  }
  if (isPlainObject(node)) {
    // Detect attached eCode: a field literally named `eCode` or `eCodeRef`
    // at the same level as the value. Future-proofing for schemas that do
    // carry it explicitly.
    const eCode = typeof node.eCode === 'string' ? node.eCode
      : typeof node.eCodeRef === 'string' ? node.eCodeRef
      : undefined;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'eCode' || k === 'eCodeRef') continue;
      const child = `${path}.${k}`;
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v) || isPlainObject(v)) {
        walkLeaves(v, child, leaves);
      } else {
        leaves.push({
          path: child.replace(/^\./, ''),
          key: k,
          value: String(v),
          eCode,
        });
      }
    }
    return;
  }
  // Primitive at the root (rare) — ignore; no key context.
}

// ─── stage ───────────────────────────────────────────────────────────────

export type VerdachtArt =
  | 'unbekannt'              // top-1 cascade < unbekanntGrenze (kein Catalog-Atom matcht semantisch)
  | 'ecode_abweichung'       // expliziter eCode nicht in cascade top-K für Label/Wert
  | 'niedrige_konfidenz'     // top-1 unter konfidenzGrenze (Graubereich, nur flaggen)
  | 'format_abweichung'      // Wert verletzt das atom.metadata.formatRegex (auch nach Normalisierung)
  | 'datentyp_abweichung'    // Wert lässt sich nicht in das atom.metadata.datentyp coercen
  | 'pflicht_fehlt'          // Pflicht-Atom (pflicht=true) der erwarteten Anlage fehlt im nested JSON
  | 'nicht_in_pass2'         // cascade-top-1-eCode NICHT in Pass-2 erkannte/ergaenzteECodes — möglicherweise von Layer-1 erfunden
  | 'aus_verworfener_anlage'; // cascade-top-1-atom liegt in einer Anlage die Pass-2 explizit verworfen hat

export interface VerdaechtigesFeld {
  path: string;
  key: string;
  value: string;
  markierterECode?: string;
  art: VerdachtArt;
  /** Wenn art ∈ {format_abweichung, datentyp_abweichung}: der Atom-eCode
   *  gegen den validiert wurde (cascade top-1 oder explizit gesetzt). */
  validatedECode?: string;
  /** Wenn art ∈ {format_abweichung, datentyp_abweichung}: was die
   *  Normalisierung produziert hat (kann hilfreich für Reviewer sein). */
  normalisierterWert?: string | null;
  /** Begründung — bei Format-/Datentyp-Abweichung das Regex bzw. der Coerce-Fehler. */
  begruendung?: string;
  /** Best-K candidates from the cascade, for human review. */
  kandidaten: Array<{ atom_id: string; field_name: string; drucktext?: string; anlage?: string; score: number }>;
}

export interface RetrievalVerifyInput {
  /** Nested JSON produced by Layer-1 (or a downstream merge). */
  nested: unknown;
  /** Doc class — currently informational. */
  dokumenttyp_id?: string;
  /**
   * Erwartete Anlagen für diesen Belegtyp (von der Klassifizierungs-Stage).
   * Wenn gesetzt, wird zusätzlich geprüft, welche Pflicht-Atome dieser
   * Anlagen im nested JSON nicht repräsentiert sind → 'pflicht_fehlt'.
   */
  anlagen?: string[];
  /**
   * Output von Pass 2 (anlagen-ermittlung). Wenn gesetzt:
   *   • Cascade-top-1-atom des Leafs MUSS in pass2.erkannte/ergaenzteECodes sein
   *     sonst → 'nicht_in_pass2' (möglicherweise von Layer-1 erfunden).
   *   • Cascade-top-1-atom in einer pass2.verworfeneAnlagen → 'aus_verworfener_anlage'.
   */
  pass2Result?: {
    bestaetigteAnlagen?: string[];
    verworfeneAnlagen?: string[];
    erkannteECodes?: Array<{ eCode: string; belegstelle?: string; konfidenz?: number }>;
    ergaenzteECodes?: Array<{ eCode: string; belegstelle?: string }>;
  };
}

export interface RetrievalVerifyConfig {
  dataDir?: string;
  manifestFile?: string;
  atomsFile?: string;
  /** Cascade top-K used for eCode_mismatch and novelty checks. Default 20. */
  topK?: number;
  /** Top-1 cosine below this → 'novelty' flag (no matching catalog atom).
   *  Default 0.274, calibrated as 0.8 × p5 of known-good top-1 cosines on
   *  tests/groundtruth (see scripts/calibrate-quality-pipeline.ts). */
  unbekanntGrenze?: number;
  /** Top-1 cosine below this → 'low_confidence' flag (gray zone, flag for
   *  review but don't reject). Default 0.400, calibrated as p25 of known-
   *  good top-1 cosines. */
  konfidenzGrenze?: number;
  /** Skip these path-suffixes (boilerplate that's never an eCode). */
  ignorePathSuffixes?: string[];
  /** Min. top-1 cosine to akzeptieren des cascade-Atom für Format-Validierung.
   *  Unter diesem Wert wird Format/Datentyp NICHT geprüft (Atom-Match zu unsicher).
   *  Default = konfidenzGrenze. */
  formatValidiereAbScore?: number;
  /** Pflicht-Vollständigkeit prüfen (braucht input.anlagen). Default true. */
  pflichtVollstaendigkeitPruefen?: boolean;
  embed?: Pick<GemmaEmbedOptions, 'url' | 'model' | 'cpuOnly'>;
}

export interface RetrievalVerifyOutput {
  /** Verdächtige Felder — Eskalation oder Review nötig. */
  verdaechtigeFelder: VerdaechtigesFeld[];
  /** Wie viele Blätter im nested JSON gescannt wurden. */
  geprueftFelder: number;
  /** Pflicht-Atome der erwarteten Anlagen, die NICHT im nested JSON
   *  repräsentiert sind (semantisch gematcht oder explizit zugeordnet). */
  fehlendePflichtFelder: Array<{
    eCode: string;
    anlage: string;
    drucktext: string;
    vordruckzeile: string;
  }>;
  /** Pass-through nested JSON (unchanged). */
  nested: unknown;
  stats: {
    unbekannt: number;
    ecode_abweichung: number;
    niedrige_konfidenz: number;
    format_abweichung: number;
    datentyp_abweichung: number;
    pflicht_fehlt: number;
    nicht_in_pass2: number;
    aus_verworfener_anlage: number;
    embedMs: number;
    retrieveMs: number;
  };
}

const DEFAULT_IGNORE_SUFFIXES = [
  // structural / non-eCode bookkeeping
  '_original', '_resolution', 'kind', 'art', 'currency',
  // dates and ids are not retrievable labels
  'datum', 'date', 'id', 'sequenceNumber', 'lfdNr',
];

function makeQueryText(key: string, value: string): string {
  // Combine key and value so the cascade matches both the field label and
  // the human-readable text. EmbeddingGemma's query prefix is added by
  // embedQueries() — here we just provide the raw search target.
  // We truncate values to 64 chars (a Drucktext is rarely longer).
  return `${key}: ${value.slice(0, 64)}`;
}

export const retrievalVerifyStage = defineStage<
  RetrievalVerifyInput,
  RetrievalVerifyOutput,
  RetrievalVerifyConfig
>({
  id: 'elster-v3/retrieval-verify',
  name: 'Retrieval-verify — flag Layer-1 fields not grounded in catalog',
  description:
    'For every leaf in Layer-1\'s nested JSON, embeds "key: value" via EmbeddingGemma, runs the quantum cascade, and flags leaves whose attached eCode (if any) is not in the cascade top-K, or whose top-1 score is below the novelty/confidence thresholds. Non-destructive — emits a verdaechtigeFelder[] list.',
  hints: {
    inputs: 'nested (Layer-1 JSON) · optional: dokumenttyp_id',
    outputs: 'verdaechtigeFelder[], geprueftFelder, nested (passthrough), stats',
    configExample: JSON.stringify({ topK: 20, konfidenzGrenze: 0.2, unbekanntGrenze: 0.1 }, null, 2),
    acceptsContainers: ['embedding-index'],
    inputPorts: [{ name: 'nested', type: 'nested-json' }, { name: 'dokumenttyp_id', type: 'string' }],
    outputPorts: [
      { name: 'verdaechtigeFelder', type: 'json' },
      { name: 'nested', type: 'nested-json' },
    ],
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    // dataDir/manifestFile/atomsFile config-Felder bleiben für Rückwärtskompat
    // im Schema, werden aber seit P10 nicht mehr gelesen — Anwendung-Tools
    // `elster-rag` und `elster-catalog` liefern Index + Atome.
    const topK = cfg.topK ?? 20;
    const unbekanntGrenze = cfg.unbekanntGrenze ?? 0.274;
    const konfidenzGrenze = cfg.konfidenzGrenze ?? 0.400;
    const formatValidiereAbScore = cfg.formatValidiereAbScore ?? konfidenzGrenze;
    const pflichtPruefen = cfg.pflichtVollstaendigkeitPruefen ?? true;
    const ignoreSuffixes = [...DEFAULT_IGNORE_SUFFIXES, ...(cfg.ignorePathSuffixes ?? [])];
    const embedOpts: GemmaEmbedOptions = { ...(cfg.embed ?? {}), signal: ctx.signal };

    const leaves: Leaf[] = [];
    walkLeaves(input.nested, '', leaves);
    const interesting = leaves.filter((l) =>
      !ignoreSuffixes.some((s) => l.path.endsWith(s) || l.key === s),
    );

    const emptyStats = {
      unbekannt: 0, ecode_abweichung: 0, niedrige_konfidenz: 0,
      format_abweichung: 0, datentyp_abweichung: 0, pflicht_fehlt: 0,
      nicht_in_pass2: 0, aus_verworfener_anlage: 0,
      embedMs: 0, retrieveMs: 0,
    };

    if (interesting.length === 0) {
      return {
        verdaechtigeFelder: [],
        geprueftFelder: 0,
        fehlendePflichtFelder: [],
        nested: input.nested,
        stats: emptyStats,
      };
    }

    // P10: elster-rag + elster-catalog are required:true in the steuerfall-est
    // roster. NullToolContainer throws cleanly if the workflow runs standalone.
    const rag = ctx.tools.get<RagIndexHandle>('elster-rag');
    const cat = ctx.tools.get<CatalogHandle>('elster-catalog');
    const atoms: CatalogAtom[] = cat.get<CatalogAtom[]>('atoms');
    const eCodeToIdx = new Map<string, number>();
    atoms.forEach((a, i) => eCodeToIdx.set(a.field_name, i));

    const queries = interesting.map((l) => makeQueryText(l.key, l.value));
    const tEmb = Date.now();
    const queryVecs = await embedQueries(queries, embedOpts);
    const embedMs = Date.now() - tEmb;

    const tRet = Date.now();
    const verdaechtigeFelder: VerdaechtigesFeld[] = [];
    let unbekannt = 0;
    let abweichung = 0;
    let niedrigeKonf = 0;
    let formatAbweichung = 0;
    let datentypAbweichung = 0;
    let nichtInPass2Count = 0;
    let ausVerworfenerAnlage = 0;

    // Pass-2-Sets vorbereiten (wenn vorhanden) — eCodes die Pass 2 bestätigt
    // oder ergänzt hat, plus die Anlagen die Pass 2 explizit verworfen hat.
    const pass2 = input.pass2Result;
    const pass2BekannteECodes = new Set<string>([
      ...(pass2?.erkannteECodes ?? []).map((e) => e.eCode),
      ...(pass2?.ergaenzteECodes ?? []).map((e) => e.eCode),
    ]);
    const pass2VerworfeneAnlagen = new Set<string>(pass2?.verworfeneAnlagen ?? []);
    const pass2Vorhanden = !!pass2 && (pass2.erkannteECodes ?? []).length + (pass2.ergaenzteECodes ?? []).length > 0;

    // ── Pflicht-Vollständigkeit: welche Pflicht-Atome der Whitelist-Anlagen
    //    werden im nested JSON repräsentiert? Wir matchen über cascade-top-1
    //    (semantische Repräsentation). Bei explizitem eCode wird der direkt
    //    verbucht.
    const erwarteteAnlagen = new Set((input.anlagen ?? []).filter((a) => typeof a === 'string' && a.length > 0));
    const pflichtIdxsExpected = new Set<number>();
    if (pflichtPruefen && erwarteteAnlagen.size > 0) {
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        if (erwarteteAnlagen.has(a.metadata.anlage) && a.metadata.pflicht) {
          pflichtIdxsExpected.add(i);
        }
      }
    }
    const pflichtRepraesentiert = new Set<number>();

    for (let i = 0; i < interesting.length; i++) {
      const leaf = interesting[i];
      const ragHits = await rag.retrieve(Array.from(queryVecs[i]), { topK, signal: ctx.signal });
      const top: Array<{ idx: number; score: number }> = ragHits.map((h) => ({ idx: Number(h.id), score: h.score }));
      const cand = top.map((s) => {
        const a = atoms[s.idx];
        return {
          atom_id: a.atom_id,
          field_name: a.field_name,
          drucktext: a.metadata.drucktext,
          anlage: a.metadata.anlage,
          score: s.score,
        };
      });
      const top1Score = top[0]?.score ?? -Infinity;
      const top1Idx = top[0]?.idx ?? -1;
      const top1Atom: CatalogAtom | undefined = top1Idx >= 0 ? atoms[top1Idx] : undefined;

      // Wenn Pflicht-Check aktiv: Leaf gegen Pflicht-Atome verbuchen.
      if (pflichtPruefen) {
        if (leaf.eCode) {
          const idx = eCodeToIdx.get(leaf.eCode);
          if (idx !== undefined && pflichtIdxsExpected.has(idx)) pflichtRepraesentiert.add(idx);
        }
        if (top1Idx >= 0 && top1Score >= konfidenzGrenze && pflichtIdxsExpected.has(top1Idx)) {
          pflichtRepraesentiert.add(top1Idx);
        }
      }

      // Modus 4 (Pass-2-gating): wenn Pass 2 lief, MUSS das cascade-top-1-atom
      // entweder in den bestätigten/ergänzten eCodes ODER seine Anlage in den
      // bestätigten Anlagen sein. Sonst hat Layer-1 vermutlich erfunden.
      if (pass2Vorhanden && top1Atom) {
        const top1Anlage = top1Atom.metadata.anlage;
        if (pass2VerworfeneAnlagen.has(top1Anlage)) {
          ausVerworfenerAnlage++;
          verdaechtigeFelder.push({
            path: leaf.path, key: leaf.key, value: leaf.value,
            markierterECode: leaf.eCode,
            validatedECode: top1Atom.field_name,
            art: 'aus_verworfener_anlage',
            begruendung: `top-1 cascade-atom ${top1Atom.field_name} liegt in Anlage ${top1Anlage}, die Pass 2 explizit verworfen hat`,
            kandidaten: cand,
          });
          continue;
        }
        // top-1 in Pass-2-bekannten eCodes? Wenn nicht UND top1Score über
        // konfidenzGrenze (sicher genug fürs Matching) → flag.
        if (!pass2BekannteECodes.has(top1Atom.field_name) && top1Score >= konfidenzGrenze) {
          nichtInPass2Count++;
          verdaechtigeFelder.push({
            path: leaf.path, key: leaf.key, value: leaf.value,
            markierterECode: leaf.eCode,
            validatedECode: top1Atom.field_name,
            art: 'nicht_in_pass2',
            begruendung: `cascade-top-1 ${top1Atom.field_name} (cos=${top1Score.toFixed(3)}) wurde von Pass 2 NICHT als im Beleg vorhanden bestätigt`,
            kandidaten: cand,
          });
          continue;
        }
      }

      // Modus 1: eCode-Abweichung
      if (leaf.eCode) {
        const expectedIdx = eCodeToIdx.get(leaf.eCode);
        const hit = expectedIdx !== undefined && top.some((s) => s.idx === expectedIdx);
        if (!hit) {
          abweichung++;
          verdaechtigeFelder.push({
            path: leaf.path, key: leaf.key, value: leaf.value,
            markierterECode: leaf.eCode, art: 'ecode_abweichung', kandidaten: cand,
          });
          continue;
        }
      }

      // Modus 2: unbekannt (kein semantischer Treffer im Catalog)
      if (top1Score < unbekanntGrenze) {
        unbekannt++;
        verdaechtigeFelder.push({
          path: leaf.path, key: leaf.key, value: leaf.value,
          markierterECode: leaf.eCode, art: 'unbekannt', kandidaten: cand,
        });
        continue;
      }

      // Modus 4 + 5: Format-/Datentyp-Validierung gegen das Atom, dem wir
      // dieses Leaf zuordnen — entweder der explizit markierte eCode (falls
      // gesetzt) oder das cascade-top-1-Atom (wenn top1Score über der
      // formatValidiereAbScore-Schwelle liegt; sonst zu unsicher).
      let validatorAtom: CatalogAtom | undefined;
      if (leaf.eCode) {
        const idx = eCodeToIdx.get(leaf.eCode);
        if (idx !== undefined) validatorAtom = atoms[idx];
      } else if (top1Atom && top1Score >= formatValidiereAbScore) {
        validatorAtom = top1Atom;
      }
      if (validatorAtom) {
        const norm = normalizeForElster(leaf.value, validatorAtom.metadata.datentyp);
        if (norm === null) {
          datentypAbweichung++;
          verdaechtigeFelder.push({
            path: leaf.path, key: leaf.key, value: leaf.value,
            markierterECode: leaf.eCode,
            validatedECode: validatorAtom.field_name,
            normalisierterWert: null,
            art: 'datentyp_abweichung',
            begruendung: `Wert "${String(leaf.value).slice(0, 40)}" lässt sich nicht in datentyp=${validatorAtom.metadata.datentyp} coercen`,
            kandidaten: cand,
          });
          continue;
        }
        const fmt = checkFormat(leaf.value, validatorAtom);
        if (!fmt.ok) {
          formatAbweichung++;
          verdaechtigeFelder.push({
            path: leaf.path, key: leaf.key, value: leaf.value,
            markierterECode: leaf.eCode,
            validatedECode: validatorAtom.field_name,
            normalisierterWert: fmt.normalized,
            art: 'format_abweichung',
            begruendung: fmt.reason,
            kandidaten: cand,
          });
          // Format-Abweichung ist gravierender als niedrige Konfidenz —
          // wir flaggen nur das stärkere Signal und gehen zum nächsten Leaf.
          continue;
        }
      }

      // Modus 3: niedrige Konfidenz (Graubereich — flaggen, nicht eskalieren)
      if (top1Score < konfidenzGrenze) {
        niedrigeKonf++;
        verdaechtigeFelder.push({
          path: leaf.path, key: leaf.key, value: leaf.value,
          markierterECode: leaf.eCode, art: 'niedrige_konfidenz', kandidaten: cand,
        });
      }
    }
    const retrieveMs = Date.now() - tRet;

    // ── Pflicht-Vollständigkeit auswerten ─────────────────────────────
    const fehlendePflichtFelder: RetrievalVerifyOutput['fehlendePflichtFelder'] = [];
    let pflichtFehltCount = 0;
    if (pflichtPruefen && pflichtIdxsExpected.size > 0) {
      for (const idx of pflichtIdxsExpected) {
        if (pflichtRepraesentiert.has(idx)) continue;
        const a = atoms[idx];
        fehlendePflichtFelder.push({
          eCode: a.field_name,
          anlage: a.metadata.anlage,
          drucktext: a.metadata.drucktext,
          vordruckzeile: a.metadata.vordruckzeile,
        });
        // Wir flaggen jedes fehlende Pflicht-Atom als verdächtiges "Feld",
        // damit der Reviewer-UI eine einheitliche Liste hat. Path ist
        // synthetisch (kein Leaf), key/value markieren den fehlenden Code.
        verdaechtigeFelder.push({
          path: `__pflicht__/${a.metadata.anlage}/${a.field_name}`,
          key: `pflicht.${a.metadata.anlage}.${a.field_name}`,
          value: '',
          markierterECode: a.field_name,
          validatedECode: a.field_name,
          art: 'pflicht_fehlt',
          begruendung: `Pflicht-Atom Anlage ${a.metadata.anlage} Zeile ${a.metadata.vordruckzeile} (${a.metadata.drucktext}) ist im nested JSON nicht repräsentiert`,
          kandidaten: [],
        });
        pflichtFehltCount++;
      }
    }

    ctx.emit('verify_done', {
      leaves: interesting.length,
      verdaechtigeFelder: verdaechtigeFelder.length,
      unbekannt, ecode_abweichung: abweichung, niedrige_konfidenz: niedrigeKonf,
      format_abweichung: formatAbweichung, datentyp_abweichung: datentypAbweichung,
      pflicht_fehlt: pflichtFehltCount,
      nicht_in_pass2: nichtInPass2Count,
      aus_verworfener_anlage: ausVerworfenerAnlage,
    });
    await ctx.artifacts.write('verdaechtige_felder.json', verdaechtigeFelder);
    if (fehlendePflichtFelder.length > 0) {
      await ctx.artifacts.write('fehlende_pflicht_felder.json', fehlendePflichtFelder);
    }

    return {
      verdaechtigeFelder,
      geprueftFelder: interesting.length,
      fehlendePflichtFelder,
      nested: input.nested,
      stats: {
        unbekannt,
        ecode_abweichung: abweichung,
        niedrige_konfidenz: niedrigeKonf,
        format_abweichung: formatAbweichung,
        datentyp_abweichung: datentypAbweichung,
        pflicht_fehlt: pflichtFehltCount,
        nicht_in_pass2: nichtInPass2Count,
        aus_verworfener_anlage: ausVerworfenerAnlage,
        embedMs,
        retrieveMs,
      },
    };
  },
});
