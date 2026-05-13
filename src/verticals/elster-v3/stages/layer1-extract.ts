/**
 * elster-v3 Layer 1 — strict json_schema nested extraction via vLLM Gemma-4.
 *
 * Reads OCR text + (optional) classifier KPI hints + the doc-class-specific
 * nested JSON schema, then asks Gemma-4 to fill it. vLLM's response_format
 * json_schema mode constrains the FSM token-by-token so the output is
 * guaranteed to match the schema (no post-hoc parsing/cleanup).
 *
 * Output: nested JSON (donations[], donor, employer, income, ...).
 * Subsequent stages: layer2-resolve (entity normalization) → layer4-project.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../../lib/llm-chat.ts';
import {
  paragraphFuer,
  loadContainerBrief,
  disambiguationHinweiseFuer,
  type EinkunftsartCode,
} from '../../../lib/elster-catalog.ts';
import {
  computePromptBudget,
  contextTokensFor,
  assertFitsInBudget,
  PromptBudgetExceededError,
} from '../../../lib/prompt-budget.ts';
import { findDokumenttypFuerAnlagen } from '../../../workflows/steuerbelege/lib/typen-katalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, '..', 'data', 'nested_schemas');

export interface Layer1Input {
  /** OCR markdown from the mistral-ocr stage. */
  text: string;
  /** Doc class id from the dokument-typ stage (e.g. "lohnsteuerbescheinigung"). */
  dokumenttyp_id: string;
  /**
   * Optional KPI hints (key:value pairs from a classifier upstream).
   * The workspace pipeline produces these via Mistral classification —
   * if present they massively speed up + harden Gemma's extraction.
   */
  kpis?: Array<{ key: string; value: unknown }>;
  /**
   * Optional candidate eCodes from quantum-ground. Full container metadata
   * (anlage, datentyp, pflicht, vordruckzeile, formatRegex, ...) is threaded
   * through so the prompt can be **fully container-driven** — no hardcoded
   * field tables in code. Layer-1's prompt section is generated from these
   * atoms at runtime, with the catalog as single source of truth.
   */
  kandidatenECodes?: Array<{
    field_name: string;
    anlage?: string;
    datentyp?: 'string' | 'date' | 'currency';
    pflicht?: boolean;
    vordruckzeile?: string;
    drucktext?: string;
    bezeichnung?: string;
    formatRegex?: string;
    einkunftsart?: EinkunftsartCode | null;
    quelle?: 'scaffold' | 'cascade' | 'out_of_anlage';
    aggregatedScore?: number;
  }>;
  /**
   * §EStG-Einkunftsarten aus dem Container abgeleitet (von quantum-ground
   * über die kontextPaths der Kandidaten). Wird oben in den Layer-1-Prompt
   * als Rahmen geschrieben — z.B. "Dieser Beleg betrifft §19 Arbeitslohn".
   */
  einkunftsarten?: EinkunftsartCode[];
  /**
   * Anlagen-Whitelist von der Klassifizierungs-Stage. Wenn vorhanden, wird
   * sie im Prompt-Frame als "Erwartete Anlagen" vermerkt.
   */
  anlagen?: string[];
  /**
   * Output von Pass 2 (elster-v3/anlagen-ermittlung). Wenn gesetzt, wird
   * die `erkannteECodes`-Liste mit Belegstellen als "PASS-2 BESTÄTIGT"-Block
   * VOR den breiteren Kandidaten in den Prompt geschrieben — Layer 1 weiß
   * damit welche eCodes definitiv im Beleg sind und wo (Beleg-Span).
   */
  pass2Result?: {
    bestaetigteAnlagen?: string[];
    ergaenzteAnlagen?: string[];
    verworfeneAnlagen?: string[];
    erkannteECodes?: Array<{
      eCode: string;
      belegstelle: string;
      konfidenz: number;
      anlage?: string;
    }>;
    ergaenzteECodes?: Array<{
      eCode: string;
      belegstelle: string;
      grund: string;
      anlage?: string;
    }>;
  };
}

export interface Layer1Output {
  nested: unknown;
  schemaName: string;
  schemaId: string;
  llmMs: number;
  ms: number;
}

export interface Layer1Config {
  /** Which LLM to call. Default 'vllm' (Gemma-4 on H200V). For consensus
   *  pipelines use compare/fanout with two layer1 instances — one 'vllm',
   *  one 'mistral' — and compare/merge policy='vote'. */
  provider?: ChatProvider;
  /** vLLM URL — defaults to env VLLM_URL or http://localhost:11435. */
  vllmUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Cap on kandidatenECodes lines injected into prompt. Default 50. */
  maxKandidatenECodes?: number;
}

// Disambiguations-Hints liegen jetzt im Container unter
// src/verticals/elster-v3/data/disambiguation_hints.json — nicht mehr im Code.
// Geladen via disambiguationHinweiseFuer() in elster-catalog.ts.

/**
 * Group candidate eCodes by Anlage and format into a container-grounded
 * prompt section. Every line is generated from atom metadata — no
 * hand-maintained mirror of the catalog.
 */
function formatiereKandidatenNachAnlage(
  kandidaten: NonNullable<Layer1Input['kandidatenECodes']>,
  cap: number,
): string {
  if (kandidaten.length === 0) return '';
  // Gruppieren unter Beibehaltung der Rangfolge innerhalb jeder Anlage.
  const groups = new Map<string, typeof kandidaten>();
  for (const c of kandidaten.slice(0, cap)) {
    const a = c.anlage ?? '(?)';
    const list = groups.get(a) ?? [];
    list.push(c);
    groups.set(a, list);
  }
  const blocks: string[] = [];
  for (const [anlage, items] of groups) {
    blocks.push(`Anlage ${anlage}:`);
    for (const c of items) {
      // ECODE [Zeile N, datentyp, pflicht?, quelle?]  drucktext
      const pflicht = c.pflicht === true ? '·PFLICHT' : '';
      const zeile = c.vordruckzeile ? `Z${c.vordruckzeile}` : '';
      const dt = c.datentyp ? `·${c.datentyp}` : '';
      // Scaffold-Atome kennzeichnen: Layer-1 weiß dann, dass diese aus dem
      // Anlagen-Pflicht-Gerüst kommen (nicht aus dem Embedding-Match).
      const quelle = c.quelle === 'scaffold' ? '·gerüst' : '';
      const meta = [zeile, dt, pflicht, quelle].filter(Boolean).join(' ');
      const label = (c.drucktext ?? c.bezeichnung ?? '').slice(0, 90);
      blocks.push(`  ${c.field_name} [${meta}]  ${label}`);
    }
  }
  return blocks.join('\n');
}

/**
 * Baut den §EStG-Einkunftsarten-Rahmen für den Layer-1-Prompt aus der
 * Klassifizierungs-/quantum-ground-Ausgabe. Lädt §EStG-Klartextzitate aus
 * dem Container (paragraph_estg.json) — keine hardcoded Tabelle.
 */
async function formatiereEinkunftsartenRahmen(
  einkunftsarten: EinkunftsartCode[] | undefined,
  anlagen: string[] | undefined,
): Promise<string> {
  const lines: string[] = [];
  if (anlagen && anlagen.length > 0) {
    lines.push(`Erwartete ELSTER-Anlagen: ${anlagen.join(', ')}`);
  }
  if (einkunftsarten && einkunftsarten.length > 0) {
    lines.push('Einkunftsarten / Aufwandsblöcke (BMF-Vokabular → §EStG):');
    for (const e of einkunftsarten) {
      const zitat = await paragraphFuer(e);
      lines.push(`  • ${e.padEnd(24)} ${zitat}`);
    }
  }
  return lines.join('\n');
}

/** Map dokument-typ ids (output of klassifizierung stage) to schema filenames. */
function resolveSchemaName(dokumenttyp_id: string): string {
  // Lohnsteuerbescheinigung family
  if (dokumenttyp_id === 'pension_versorgung') return 'lohnsteuerbescheinigung';
  if (dokumenttyp_id === 'lohnsteuerbescheinigung_kapital') return 'lohnsteuerbescheinigung';
  if (dokumenttyp_id === 'lohnsteuerbescheinigung_aktiv') return 'lohnsteuerbescheinigung';

  // Rentenbezug
  if (dokumenttyp_id === 'rentenbezug') return 'rentenbezugsmitteilung';
  if (dokumenttyp_id === 'rentenbezugsmitteilung') return 'rentenbezugsmitteilung';

  // Spendenquittung
  if (dokumenttyp_id === 'spendenquittung') return 'spendenquittung';
  if (dokumenttyp_id === 'spende') return 'spendenquittung';
  if (dokumenttyp_id === 'mitgliedsbeitrag') return 'spendenquittung';

  // Religionszugehörigkeit (VaSt-Auszug)
  if (dokumenttyp_id === 'religionszugehoerigkeit') return 'religionszugehoerigkeit';
  if (dokumenttyp_id === 'religion') return 'religionszugehoerigkeit';
  if (dokumenttyp_id === 'kirchensteuermerkmal') return 'religionszugehoerigkeit';

  // Mitteilung über freigestellte Kapitalerträge (VaSt, nur Freistellungs-Betrag)
  if (dokumenttyp_id === 'mitteilung_kapitalertraege') return 'mitteilung_kapitalertraege';
  if (dokumenttyp_id === 'kapitalertragsbescheinigung') return 'mitteilung_kapitalertraege';
  if (dokumenttyp_id === 'freistellungsauftrag') return 'mitteilung_kapitalertraege';
  if (dokumenttyp_id === 'mitteilung_freigestellte_kapitalertraege') return 'mitteilung_kapitalertraege';

  // Steuerbescheinigung Kapitalerträge (volle Bankbescheinigung mit KapESt + SolZ + KiSt)
  if (dokumenttyp_id === 'steuerbescheinigung_kapitalertraege') return 'steuerbescheinigung_kapitalertraege';
  if (dokumenttyp_id === 'steuerbescheinigung_kapitalertr') return 'steuerbescheinigung_kapitalertraege';
  if (dokumenttyp_id === 'jahressteuerbescheinigung') return 'steuerbescheinigung_kapitalertraege';
  if (dokumenttyp_id === 'kapitalertrag_jahressteuerbescheinigung') return 'steuerbescheinigung_kapitalertraege';

  // ESt1A Hauptvordruck (Stammdaten + Adresse + Bankverbindung)
  if (dokumenttyp_id === 'personaldaten_hauptvordruck') return 'personaldaten_hauptvordruck';
  if (dokumenttyp_id === 'elster_einkommensteuererkl_2023') return 'personaldaten_hauptvordruck';
  if (dokumenttyp_id === 'elster_einkommensteuererkl') return 'personaldaten_hauptvordruck';
  if (dokumenttyp_id === 'est1a_hauptvordruck') return 'personaldaten_hauptvordruck';
  if (dokumenttyp_id === 'hauptvordruck') return 'personaldaten_hauptvordruck';

  return dokumenttyp_id;
}

export const layer1ExtractStage = defineStage<Layer1Input, Layer1Output, Layer1Config>({
  id: 'elster-v3/layer1-extract',
  name: 'ELSTER-v3 Layer 1 — Gemma-4 strict json_schema nested extraction',
  description:
    'Picks the doc-class nested JSON schema, builds a guidance prompt with optional KPI ' +
    'hints, and calls vLLM Gemma-4 with response_format=json_schema(strict). The FSM-' +
    'constrained decoding guarantees the output JSON conforms to the schema — no post-hoc ' +
    'parsing/cleanup. Produces the canonical nested JSON consumed by Layers 2-4.',
  hints: {
    inputs: 'text (OCR markdown), dokumenttyp_id (klassifizierung typ_id) · optional: kpis[], kandidatenECodes[]',
    outputs: 'nested (schema-conformant JSON), schemaName, schemaId, llmMs, ms',
    configExample: '{"provider":"vllm","model":"gemma4-mm","temperature":0,"maxTokens":2000,"maxKandidatenECodes":50}',
    llm: { providers: ['vllm', 'mistral'], default: 'vllm' },
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'text', type: 'text', description: 'OCR markdown from upstream' },
      { name: 'dokumenttyp_id', type: 'string', description: 'Klassifizierungs-typ_id' },
      { name: 'kpis', type: 'json', description: 'Optional KPI hints' },
      { name: 'kandidatenECodes', type: 'candidates', description: 'Optional retrieval-grounded eCode shortlist' },
    ],
    outputPorts: [
      { name: 'nested', type: 'nested-json', description: 'Schema-conformant extraction' },
      { name: 'schemaName', type: 'string' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    // Pass-2-Fallback: wenn Pass 1 (klassifizierung) versagt hat
    // (dokumenttyp_id=null/"null"/leer), versuchen wir aus Pass-2's
    // bestaetigteAnlagen via dokumenttypen.json den passenden Typ
    // abzuleiten. Pass 2 ist Container-grounded und sieht den eigentlichen
    // Beleg-Inhalt — bei Multi-Doc-Bundles ist das oft präziser als die
    // Mistral-Small-Regex-Heuristik.
    let effectiveTypId = input.dokumenttyp_id;
    const typIdLeer = !effectiveTypId || effectiveTypId === 'null' || effectiveTypId === 'undefined';
    if (typIdLeer && input.pass2Result?.bestaetigteAnlagen?.length) {
      const derived = await findDokumenttypFuerAnlagen(input.pass2Result.bestaetigteAnlagen);
      if (derived) {
        effectiveTypId = derived.id;
        ctx.emit('layer1_typ_id_derived_from_pass2', {
          original: input.dokumenttyp_id,
          derived: derived.id,
          quelle: 'pass2.bestaetigteAnlagen',
          anlagen: input.pass2Result.bestaetigteAnlagen,
        });
      }
    }
    const schemaName = resolveSchemaName(effectiveTypId ?? '');
    let schemaJson: { name: string; schema: Record<string, unknown> };
    try {
      schemaJson = JSON.parse(await readFile(join(SCHEMAS_DIR, `${schemaName}.json`), 'utf-8'));
    } catch (err) {
      throw new Error(
        `elster-v3/layer1-extract: no nested schema for dokumenttyp_id="${effectiveTypId}" ` +
        `(original="${input.dokumenttyp_id}", looked for ${schemaName}.json). ` +
        `Pass-2 bestaetigteAnlagen: ${JSON.stringify(input.pass2Result?.bestaetigteAnlagen ?? [])}. ` +
        `${(err as Error).message}`,
      );
    }
    const fieldHints = (input.kpis ?? [])
      .filter((k) => k.key && k.value !== null && k.value !== undefined && k.value !== '')
      .map((k) => `  ${k.key}: ${k.value}`)
      .join('\n');
    // Disambiguation aus dem Container — nicht aus dem Code.
    const disambiguationCandidates = await Promise.all([
      disambiguationHinweiseFuer(effectiveTypId ?? ''),
      disambiguationHinweiseFuer(schemaName),
    ]);
    const disambiguation = disambiguationCandidates[0].length > 0
      ? disambiguationCandidates[0]
      : disambiguationCandidates[1];
    const maxKand = ctx.config.maxKandidatenECodes ?? 50;
    const kandidatenBlock = formatiereKandidatenNachAnlage(input.kandidatenECodes ?? [], maxKand);
    const hatKandidaten = kandidatenBlock.length > 0;
    const rahmenBlock = await formatiereEinkunftsartenRahmen(input.einkunftsarten, input.anlagen);
    const hatRahmen = rahmenBlock.length > 0;
    // CONTAINER_BRIEF.md ist der erste Block im Prompt — der LLM lernt
    // damit die Atom-Schema-Konventionen vor jeder Extraktion.
    const containerBrief = await loadContainerBrief();
    // Pass-2-Bestätigungs-Block (optional): konkrete eCodes mit Belegstellen.
    const pass2 = input.pass2Result;
    const pass2Lines: string[] = [];
    if (pass2) {
      if (pass2.bestaetigteAnlagen && pass2.bestaetigteAnlagen.length > 0) {
        pass2Lines.push(`Bestätigte Anlagen (im Beleg gefunden): ${pass2.bestaetigteAnlagen.join(', ')}`);
      }
      if (pass2.verworfeneAnlagen && pass2.verworfeneAnlagen.length > 0) {
        pass2Lines.push(`Verworfene Anlagen (Pass-1-Hypothese OHNE Beleg): ${pass2.verworfeneAnlagen.join(', ')} — IGNORIERE eCodes aus diesen Anlagen.`);
      }
      const allErkannte = [
        ...(pass2.erkannteECodes ?? []).map((e) => ({ ...e, ergaenzt: false, grund: '' })),
        ...(pass2.ergaenzteECodes ?? []).map((e) => ({
          eCode: e.eCode,
          belegstelle: e.belegstelle,
          konfidenz: 0.7,
          anlage: e.anlage,
          ergaenzt: true,
          grund: e.grund,
        })),
      ];
      if (allErkannte.length > 0) {
        pass2Lines.push('');
        pass2Lines.push('eCodes mit Belegstelle (Pass-2 Container-grounded Vorab-Analyse):');
        for (const e of allErkannte) {
          const tag = e.ergaenzt ? '+' : '✓';
          const an = e.anlage ? ` [${e.anlage}]` : '';
          const konf = `k=${e.konfidenz.toFixed(2)}`;
          pass2Lines.push(`  ${tag} ${e.eCode}${an} ${konf}  ⟪${e.belegstelle.slice(0, 100)}⟫`);
        }
        pass2Lines.push('');
        pass2Lines.push('(✓ = aus Pass-1-Kandidaten bestätigt; + = ergänzt, war nicht in Kandidaten)');
      }
    }
    const pass2Block = pass2Lines.join('\n');
    const hatPass2 = pass2Block.length > 0;

    // ── Dynamisches OCR-Char-Budget ─────────────────────────────────
    // Overhead-Schätzung aus den schon-fertigen Blöcken: jeder bekommt
    // grob length/3.5 als Token-Schätzung. Plus 500 Tokens Headline/System.
    const provider: ChatProvider = ctx.config.provider ?? 'vllm';
    const defaultModelByProvider: Record<ChatProvider, string> = {
      vllm: 'gemma4-mm',
      mistral: 'mistral-large-latest',
      ollama: 'gemma4:31b-128k',
    };
    const modelName = ctx.config.model ?? defaultModelByProvider[provider];
    const overheadChars = rahmenBlock.length + kandidatenBlock.length
      + containerBrief.length
      + pass2Block.length
      + disambiguation.join('\n').length
      + 500; // headline + KPI hints + system boilerplate
    const budget = computePromptBudget({
      modelContextTokens: contextTokensFor(modelName),
      schema: schemaJson.schema,
      maxOutputTokens: ctx.config.maxTokens ?? 2000,
      overheadTokens: Math.ceil(overheadChars / 3.5),
    });
    // Policy: KEIN silent truncation. Wenn OCR > Budget → fehler werfen.
    // Workflow muss auto-source-split + compare/fanout dazwischenschalten.
    try {
      assertFitsInBudget(input.text, budget);
    } catch (err) {
      if (err instanceof PromptBudgetExceededError) {
        ctx.emit('layer1_source_budget_exceeded', {
          model: modelName,
          originalChars: err.textLen,
          budgetChars: err.budgetChars,
          budgetBreakdown: budget.breakdown,
          hint: 'Splitte den OCR-Text via auto-source-split (chunks[]) und rufe layer1-extract pro chunk auf — compare/fanout + compare/merge können das orchestrieren.',
        });
      }
      throw err;
    }

    const prompt = [
      // ─── CONTAINER_BRIEF.md — Container-Selbst-Beschreibung ────────
      // Wird ALS ERSTES geladen, damit der LLM die Atom-Schema-Konventionen
      // (drucktext, datentyp, formatRegex, kontextPaths, …) kennt bevor er
      // Werte extrahiert. Liegt im Container, NICHT im Code.
      '=== CONTAINER-BRIEF (zuerst lesen) ===',
      containerBrief,
      '=== ENDE BRIEF ===',
      '',
      `Du bekommst einen deutschen Steuer-Beleg (Klasse: ${effectiveTypId}${effectiveTypId !== input.dokumenttyp_id ? ` ← aus Pass-2-Anlagen abgeleitet (Pass-1 klassifizierung war null)` : ''}).`,
      `Extrahiere alle relevanten Daten EXAKT nach dem JSON-Schema. Bewahre Originalnamen (auch bei OCR-Fehlern).`,
      '',
      // §EStG-Rahmen: welche Einkunftsarten / Anlagen sind erwartet?
      ...(hatRahmen
        ? ['--- STEUERRECHTLICHER RAHMEN ---', rahmenBlock, '']
        : []),
      // Pass-2-Bestätigung (Container-grounded Gemma-4-Vorlauf): eCodes mit
      // wörtlichen Belegstellen. Wenn vorhanden, ist das die zuverlässigste
      // Vokabular-Anker-Quelle — bevorzuge gegenüber den breiteren Kandidaten.
      ...(hatPass2
        ? ['--- PASS-2 BESTÄTIGTE eCODES MIT BELEGSTELLEN ---', pass2Block, '']
        : []),
      // Container-grounded field list — the authoritative ELSTER schema for
      // this document, derived at runtime from the gemma-quantum container.
      // This REPLACES the previous hardcoded field-name guidance.
      ...(hatKandidaten
        ? ['--- KANDIDATEN-eCODES (Container-grounded, gruppiert nach Anlage) ---',
           '(Diese eCodes stammen direkt aus dem BMF-Catalog. Format pro Zeile:',
           ' "EXXXXXXX [Zeile, datentyp, pflicht?]  Drucktext"',
           ' Wenn der Beleg eines dieser Felder enthält → eCode aus der Liste verwenden;',
           ' niemals erfinden. Currency-Werte als Zahlen erfassen (Deutsche Notation OK,',
           ' Normalisierung erfolgt downstream). Date-Werte im Originalformat.',
           ' Pflicht-Felder MÜSSEN gefüllt sein wenn im Beleg vorhanden.)',
           '',
           kandidatenBlock,
           '']
        : []),
      // Domain-specific disambiguation that the catalog can't encode
      // (enum mappings, classification choices). Kept small on purpose.
      ...(disambiguation.length > 0
        ? ['--- KLASSIFIKATIONS-HINWEISE ---', ...disambiguation, '']
        : []),
      ...(fieldHints
        ? ['--- VORANALYSIERTE FORM-FIELD-HINTS (aus Klassifizierungs-KPIs) ---',
           '(Bereits korrekt aus dem Dokument extrahiert — als Primärquelle nutzen.)',
           fieldHints,
           '']
        : []),
      '--- OCR-VOLLTEXT ---',
      input.text,
    ].join('\n');

    ctx.emit('layer1_started', {
      schemaName,
      dokumenttyp_id: effectiveTypId,
      provider,
      model: modelName,
      hasKpiHints: fieldHints.length > 0,
      kandidatenECodes: hatKandidaten ? (input.kandidatenECodes ?? []).length : 0,
    });

    const tLlm = Date.now();
    const result = await chatJson(prompt, {
      provider,
      model: modelName,
      vllmUrl: ctx.config.vllmUrl,
      temperature: ctx.config.temperature ?? 0,
      maxTokens: ctx.config.maxTokens ?? 2000,
      jsonSchema: { name: schemaJson.name, schema: schemaJson.schema, strict: true },
      signal: ctx.signal,
    });
    const llmMs = Date.now() - tLlm;

    await ctx.artifacts.write('layer1_nested.json', result.parsed);
    ctx.emit('layer1_done', {
      schemaId: schemaJson.name,
      llmMs,
      // Compact summary so SSE clients can render without huge payloads.
      preview: typeof result.parsed === 'object' && result.parsed !== null
        ? Object.keys(result.parsed as Record<string, unknown>).slice(0, 12)
        : [],
    });
    return {
      nested: result.parsed,
      schemaName,
      schemaId: schemaJson.name,
      llmMs,
      ms: Date.now() - t0,
    };
  },
});
