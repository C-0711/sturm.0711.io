import { defineStage } from '../../../core/stage.ts';
import { loadKatalog } from '../lib/anlagen-katalog.ts';
import type { LlmHandle } from '../../../core/tools/handles.ts';
import type { ToolContainerView } from '../../../core/tools/types.ts';

export interface KlassifizierungInput {
  text: string;
  vz?: number | string;
  /**
   * Wave 25 v2: vom Caller (cb-ctax) vorgeschlagenes Anlagen-Set, abgeleitet
   * aus Mistral-Small-KPIs in Phase F. Wird in Kombination mit `skip=true`
   * direkt als erkannte_anlagen uebernommen — Regex+LLM werden uebersprungen.
   * Ohne `skip=true` wird der Hint nur als Subset-Filter benutzt
   * (eigene Regex-Treffer + LLM-Treffer werden mit dem Hint geschnitten).
   */
  anlagen_hint?: string[];
  /**
   * Wave 25 v2: wenn true, wird die Klassifizierung komplett uebersprungen
   * und das Hint-Set 1:1 als erkannte_anlagen zurueckgegeben. Setzt voraus
   * dass anlagen_hint gegeben ist; sonst Fallback auf normale Klassifizierung.
   */
  skip?: boolean;
}

export interface KlassifizierungOutput {
  erkannte_anlagen: string[];
  regex_hits: Record<string, number>;
  llm_hits: string[];
  used_llm: boolean;
  /** Wenn gesetzt: Meta-Dokument (Transferticket etc.) wurde erkannt,
   *  Downstream-Stages sollten zu No-ops werden. */
  kpi_warning?: 'meta-doc';
  /** v5_4 Hybrid-Routing: grobe Dokumentklasse (immer gesetzt). */
  doc_type: 'vast_bundle' | 'einkommensteuererklaerung' | 'einzelbeleg';
  /** v5_4 Hybrid-Routing: Veranlagungszeitraum aus OCR (optional). */
  steuerjahr?: number;
  ms: number;
}

/**
 * v5_4 Hybrid-Routing: bestimmt doc_type rein heuristisch aus OCR-Text.
 * Keine LLM-Calls, keine zusätzlichen Allokationen.
 */
function detectDocType(text: string): KlassifizierungOutput['doc_type'] {
  const hasTransferticket = /Transferticket:\s*Steuer-Abruf/i.test(text);
  const hasHauptvordruck = /Hauptvordruck\s+ESt\s*1\s*A|Einkommensteuererklärung\s+\d{4}/i.test(text);
  return hasTransferticket
    ? 'vast_bundle'
    : hasHauptvordruck
      ? 'einkommensteuererklaerung'
      : 'einzelbeleg';
}

/**
 * v5_4 Hybrid-Routing: extrahiert Veranlagungszeitraum (Jahr) aus OCR.
 * Bevorzugt explizite Marker ("Veranlagungszeitraum 2024"), fällt sonst
 * auf die erste 20XX-Zahl im Text zurück. Range-Check 2010–2099.
 */
function detectSteuerjahr(text: string): number | undefined {
  const yrMatch =
    text.match(/(?:Veranlagungszeitraum|Steuerjahr|VZ|Erklärung|ESt)\s*[:.\s]*(\d{4})/i) ||
    text.match(/\b(20[0-9]{2})\b/);
  if (!yrMatch) return undefined;
  const y = Number(yrMatch[1]);
  if (y >= 2010 && y <= 2099) return y;
  return undefined;
}

export interface KlassifizierungConfig {
  model?: string;
  llmFallbackWhen?: 'never' | 'zero-or-one' | 'always';
  temperature?: number;
}

/**
 * Hybrid classifier: regex against canonical Anlagen titles first, LLM
 * fallback only when regex is weak (<=1 hit by default).
 *
 * Smoke test:
 *   input  = { text: "Anlage N Einkünfte aus nichtselbständiger Arbeit ..." }
 *   output = { erkannte_anlagen: ["N"], regex_hits: { N: 2 }, used_llm: false }
 *
 * Reihenfolge der PATTERNS ist bedeutsam: spezifischere Anlagen (N_AUS, KAP_I)
 * kommen vor den generischen (N, KAP), damit der Regex-Zähler korrekt bleibt.
 */
const PATTERNS: Record<string, RegExp[]> = {
  // Pflicht
  ESt1A: [/Hauptvordruck\s+ESt\s*1\s*A/i, /Einkommensteuererkl[aä]rung/i],
  ESt1A_U: [/ESt\s*1\s*A[\-\s]*U\b/i, /unbeschr[aä]nkt\s+steuerpflichtig/i],
  Vorsatz: [/\bVorsatz\b/i],

  // N-Familie
  N_AUS: [/Anlage\s*N[\-\s]*AUS/i, /ausl[aä]ndische\s+Eink[uü]nfte\s+aus\s+nichtselbst/i],
  N_DHH: [/Anlage\s*N[\-\s]*DHH/i, /doppelte\s+Haushaltsf[uü]hrung/i],
  N_GRE: [/Anlage\s*N[\-\s]*GRE/i, /Grenzg[aä]nger/i],
  N: [
    /Anlage\s*N\b/i,
    /Eink[uü]nfte\s+aus\s+nichtselbst[aä]ndiger\s+Arbeit/i,
    /Lohnsteuerbescheinigung/i,
    /Ausdruck\s+der\s+elektronischen\s+Lohnsteuerbescheinigung/i,
    /Bruttoarbeitslohn/i,
    /eTIN\b/i,
  ],

  // KAP-Familie
  KAP_BET: [/Anlage\s*KAP[\-\s]*BET/i, /Beteiligungen/i],
  KAP_I: [/Anlage\s*KAP[\-\s]*INV/i, /Investmentanteile/i],
  KAP: [/Anlage\s*KAP\b/i, /Kapitalverm[oö]gen/i],

  // Sonderausgaben / Vorsorge / AV
  SA: [/Anlage\s*Sonderausgaben/i, /Anlage\s*SA\b/i],
  VOR: [/Anlage\s*Vorsorgeaufwand/i, /Vorsorgeaufwendungen/i],
  AV: [/Anlage\s*AV\b/i, /Altersvorsorgebeitr[aä]ge/i, /Riester/i],
  RAV_bAV: [/Anlage\s*R[\-\s]*AV/i, /betriebliche\s+Altersvorsorge/i, /\bbAV\b/],

  // Außergewöhnliche Belastungen, Haushalt, energetische Maßnahmen
  AgB: [/Anlage\s*AgB\b/i, /au[sß]ergew[oö]hnliche\s+Belastung/i],
  HA_35a: [/Anlage\s*Haushaltsnahe/i, /haushaltsnahe\s+Besch[aä]ftigung/i, /§\s*35\s*a/i],
  EM_35c: [/Anlage\s*Energetische/i, /energetische\s+Ma[sß]nahmen/i, /§\s*35\s*c/i],

  // V-Familie
  V_FeWo: [/Anlage\s*V[\-\s]*FeWo/i, /Ferienwohnung/i],
  V_Sonstige: [/Anlage\s*V[\-\s]*Sonstige/i],
  V: [/Anlage\s*V\b/i, /Vermietung\s+und\s+Verpachtung/i],

  // Gewerbe, selbständig, Land+Forst, Förderung
  G: [/Anlage\s*G\b/i, /Gewerbebetrieb/i],
  S: [/Anlage\s*S\b/i, /selbst[aä]ndige\s+Arbeit/i],
  L: [/Anlage\s*L\b/i, /Land-\s*und\s*Forstwirtschaft/i],
  FW: [/Anlage\s*FW\b/i, /F[oö]rderung\s+des\s+Wohneigentums/i],

  // Renten, Auslandseinkünfte, Sonstiges
  R_AUS: [/Anlage\s*R[\-\s]*AUS/i],
  R: [/Anlage\s*R\b/i, /\bRenten\b/i],
  AUS: [/Anlage\s*AUS\b/i, /ausl[aä]ndische\s+Eink[uü]nfte/i],
  SO: [/Anlage\s*SO\b/i, /sonstige\s+Eink[uü]nfte/i],

  // Rest
  Kind: [/Anlage\s*Kind\b/i, /Kinderfreibetrag/i],
  Mob: [/Anlage\s*Mobilit[aä]tspr[aä]mie/i, /Mobilit[aä]tspr[aä]mie/i],
  WA_ESt: [/WA[\-\s]*ESt/i, /Wegzug/i, /Wohnsitzaufgabe/i],
  Anl_34b: [/§\s*34\s*b/i, /au[sß]erordentliche\s+Eink[uü]nfte/i],
  Zins: [/Anlage\s*Zins\b/i],
  Corona: [/Corona[\-\s]*Soforthilfen/i, /Corona[\-\s]*Überbr[uü]ckungshilfen/i],
  Sonst: [/Anlage\s*Sonstiges/i],
};

function runRegex(text: string, allowed: Set<string>): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const [name, regexes] of Object.entries(PATTERNS)) {
    if (!allowed.has(name)) continue;
    let count = 0;
    for (const re of regexes) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      const m = text.match(g);
      if (m) count += m.length;
    }
    if (count > 0) hits[name] = count;
  }
  return hits;
}

/** Evidence-required LLM classify. Anders als zuvor ("welche Anlagen sind vorhanden?")
 *  fordert dieser Prompt PRO Anlage eine wörtliche OCR-Zitatzeile. Server-side
 *  filtern wir Anlagen deren `evidence`-Snippet NICHT als substring im OCR-Text
 *  vorkommt — schließt LLM-Halluzinationen ("KAP weil Sparkasse erwähnt") aus. */
/**
 * P10 — Tool-binding: an LlmHandle from the Anwendung roster is mandatory.
 * Wahlhierarchie:
 *   1. `classify-fallback` (claude-haiku) — critic-grade Gegenleser.
 *   2. `classify-primary`  (mistral-small) — günstigerer Pfad.
 *
 * Beide sind in steuerfall-est als required:true deklariert. Wenn weder
 * vorhanden ist, wirft `getByRole('classify-fallback')` mit einer klaren
 * Fehlermeldung — das ist der korrekte Vertrag für Standalone-Runs ohne
 * Anwendung-Kontext.
 */
function pickKlassifizierungHandle(tools: ToolContainerView): LlmHandle {
  if (tools.has('claude-haiku')) {
    return tools.getByRole<LlmHandle>('classify-fallback');
  }
  // Falls claude-haiku nicht gebunden ist, fällt der Lookup auf classify-primary
  // zurück — NullToolContainer wirft, wenn auch das fehlt.
  return tools.getByRole<LlmHandle>('classify-primary');
}

async function llmClassify(
  text: string,
  anlagenNames: string[],
  temperature: number,
  signal: AbortSignal | undefined,
  handle: LlmHandle,
): Promise<{ names: string[]; rejected: Array<{ name: string; reason: string; evidence?: string }> }> {
  const prompt = [
    'Du bekommst den Text eines Steuerdokuments (OCR).',
    'Für JEDE Anlage die TATSÄCHLICH im Dokument vorkommt, zitiere genau EINE',
    'wörtliche Textstelle (10-200 Zeichen) die ihre Präsenz beweist.',
    'WICHTIG: NUR Anlagen aufnehmen für die du eine echte Textstelle zitieren kannst.',
    'KEINE Anlagen aufgrund von Vermutungen, Erwähnungen anderer Begriffe',
    '(z.B. „Sparkasse" beweist NICHT Anlage KAP), oder Boilerplate.',
    '',
    'Antworte als JSON: {"anlagen": [{"name": "<CODE>", "evidence": "<exakte OCR-Zeile>"}, ...]}.',
    'Erlaubte Anlagen-Codes:',
    anlagenNames.join(', '),
    '',
    '--- OCR-Volltext ---',
    text.slice(0, 30_000),
  ].join('\n');

  // P10: LLM-Handle ist mandatorisch — wird aus dem Anwendung-Roster
  // aufgelöst (classify-fallback bevorzugt, sonst classify-primary).
  const parsed = await handle.chatJson<{ anlagen?: Array<{ name: string; evidence?: string }> }>(
    prompt,
    { temperature, signal },
  );

  const allowed = new Set(anlagenNames);
  const lowerText = text.toLowerCase();
  const names: string[] = [];
  const rejected: Array<{ name: string; reason: string; evidence?: string }> = [];

  for (const entry of parsed.anlagen ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name ?? '').trim();
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
    if (!allowed.has(name)) {
      rejected.push({ name, reason: 'name_not_in_catalog', evidence });
      continue;
    }
    if (!evidence || evidence.length < 10) {
      rejected.push({ name, reason: 'evidence_too_short', evidence });
      continue;
    }
    // Substring-Check: das LLM-zitierte Snippet muss tatsächlich (oder mit
    // moderater Toleranz) im OCR vorkommen. Wir prüfen die ersten 30 chars —
    // genug Spezifität, tolerant gegenüber zitiertem Trailing-Whitespace.
    const probe = evidence.toLowerCase().slice(0, 30).replace(/\s+/g, ' ').trim();
    const probeFound = probe.length >= 6 && lowerText.includes(probe);
    if (!probeFound) {
      rejected.push({ name, reason: 'evidence_not_in_ocr', evidence });
      continue;
    }
    names.push(name);
  }
  return { names, rejected };
}

export const klassifizierungStage = defineStage<
  KlassifizierungInput,
  KlassifizierungOutput,
  KlassifizierungConfig
>({
  id: 'elster/klassifizierung',
  name: 'Anlagen-Klassifizierung',
  description:
    'Erkennt über Regex gegen ELSTER-Drucktexte, welche Anlagen im OCR-Text vorkommen. Bei schwachem Regex-Ergebnis fragt sie ein kleines LLM mit der vollen Anlagen-Liste als Enum.',
  hints: {
    inputs: 'text (OCR-Volltext)',
    outputs: 'erkannte_anlagen[], regex_hits, llm_hits, used_llm, ms',
    configExample: '{"llmFallbackWhen":"zero-or-one","model":"mistral-small-latest"}',
    inputPorts: [
      { name: 'text', type: 'text', description: 'OCR-Volltext aus mistral-ocr' },
    ],
    outputPorts: [
      { name: 'erkannte_anlagen', type: 'json', description: 'Liste der detektierten Anlagen-Codes (z.B. ["N","KAP","ESt1A"])' },
      { name: 'regex_hits', type: 'json', description: 'Pro Anlage: Anzahl Pattern-Treffer im OCR' },
      { name: 'llm_hits', type: 'json', description: 'Anlagen die das LLM-Fallback hinzugefügt hat (leer wenn Regex schon reichte)' },
      { name: 'used_llm', type: 'json', description: 'true wenn LLM-Fallback gefeuert hat' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const katalog = await loadKatalog(input.vz);
    const anlagenNames = katalog.anlagen.map((a) => a.name);
    const allowed = new Set(anlagenNames);

    // v5_4 Hybrid-Routing: doc_type IMMER, steuerjahr falls extrahierbar.
    // Reine Regex-Heuristik, additive Erweiterung — bestehende Logik unverändert.
    const doc_type = detectDocType(input.text);
    const steuerjahr = detectSteuerjahr(input.text);

    // ─── I1.4 Meta-Dokument-Heuristik ──────────────────────────────────────
    // ELSTER produziert eine Reihe von Meta-Dokumenten (Transferticket,
    // Steuer-Abruf-Quittung, Empfangsbestätigung), die für die Extraktion
    // wertlos sind, aber genug "tax language" enthalten, dass die Regex-
    // Erkennung Anlagen wie N treffen kann. Wir erkennen diese Klasse hier
    // *vor* Regex+LLM und kürzen ab: `erkannte_anlagen=[]` + `meta_doc`
    // KPI-Warning. Downstream-Stages (felderKatalog, phase1Regex usw.)
    // werden zu No-ops.
    const META_DOC_PATTERNS = [
      /\btransfer-?ticket\b/i,
      /\bsteuer[- ]?abruf\b/i,
      /\bsteuer-?konto[ -]?abruf\b/i,
      /\bempfangs[- ]?bestätigung\b/i,
      /\bquittung\s+über\s+den\s+abruf\b/i,
      /\babruf[- ]?bescheinigung\b/i,
    ];
    const metaHits = META_DOC_PATTERNS.filter((re) => re.test(input.text)).map((re) => re.source);
    // Zusätzlich: sehr kurze Dokumente OHNE typische Wertspalten (€-Zeichen,
    // Beträge mit Komma+Cent) sind selten Belege.
    const hasCurrency = /\b\d{1,3}(?:\.\d{3})*,\d{2}\s*€/.test(input.text) || /\d+,\d{2}\s*€/.test(input.text);
    const isMetaDoc = metaHits.length > 0 && (!hasCurrency || input.text.length < 1200);
    if (isMetaDoc) {
      ctx.emit('meta_doc_detected', { patterns: metaHits, hasCurrency, textLen: input.text.length });
      ctx.logger.info('Meta-Dokument erkannt — keine Beleg-Extraktion', {
        patterns: metaHits,
        hasCurrency,
        textLen: input.text.length,
      });
      await ctx.artifacts.write('erkannte_anlagen.json', {
        erkannte_anlagen: [],
        regex_hits: {},
        llm_hits: [],
        meta_doc: true,
        meta_patterns: metaHits,
      });
      return {
        erkannte_anlagen: [],
        regex_hits: {},
        llm_hits: [],
        used_llm: false,
        kpi_warning: 'meta-doc',
        doc_type,
        steuerjahr,
        ms: Date.now() - t0,
      };
    }

    // ─── Wave 25 v2: skip_classification + anlagen_hint ─────────────────────
    // cb-ctax hat aus Mistral-Small-KPIs schon ein konfidentes Anlagen-Set
    // abgeleitet (siehe leiteProfilUndAnlagenAb.ts). Wenn `skip=true` und
    // `anlagen_hint` nicht-leer: Klassifizierung kurzschliessen, Pass 3 laeuft
    // direkt gegen das Hint-Set. Spart 1 Regex-Sweep + ggf. einen LLM-Call.
    if (input.skip === true && Array.isArray(input.anlagen_hint) && input.anlagen_hint.length > 0) {
      const hintSet = input.anlagen_hint.filter((n) => allowed.has(n)).sort();
      ctx.emit('skip_classification', { anlagen: hintSet, reason: 'caller_hint' });
      await ctx.artifacts.write('erkannte_anlagen.json', {
        erkannte_anlagen: hintSet,
        regex_hits: {},
        llm_hits: [],
        skipped: true,
        hint_source: 'caller',
      });
      return {
        erkannte_anlagen: hintSet,
        regex_hits: {},
        llm_hits: [],
        used_llm: false,
        doc_type,
        steuerjahr,
        ms: Date.now() - t0,
      };
    }

    const regexHits = runRegex(input.text, allowed);
    const regexNames = Object.keys(regexHits);
    ctx.emit('regex_hits', { anlagen: regexNames, counts: regexHits });

    // Default verschärft: 'zero' statt 'zero-or-one' — LLM-Fallback NUR
    // wenn der Regex GAR NICHTS findet. Bei 1+ Regex-Hits trauen wir der
    // deterministischen Erkennung und vermeiden Phantom-Anlagen.
    const mode = ctx.config.llmFallbackWhen ?? 'zero';
    const shouldLlm =
      mode === 'always' ||
      (mode === 'zero-or-one' && regexNames.length <= 1) ||
      (mode === 'zero' && regexNames.length === 0);

    let llmNames: string[] = [];
    let llmRejected: Array<{ name: string; reason: string; evidence?: string }> = [];
    let usedLlm = false;
    if (shouldLlm) {
      const handle = pickKlassifizierungHandle(ctx.tools);
      ctx.logger.debug('klassifizierung: using bound LLM handle', {
        tool: handle.name,
        provider: handle.meta.provider,
        model: handle.meta.model,
      });
      try {
        const r = await llmClassify(
          input.text,
          anlagenNames,
          ctx.config.temperature ?? 0,
          ctx.signal,
          handle,
        );
        llmNames = r.names;
        llmRejected = r.rejected;
        usedLlm = true;
        ctx.emit('llm_hits', { anlagen: llmNames, rejected: llmRejected.length });
        if (llmRejected.length > 0) {
          ctx.logger.info('LLM-Klassifizierung: rejected phantom anlagen', {
            rejected: llmRejected,
          });
        }
      } catch (err) {
        ctx.logger.warn('LLM fallback failed, keeping regex-only result', {
          error: (err as Error).message,
        });
      }
    }

    const union = Array.from(new Set([...regexNames, ...llmNames])).sort();
    await ctx.artifacts.write('erkannte_anlagen.json', {
      erkannte_anlagen: union,
      regex_hits: regexHits,
      llm_hits: llmNames,
      llm_rejected: llmRejected,
    });

    return {
      erkannte_anlagen: union,
      regex_hits: regexHits,
      llm_hits: llmNames,
      used_llm: usedLlm,
      doc_type,
      steuerjahr,
      ms: Date.now() - t0,
    };
  },
});
