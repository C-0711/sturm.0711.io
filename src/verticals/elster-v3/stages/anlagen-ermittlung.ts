/**
 * elster-v3/anlagen-ermittlung — **Pass 2** des Klassifizierungs-Stacks.
 *
 * Wo dieser Stage sitzt:
 *
 *   OCR  →  klassifizierung (Mistral-Small, Pass 1)
 *              ↓ liefert: dokumenttyp_id, anlagen[], ecodeHintsProAnlage
 *           quantum-ground
 *              ↓ liefert: kandidatenECodes[] (scaffold+cascade+tail)
 *                          mit voller Atom-Metadata
 *
 *   →  anlagen-ermittlung (Gemma-4 vLLM, Container-grounded, **DIESER STAGE**)
 *              ↓ liefert: bestaetigteAnlagen[], erkannteECodes[]
 *                         mit Belegstellen aus dem OCR-Text
 *           layer1Fanout (Gemma + Mistral, befüllt nested JSON)
 *
 * Was Pass 2 macht:
 *   1. Lädt den CONTAINER_BRIEF.md als ersten Prompt-Block (LLM lernt
 *      Atom-Schema-Konventionen).
 *   2. Bekommt Pass-1-Hypothese (anlagen + kandidatenECodes) UND den OCR-Text.
 *   3. Fragt Gemma-4: "Welche dieser Anlagen sind WIRKLICH im Beleg?
 *      Welche eCodes hast du im OCR-Text gefunden? Mit welcher Belegstelle?"
 *   4. Erlaubt **ergaenzte** eCodes/Anlagen, die Pass 1 nicht hatte — wir
 *      bauen also eine Sicherheits-Layer GEGEN Fehlklassifikation.
 *   5. Strict json_schema → garantiert Schema-Compliance, kein Post-Parsing.
 *
 * Output wird von layer1Fanout konsumiert: erkannteECodes[] werden als
 * "PASS-2 bestätigt"-Block im Prompt vorangestellt — Layer 1 weiß damit
 * genau, welche eCodes welche Belegstelle haben.
 */
import { defineStage } from '../../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../../lib/llm-chat.ts';
import {
  computePromptBudget,
  contextTokensFor,
  assertFitsInBudget,
  PromptBudgetExceededError,
} from '../../../lib/prompt-budget.ts';
import {
  loadContainerBrief,
  paragraphFuer,
  type EinkunftsartCode,
} from '../../../lib/elster-catalog.ts';

// ─────────────────────────────────────────────────────────────────────────
// I/O Types
// ─────────────────────────────────────────────────────────────────────────

export interface AnlagenErmittlungInput {
  /** Voll-OCR-Text. Pass 2 darf nicht truncaten — falls > budget → fehler
   *  → caller muss vorher auto-source-split fahren. */
  text: string;
  /** Pass-1-Klassifizierung. */
  dokumenttyp_id: string;
  /** Pass-1-Anlagen-Hypothese. Pass 2 darf bestätigen / verwerfen / ergänzen. */
  anlagen?: string[];
  /** Pass-1-Vorauswahl der eCodes von quantum-ground. */
  kandidatenECodes?: Array<{
    field_name: string;
    anlage?: string;
    datentyp?: 'string' | 'date' | 'currency';
    pflicht?: boolean;
    vordruckzeile?: string;
    drucktext?: string;
    bezeichnung?: string;
    einkunftsart?: EinkunftsartCode | null;
    quelle?: 'scaffold' | 'cascade' | 'out_of_anlage';
  }>;
  /** Pass-1-Einkunftsarten (BMF-Vokabular). */
  einkunftsarten?: EinkunftsartCode[];
}

export interface ErkannterECode {
  eCode: string;
  /** Wörtlicher Span aus dem OCR-Text, der diese Erkennung beweist. */
  belegstelle: string;
  /** 0..1 — wie sicher Pass 2 sich ist. */
  konfidenz: number;
  /** Optional: Anlage (für audit). */
  anlage?: string;
}

export interface ErgaenzterECode {
  eCode: string;
  belegstelle: string;
  /** Warum war dieser eCode NICHT in den Pass-1-Kandidaten? */
  grund: string;
  anlage?: string;
}

export interface AnlagenErmittlungOutput {
  bestaetigteAnlagen: string[];
  ergaenzteAnlagen: string[];
  verworfeneAnlagen: string[];
  erkannteECodes: ErkannterECode[];
  ergaenzteECodes: ErgaenzterECode[];
  /** Modell-Notizen — vom LLM frei formuliert; KEIN Vertrag. */
  bemerkung?: string;
  stats: {
    pass1Anlagen: number;
    pass1Kandidaten: number;
    llmMs: number;
    ms: number;
  };
}

export interface AnlagenErmittlungConfig {
  provider?: ChatProvider;
  vllmUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Max kandidatenECodes-Lines im Prompt. Default 80 (Pass 2 darf mehr sehen
   *  als Layer 1 um informierte Verwerfungen treffen zu können). */
  maxKandidatenECodes?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Strict JSON schema — definiert den Output-Vertrag für vLLM-Constrained-Decoding
// ─────────────────────────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'bestaetigteAnlagen',
    'ergaenzteAnlagen',
    'verworfeneAnlagen',
    'erkannteECodes',
    'ergaenzteECodes',
  ],
  properties: {
    bestaetigteAnlagen: {
      type: 'array',
      description: 'Aus den Pass-1-anlagen — diese sind im Beleg tatsächlich vertreten.',
      items: { type: 'string' },
    },
    ergaenzteAnlagen: {
      type: 'array',
      description: 'NICHT in Pass-1-anlagen, aber im Beleg gefunden. Häufig bei Fehlklassifikation.',
      items: { type: 'string' },
    },
    verworfeneAnlagen: {
      type: 'array',
      description: 'In Pass-1-anlagen, aber im Beleg NICHT gefunden. Verwerfen vor Layer 1.',
      items: { type: 'string' },
    },
    erkannteECodes: {
      type: 'array',
      description:
        'Konkrete eCodes die im OCR-Text vorkommen, mit wörtlichem Beleg-Span. Bevorzuge eCodes aus den Pass-1-Kandidaten; nimm nur dann ergänzte eCodes wenn du den Span explizit findest.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['eCode', 'belegstelle', 'konfidenz'],
        properties: {
          eCode: { type: 'string', pattern: '^E[0-9]+$' },
          belegstelle: {
            type: 'string',
            description: 'Wörtlicher Auszug aus dem OCR-Text (≤120 chars), der diesen eCode rechtfertigt.',
          },
          konfidenz: { type: 'number', minimum: 0, maximum: 1 },
          anlage: { type: 'string' },
        },
      },
    },
    ergaenzteECodes: {
      type: 'array',
      description:
        'eCodes die NICHT in den Pass-1-Kandidaten waren, aber im OCR-Text klar erkennbar sind. Diese werden Layer 1 als zusätzliche Vokabularerweiterung mitgegeben.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['eCode', 'belegstelle', 'grund'],
        properties: {
          eCode: { type: 'string', pattern: '^E[0-9]+$' },
          belegstelle: { type: 'string' },
          grund: {
            type: 'string',
            description: 'Warum war dieser eCode nicht in den Pass-1-Kandidaten? (z.B. "Anlage von Pass 1 verworfen")',
          },
          anlage: { type: 'string' },
        },
      },
    },
    bemerkung: {
      type: 'string',
      description: 'Optional: Freitext-Notiz vom Modell für den Reviewer (z.B. mehrdeutige Stellen).',
    },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Prompt-Bau — kompakt, gruppiert nach Anlage
// ─────────────────────────────────────────────────────────────────────────

function formatiereKandidatenKompakt(
  kandidaten: NonNullable<AnlagenErmittlungInput['kandidatenECodes']>,
  cap: number,
): string {
  if (kandidaten.length === 0) return '(keine Kandidaten von quantum-ground)';
  const groups = new Map<string, typeof kandidaten>();
  for (const c of kandidaten.slice(0, cap)) {
    const a = c.anlage ?? '(?)';
    (groups.get(a) ?? groups.set(a, []).get(a)!).push(c);
  }
  const lines: string[] = [];
  for (const [anlage, items] of groups) {
    lines.push(`Anlage ${anlage}:`);
    for (const c of items) {
      const pflicht = c.pflicht === true ? '·PFLICHT' : '';
      const quelle = c.quelle === 'scaffold' ? '·gerüst' : '';
      const zeile = c.vordruckzeile ? `Z${c.vordruckzeile}` : '';
      const meta = [zeile, pflicht, quelle].filter(Boolean).join(' ');
      const label = (c.drucktext ?? c.bezeichnung ?? '').slice(0, 80);
      lines.push(`  ${c.field_name} [${meta}]  ${label}`);
    }
  }
  return lines.join('\n');
}

async function formatiereRahmen(
  einkunftsarten: EinkunftsartCode[] | undefined,
  anlagen: string[] | undefined,
): Promise<string> {
  const lines: string[] = [];
  if (anlagen && anlagen.length > 0) lines.push(`Pass-1 Anlagen-Hypothese: ${anlagen.join(', ')}`);
  if (einkunftsarten && einkunftsarten.length > 0) {
    lines.push('Pass-1 Einkunftsarten (BMF-Vokabular → §EStG):');
    for (const e of einkunftsarten) lines.push(`  • ${e.padEnd(24)} ${await paragraphFuer(e)}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const anlagenErmittlungStage = defineStage<
  AnlagenErmittlungInput,
  AnlagenErmittlungOutput,
  AnlagenErmittlungConfig
>({
  id: 'elster-v3/anlagen-ermittlung',
  name: 'Anlagen-Ermittlung (Pass 2, Container-grounded Gemma-4)',
  description:
    'Container-grounded Gemma-4-vLLM-Call zwischen quantum-ground und layer1Fanout. Bestätigt/verwirft/ergänzt die Pass-1-Anlagen, identifiziert konkrete eCodes mit Belegstellen aus dem OCR-Text. Strict json_schema → garantierte Schema-Compliance. Liest den CONTAINER_BRIEF.md zuerst.',
  hints: {
    inputs: 'text (OCR), dokumenttyp_id, anlagen[], kandidatenECodes[], einkunftsarten[]',
    outputs: 'bestaetigteAnlagen, ergaenzteAnlagen, verworfeneAnlagen, erkannteECodes[], ergaenzteECodes[], bemerkung, stats',
    configExample: JSON.stringify({
      provider: 'vllm',
      model: 'gemma4-mm',
      temperature: 0,
      maxTokens: 2000,
      maxKandidatenECodes: 80,
    }, null, 2),
    llm: { providers: ['vllm', 'mistral'], default: 'vllm' },
    acceptsContainers: ['elster-catalog', 'embedding-index'],
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'dokumenttyp_id', type: 'string' },
      { name: 'anlagen', type: 'json' },
      { name: 'kandidatenECodes', type: 'candidates' },
      { name: 'einkunftsarten', type: 'json' },
    ],
    outputPorts: [
      { name: 'bestaetigteAnlagen', type: 'json' },
      { name: 'erkannteECodes', type: 'json' },
      { name: 'ergaenzteECodes', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const provider: ChatProvider = cfg.provider ?? 'vllm';
    const defaultModelByProvider: Record<ChatProvider, string> = {
      vllm: 'gemma4-mm',
      mistral: 'mistral-large-latest',
      ollama: 'gemma4:31b-128k',
      anthropic: 'claude-haiku-4-5',
    };
    const modelName = cfg.model ?? defaultModelByProvider[provider];
    const maxKand = cfg.maxKandidatenECodes ?? 80;

    // Container-Brief als ERSTER Prompt-Block — der LLM lernt damit das
    // Atom-Schema bevor er Anlagen/eCodes bewertet.
    const containerBrief = await loadContainerBrief();
    const rahmenBlock = await formatiereRahmen(input.einkunftsarten, input.anlagen);
    const kandidatenBlock = formatiereKandidatenKompakt(input.kandidatenECodes ?? [], maxKand);

    // Budget-Check: Pass 2 darf NIEMALS truncaten. OCR > Budget → Fehler.
    const budget = computePromptBudget({
      modelContextTokens: contextTokensFor(modelName),
      schema: RESPONSE_SCHEMA,
      maxOutputTokens: cfg.maxTokens ?? 2000,
      overheadTokens:
        Math.ceil(containerBrief.length / 3.5) +
        Math.ceil(rahmenBlock.length / 3.5) +
        Math.ceil(kandidatenBlock.length / 3.5) +
        500,
    });
    try {
      assertFitsInBudget(input.text, budget);
    } catch (err) {
      if (err instanceof PromptBudgetExceededError) {
        ctx.emit('anlagen_ermittlung_budget_exceeded', {
          model: modelName,
          originalChars: err.textLen,
          budgetChars: err.budgetChars,
          budgetBreakdown: budget.breakdown,
          hint: 'Splitte den OCR-Text via auto-source-split und rufe Pass 2 pro chunk separat — die Outputs können via Anlagen-Union gemerged werden.',
        });
      }
      throw err;
    }

    const prompt = [
      '=== CONTAINER-BRIEF (zuerst lesen) ===',
      containerBrief,
      '=== ENDE BRIEF ===',
      '',
      `# Aufgabe: Anlagen-Ermittlung (Pass 2)`,
      ``,
      `Du bekommst die Pass-1-Hypothese (Mistral-Small-Klassifikation + quantum-ground)`,
      `und den OCR-Volltext eines deutschen Steuer-Belegs.`,
      ``,
      `**Deine Aufgabe**:`,
      `1. **Bestätige** die Pass-1-Anlagen, die im OCR-Text wirklich vertreten sind.`,
      `2. **Verwirf** Anlagen, die Pass 1 vorgeschlagen hat aber im Beleg fehlen.`,
      `3. **Ergänze** Anlagen, die Pass 1 übersehen hat, falls du sie im Text findest.`,
      `4. **Erkenne** konkrete eCodes aus den Kandidaten — mit wörtlichem Beleg-Span (≤120 chars).`,
      `5. **Ergänze** eCodes außerhalb der Kandidaten-Liste NUR wenn du sie eindeutig im Beleg siehst (und gib einen Grund an).`,
      ``,
      `**Regeln**:`,
      `- eCodes niemals erfinden. Nur eCodes aus den Atom-Definitionen des Containers (siehe Brief, Sektion 3, "eCodes niemals erfinden").`,
      `- belegstelle MUSS aus dem OCR-Text zitiert sein (≤120 chars Auszug).`,
      `- Konfidenz 0..1, ehrlich. Niedrige Werte sind OK — retrieval-verify eskaliert sie downstream.`,
      ``,
      `# Klassifizierungs-Klasse: ${input.dokumenttyp_id}`,
      '',
      ...(rahmenBlock.length > 0 ? ['--- PASS-1-RAHMEN ---', rahmenBlock, ''] : []),
      '--- KANDIDATEN-eCODES (von quantum-ground; gerüst=Pflicht-Atom der Anlagen) ---',
      kandidatenBlock,
      '',
      '--- OCR-VOLLTEXT ---',
      input.text,
    ].join('\n');

    ctx.emit('anlagen_ermittlung_started', {
      provider,
      model: modelName,
      pass1Anlagen: (input.anlagen ?? []).length,
      pass1Kandidaten: (input.kandidatenECodes ?? []).length,
    });

    const tLlm = Date.now();
    const result = await chatJson<AnlagenErmittlungOutput>(prompt, {
      provider,
      model: modelName,
      vllmUrl: cfg.vllmUrl,
      temperature: cfg.temperature ?? 0,
      maxTokens: cfg.maxTokens ?? 2000,
      jsonSchema: { name: 'anlagen_ermittlung', schema: RESPONSE_SCHEMA, strict: true },
      signal: ctx.signal,
    });
    const llmMs = Date.now() - tLlm;

    const parsed = result.parsed as Partial<AnlagenErmittlungOutput>;
    // strict mode: Schema garantiert die Felder; aber defensive defaulten.
    const output: AnlagenErmittlungOutput = {
      bestaetigteAnlagen: parsed.bestaetigteAnlagen ?? [],
      ergaenzteAnlagen: parsed.ergaenzteAnlagen ?? [],
      verworfeneAnlagen: parsed.verworfeneAnlagen ?? [],
      erkannteECodes: parsed.erkannteECodes ?? [],
      ergaenzteECodes: parsed.ergaenzteECodes ?? [],
      bemerkung: parsed.bemerkung,
      stats: {
        pass1Anlagen: (input.anlagen ?? []).length,
        pass1Kandidaten: (input.kandidatenECodes ?? []).length,
        llmMs,
        ms: Date.now() - t0,
      },
    };

    await ctx.artifacts.write('anlagen_ermittlung.json', output);
    ctx.emit('anlagen_ermittlung_done', {
      bestaetigt: output.bestaetigteAnlagen.length,
      ergaenzt: output.ergaenzteAnlagen.length,
      verworfen: output.verworfeneAnlagen.length,
      erkannte_eCodes: output.erkannteECodes.length,
      ergaenzte_eCodes: output.ergaenzteECodes.length,
      llmMs,
    });

    return output;
  },
});
