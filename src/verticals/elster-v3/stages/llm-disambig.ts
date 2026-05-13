/**
 * elster-v3/llm-disambig — Layer-1 LLM-Hop für ambige Cascade-Matches.
 *
 * Sitzt zwischen atoms-cascade-search und der finalen accept-Liste. Routing
 * basierend auf Top-1 Cosine:
 *
 *   cos ≥ acceptCosine  →  direkt akzeptiert (kein LLM-Call)
 *   cos ≥ disambigLo    →  Gemma-4 picks aus Top-K mit strict-JSON
 *   cos <  disambigLo   →  reject (eClearly daneben)
 *
 * Der LLM-Call kennt:
 *   • Beleg-Kontext (doc_class, title) — wer ist der Beleg
 *   • Label + Wert — was steht im Beleg
 *   • Top-K Atom-Kandidaten mit voller Metadata
 *   • Anlagen-Routing-Guidance (ESt1A vs ESt1A_U etc.)
 *   • disambiguation_hints aus dem Container
 *   • Strict json_schema: {picked_ecode, confidence, reasoning}
 *
 * Parallelisierung: alle Disambig-Calls werden über Promise.all gestartet —
 * vLLM continuous-batching macht das günstig (~2s avg pro Call bei TP=2).
 *
 * Output ist im selben Shape wie confidence-gate's AcceptedField, damit
 * canonical-merge unverändert weiterläuft.
 */
import { defineStage } from '../../../core/stage.ts';
import { loadDisambiguationHints } from '../../../lib/elster-catalog.ts';
import { normalizeForElster } from '../../../lib/elster-catalog.ts';

import type { AnnotatedChunk } from './atoms-cascade-search.ts';
import type {
  EnrichedAnnotatedBeleg,
  EnrichedAtomCandidate,
} from './format-regex-validate.ts';

// ─── Stage I/O ───────────────────────────────────────────────────────────

export interface AcceptedField {
  ecode: string;
  drucktext: string;
  anlage: string;
  vordruckzeile: string;
  datentyp: string;
  pflicht: boolean;
  rawValue: string;
  normalizedValue: string;
  /** Methode: 'cascade-direct' oder 'llm-disambig'. */
  method: 'cascade-direct' | 'llm-disambig';
  cosine: number;
  confidence: number;
  /** Optional reasoning from the LLM (nur bei llm-disambig). */
  llm_reasoning?: string;
  source: {
    belegIdx: number;
    chunkIdx: number;
    lineIndex: number;
    label: string;
    zeile?: string;
  };
}

export interface RejectedField {
  belegIdx: number;
  chunkIdx: number;
  label: string;
  rawValue: string;
  reason: string;
  top1Cosine?: number;
}

export interface LlmDisambigInput {
  /**
   * Belege mit format-annotierten Kandidaten (von format-regex-validate).
   * Jeder Kandidat trägt `format_valid` + `normalized_value` + `format_reason`.
   * Der LLM sieht diese Info im Prompt → bessere Picks bei format-konformen vs
   * format-inkompatiblen Atomen.
   */
  belege: EnrichedAnnotatedBeleg[];
  /** Optional disambig hint set, used as additional system context. */
  dokumenttyp_id?: string;
}

export interface LlmDisambigConfig {
  /** Cosine ≥ this → direkt akzeptieren. Default 0.65. */
  acceptCosine?: number;
  /** Cosine ≥ this (und < acceptCosine) → LLM-Hop. Default 0.30. */
  disambigLo?: number;
  /** vLLM endpoint. Default 'http://localhost:11435/v1/chat/completions'. */
  vllmUrl?: string;
  /** Model name (gemma4-mm in production). Default 'gemma4-mm'. */
  model?: string;
  /** Temperature for the disambig call. Default 0 (greedy). */
  temperature?: number;
  /** Max tokens for the JSON response. Default 300. */
  maxTokens?: number;
  /** Max concurrent LLM calls (vLLM batches up to maxNumSeqs internally). Default 16. */
  maxConcurrency?: number;
  /** Soft timeout per call in ms. Default 120000 (120s). */
  perCallTimeoutMs?: number;
}

export interface LlmDisambigOutput {
  accepted: AcceptedField[];
  rejected: RejectedField[];
  /** Disambig-Errors (network / parse / unbekannter eCode in LLM-Output). */
  disambig_errors: Array<{
    belegIdx: number;
    chunkIdx: number;
    label: string;
    error: string;
  }>;
  stats: {
    chunksTotal: number;
    direct: number;
    llmHops: number;
    rejected: number;
    errors: number;
    avgLlmLatencyMs: number;
    totalLlmMs: number;
    totalMs: number;
  };
}

// ─── Prompt-Building ──────────────────────────────────────────────────────

const ANLAGE_GUIDANCE = `=== ANLAGEN-Routing (kritisch — bei Mehrdeutigkeit zwischen Anlagen) ===
- ESt1A     = Steuerpflichtiger STAMMDATEN (Name, Vorname, Geburt, Religion, IDNr, Anschrift)
             Auch: Ehegatten-Stammdaten (deren Name, Vorname, IDNr) im selben Block
- ESt1A_U   = NUR Unterhaltszahlungen an Dritte (§33a Abs.1 EStG, "unterstützte Person")
             NIEMALS für Ehegatten-Stammdaten verwenden
- N         = Anlage N (Arbeitnehmer): Bruttoarbeitslohn, Lohnsteuer, Soli, Kirchensteuer,
             Versorgungsbezüge, Werbungskosten
- VOR       = Vorsorgeaufwand (KV, PV, RV, AV-Beiträge)
- KAP       = Kapitalerträge / Freibeträge
- N_GRE     = Grenzgänger
Wenn Beleg-Label "Ehepartner" oder "Ehegatte" enthält: nimm den ESt1A-Code für
den Ehegatten, NICHT den ESt1A_U Unterhaltscode.`;

interface BuildPromptArgs {
  label: string;
  value: string;
  doc_class: string;
  beleg_title: string;
  candidates: EnrichedAtomCandidate[];
  hints: string[];
}

function buildPrompt({ label, value, doc_class, beleg_title, candidates, hints }: BuildPromptArgs): string {
  const hintsBlock = hints.length > 0 ? hints.map((h) => `  - ${h}`).join('\n') : '  (keine)';
  // Format-aware candidate block: pro Kandidat zeigen wir ob der Wert das
  // ELSTER-formatRegex erfüllt + die normalisierte Form + den BMF-XML-
  // Originalwortlaut + den compact-Typ. Der LLM kann dadurch
  // format-inkompatible Atome verwerfen UND zwischen drucktext-Kollisionen
  // anhand des längeren citation_excerpt (typisch: "Identifikationsnummer
  // des Steuerpflichtigen" vs "Identifikationsnummer der empfangsberechtigten
  // Person") disambiguieren — beides ohne dass das Embedding sie schon
  // unterscheiden muss.
  const candBlock = candidates
    .map((c, i) => {
      const fv = c.format_valid
        ? `format=OK norm="${c.normalized_value}"`
        : `format=FAIL reason="${(c.format_reason ?? '?').slice(0, 40)}"`;
      // formatkennzeichen ist granularer als datentyp:
      //   N=number  C=currency  X=string  D=date  %=percentage  J=Ja/Nein …
      const fk = c.formatkennzeichen ? `fk=${c.formatkennzeichen}` : '';
      // citation_excerpt = BMF-XML-Originalzitat. Oft mehrere Worte länger
      // als drucktext und enthält den Disambig-Kontext (z.B. "des Spenders"
      // vs "des Empfängers"). Auf 120 Zeichen capped um Prompt-Token zu sparen.
      const cit = c.citation_excerpt && c.citation_excerpt !== c.drucktext
        ? `\n        bmf-zitat='${c.citation_excerpt.slice(0, 120).replace(/\n/g, ' ')}'`
        : '';
      return (
        `  [${i + 1}] ${c.ecode}  drucktext='${c.drucktext}'  anlage=${c.anlage}  ` +
        `zeile=${c.vordruckzeile}  datentyp=${c.datentyp}${fk ? ' ' + fk : ''}  ` +
        `cos=${c.score.toFixed(3)}  ${fv}${cit}`
      );
    })
    .join('\n');
  return `Du bist die Layer-1-Disambig-Stage der elster-v3 Pipeline.
Wähle GENAU einen eCode aus der Kandidaten-Liste — der, der semantisch UND
strukturell am besten zum Beleg-Label/-Wert passt.

=== Beleg ===
Klasse:  ${doc_class}
Titel:   ${beleg_title}

=== Label im Beleg ===
Label:   "${label}"
Wert:    "${value}"

${ANLAGE_GUIDANCE}

=== Disambig-Hinweise (aus Container) ===
${hintsBlock}

=== Top-${candidates.length} Atom-Kandidaten (sortiert nach Cosine) ===
${candBlock}

=== Aufgabe ===
Wähle den exakt richtigen eCode aus den Kandidaten. Strategie:
  1. Bei Drucktext-Kollisionen (mehrere Kandidaten mit gleichem 'drucktext'): das
     'bmf-zitat' ist der präzisere BMF-XML-Wortlaut — nutze es als Hauptkriterium.
  2. 'fk' (formatkennzeichen) ist granularer als datentyp: N=number, C=currency,
     X=string, D=date, %=percentage, J=Ja/Nein. Wert-Kompatibilität prüfen.
  3. Wenn keiner wirklich passt (z.B. Label gehört zu einer Anlage die in keinem
     Kandidat vorkommt, oder ist reine Beleg-Metadata ohne eCode-Entsprechung),
     gib null zurück.
  4. Bei mehreren Bescheinigungs-Slots derselben Anlage (E0200201/02/03/04) und
     fehlendem Index-Hinweis im Beleg: nimm den niedrigsten verfügbaren Index.

Antworte als strict JSON: picked_ecode (string oder null), confidence (0..1), reasoning (max 300 Zeichen).`;
}

const DISAMBIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picked_ecode', 'confidence', 'reasoning'],
  properties: {
    picked_ecode: { type: ['string', 'null'] as const },
    confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    reasoning: { type: 'string' as const, maxLength: 300 },
  },
} as const;

// ─── vLLM Call (single) ───────────────────────────────────────────────────

async function callDisambig(
  url: string,
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ picked_ecode: string | null; confidence: number; reasoning: string }> {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'elster_disambig', strict: true, schema: DISAMBIG_SCHEMA },
    },
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  // Forward parent abort.
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`vLLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const j = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    const content = j.choices?.[0]?.message?.content;
    if (!content) throw new Error('vLLM: empty content');
    const parsed = JSON.parse(content) as {
      picked_ecode: string | null;
      confidence: number;
      reasoning: string;
    };
    return parsed;
  } finally {
    clearTimeout(t);
    signal.removeEventListener('abort', onAbort);
  }
}

// ─── pMap mit limitierter Concurrency ─────────────────────────────────────

async function pMap<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── Stage ────────────────────────────────────────────────────────────────

export const llmDisambigStage = defineStage<
  LlmDisambigInput,
  LlmDisambigOutput,
  LlmDisambigConfig
>({
  id: 'elster-v3/llm-disambig',
  name: 'LLM-Disambig (Gemma-4 via vLLM, strict JSON-Schema)',
  description:
    'Layer-1 Disambig-Hop für ambige Cascade-Matches. Cosine ≥ acceptCosine direkt; ' +
    'cosine ≥ disambigLo → Gemma-4 (vLLM) picks aus Top-K Atom-Kandidaten mit ' +
    'strict json_schema; cosine < disambigLo → reject. Parallele Calls via pMap, ' +
    'vLLM continuous-batching macht das günstig.',
  hints: {
    inputs: 'belege[] (von atoms-cascade-search, MIT candidates pro Chunk)',
    outputs: 'accepted[], rejected[], disambig_errors[], stats',
    configExample:
      '{"acceptCosine": 0.65, "disambigLo": 0.30, "model": "gemma4-mm", "maxConcurrency": 16}',
    llm: { providers: ['vllm'], default: 'vllm' },
    inputPorts: [
      { name: 'belege', type: 'belege', description: 'Belege mit Cascade-Top-K' },
      { name: 'dokumenttyp_id', type: 'string', description: 'Aus Klassifizierung' },
    ],
    outputPorts: [
      { name: 'accepted', type: 'accepted-fields' },
      { name: 'rejected', type: 'rejected-chunks' },
      { name: 'stats', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const acceptCosine = ctx.config?.acceptCosine ?? 0.65;
    const disambigLo = ctx.config?.disambigLo ?? 0.30;
    // URL-Priority: stage.config > env VLLM_URL > localhost-default.
    // VLLM_URL aus env reicht aus für Docker-Containers wo localhost im
    // Container nicht der Host ist (host.docker.internal:11435).
    const vllmFromEnv = process.env['VLLM_URL'];
    const vllmUrl = ctx.config?.vllmUrl
      ?? (vllmFromEnv ? `${vllmFromEnv.replace(/\/$/, '')}/v1/chat/completions` : 'http://localhost:11435/v1/chat/completions');
    const model = ctx.config?.model ?? 'gemma4-mm';
    const temperature = ctx.config?.temperature ?? 0;
    const maxTokens = ctx.config?.maxTokens ?? 300;
    const maxConcurrency = ctx.config?.maxConcurrency ?? 16;
    const perCallTimeoutMs = ctx.config?.perCallTimeoutMs ?? 120_000;

    // Disambig-Hinweise einmalig aus Container laden
    const hintsFile = await loadDisambiguationHints();
    const hints: string[] = input.dokumenttyp_id ? hintsFile.hints[input.dokumenttyp_id] ?? [] : [];

    // Triage über alle Chunks: direct / needs-llm / reject
    interface DirectItem {
      belegIdx: number;
      chunkIdx: number;
      chunk: Omit<AnnotatedChunk, 'candidates'> & { candidates: EnrichedAtomCandidate[] };
      winner: EnrichedAtomCandidate;
    }
    interface LlmItem {
      belegIdx: number;
      chunkIdx: number;
      chunk: Omit<AnnotatedChunk, 'candidates'> & { candidates: EnrichedAtomCandidate[] };
      cands: EnrichedAtomCandidate[];
      prompt: string;
    }
    const direct: DirectItem[] = [];
    const needsLlm: LlmItem[] = [];
    const rejected: RejectedField[] = [];

    for (let bi = 0; bi < input.belege.length; bi++) {
      const b = input.belege[bi];
      for (let ci = 0; ci < b.chunks.length; ci++) {
        const chunk = b.chunks[ci];
        const cands = chunk.candidates ?? [];
        if (cands.length === 0) {
          rejected.push({
            belegIdx: bi,
            chunkIdx: ci,
            label: chunk.label,
            rawValue: chunk.value,
            reason: 'no candidates from cascade',
          });
          continue;
        }
        const top1 = cands[0].score;
        // Direct-accept condition: high cosine AND format_valid AND separation.
        // Format-valid heißt: der konkrete Wert passt zu atom.formatRegex —
        // wenn nicht, ist auch ein hoher cosine-Score verdächtig.
        const top1FormatOk = cands[0].format_valid;
        if (top1 >= acceptCosine && top1FormatOk) {
          direct.push({ belegIdx: bi, chunkIdx: ci, chunk, winner: cands[0] });
        } else if (top1 >= disambigLo) {
          const prompt = buildPrompt({
            label: chunk.label,
            value: chunk.value,
            doc_class: (b as { doc_class?: string }).doc_class ?? 'unknown',
            beleg_title: (b as { title?: string }).title ?? '',
            candidates: cands,
            hints,
          });
          needsLlm.push({ belegIdx: bi, chunkIdx: ci, chunk, cands, prompt });
        } else {
          rejected.push({
            belegIdx: bi,
            chunkIdx: ci,
            label: chunk.label,
            rawValue: chunk.value,
            reason: `top1 cosine ${top1.toFixed(3)} < disambigLo ${disambigLo}`,
            top1Cosine: top1,
          });
        }
      }
    }

    ctx.emit('disambig_triage', {
      direct: direct.length,
      needsLlm: needsLlm.length,
      rejected: rejected.length,
    });

    // Direct-accept ausbauen — winner ist EnrichedAtomCandidate, hat normalized_value schon.
    const accepted: AcceptedField[] = direct.map(({ belegIdx, chunkIdx, chunk, winner }) => {
      const normalized =
        winner.normalized_value ??
        (normalizeForElster(chunk.value, winner.datentyp as 'string' | 'date' | 'currency') ?? '');
      return {
        ecode: winner.ecode,
        drucktext: winner.drucktext,
        anlage: winner.anlage,
        vordruckzeile: winner.vordruckzeile,
        datentyp: winner.datentyp,
        pflicht: winner.pflicht,
        rawValue: chunk.value,
        normalizedValue: normalized,
        method: 'cascade-direct',
        cosine: Number(winner.score.toFixed(4)),
        confidence: Number(winner.score.toFixed(4)),
        source: {
          belegIdx,
          chunkIdx,
          lineIndex: chunk.lineIndex,
          label: chunk.label,
          zeile: chunk.zeile,
        },
      };
    });

    // LLM-Hop für needsLlm — parallel via pMap
    const llmStart = Date.now();
    const disambigErrors: LlmDisambigOutput['disambig_errors'] = [];

    const llmResults = await pMap(
      needsLlm,
      async (item) => {
        try {
          const r = await callDisambig(
            vllmUrl,
            model,
            item.prompt,
            temperature,
            maxTokens,
            perCallTimeoutMs,
            ctx.signal,
          );
          return { ok: true as const, item, parsed: r };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false as const, item, error: msg.slice(0, 200) };
        }
      },
      maxConcurrency,
    );
    const totalLlmMs = Date.now() - llmStart;

    for (const r of llmResults) {
      if (!r.ok) {
        disambigErrors.push({
          belegIdx: r.item.belegIdx,
          chunkIdx: r.item.chunkIdx,
          label: r.item.chunk.label,
          error: r.error,
        });
        continue;
      }
      const item = r.item;
      const pickedOrig = r.parsed.picked_ecode;
      if (pickedOrig === null) {
        rejected.push({
          belegIdx: item.belegIdx,
          chunkIdx: item.chunkIdx,
          label: item.chunk.label,
          rawValue: item.chunk.value,
          reason: `LLM said null: ${(r.parsed.reasoning ?? '').slice(0, 120)}`,
          top1Cosine: item.cands[0]?.score,
        });
        continue;
      }
      // ─── Deterministic Bescheinigungs-Slot Normalize ────────────────────
      // Prompt-Strategie 4 sagt "nimm LStB_1" — Gemma folgt aber dem cosine-
      // Bias bei knappen Score-Differenzen (0.309 vs 0.307 = 0.002 reicht).
      // Post-LLM Fix: wenn picked endet auf 02/03/04 UND xxxx01 ist unter
      // den Kandidaten → rebase. Bei Single-Bescheinigung-Belegen ist das
      // immer korrekt; bei Multi-Bescheinigung könnte ein zukünftiger
      // Workflow den Slot-Index aus dem OCR-Kontext mitgeben.
      let picked: string = pickedOrig;
      let slotNorm = false;
      if (picked.startsWith('E') && picked.length === 8) {
        const last2 = picked.slice(-2);
        if (last2 === '02' || last2 === '03' || last2 === '04') {
          const base = picked.slice(0, -2) + '01';
          if (item.cands.some((c) => c.ecode === base)) {
            picked = base;
            slotNorm = true;
          }
        }
      }
      const cand = item.cands.find((c) => c.ecode === picked);
      if (!cand) {
        disambigErrors.push({
          belegIdx: item.belegIdx,
          chunkIdx: item.chunkIdx,
          label: item.chunk.label,
          error: `LLM returned unknown eCode '${pickedOrig}' (not in candidates)`,
        });
        continue;
      }
      // LLM picked one of our enriched candidates — re-use its precomputed normalized_value.
      const normalized =
        cand.normalized_value ??
        (normalizeForElster(item.chunk.value, cand.datentyp as 'string' | 'date' | 'currency') ?? '');
      accepted.push({
        ecode: cand.ecode,
        drucktext: cand.drucktext,
        anlage: cand.anlage,
        vordruckzeile: cand.vordruckzeile,
        datentyp: cand.datentyp,
        pflicht: cand.pflicht,
        rawValue: item.chunk.value,
        normalizedValue: normalized,
        method: 'llm-disambig',
        cosine: Number(cand.score.toFixed(4)),
        confidence: Number(r.parsed.confidence.toFixed(4)),
        llm_reasoning:
          (r.parsed.reasoning ?? '') + (slotNorm ? ` [slot-norm: ${pickedOrig} → ${picked}]` : ''),
        source: {
          belegIdx: item.belegIdx,
          chunkIdx: item.chunkIdx,
          lineIndex: item.chunk.lineIndex,
          label: item.chunk.label,
          zeile: item.chunk.zeile,
        },
      });
    }

    const totalMs = Date.now() - t0;
    const avgLlmLatencyMs = llmResults.length > 0 ? Math.round(totalLlmMs / llmResults.length) : 0;
    const stats = {
      chunksTotal: direct.length + needsLlm.length + rejected.length - disambigErrors.length,
      direct: direct.length,
      llmHops: needsLlm.length,
      rejected: rejected.length,
      errors: disambigErrors.length,
      avgLlmLatencyMs,
      totalLlmMs,
      totalMs,
    };
    ctx.emit('llm_disambig_done', stats);

    return { accepted, rejected, disambig_errors: disambigErrors, stats };
  },
});

// ─── (Helpers entfernt: format-validation passiert jetzt in format-regex-validate)
