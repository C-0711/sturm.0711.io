import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/mistral-chat.ts';
import { loadKatalog } from '../lib/anlagen-katalog.ts';

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
  ms: number;
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
  N: [/Anlage\s*N\b/i, /Eink[uü]nfte\s+aus\s+nichtselbst[aä]ndiger\s+Arbeit/i],

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

async function llmClassify(
  text: string,
  anlagenNames: string[],
  model: string,
  temperature: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const prompt = [
    'Du bekommst den Text einer gescannten Einkommensteuererklärung.',
    'Welche der folgenden ELSTER-Anlagen kommen im Dokument vor?',
    'Antworte ausschließlich mit einem JSON-Objekt der Form {"anlagen": ["NAME1", ...]}.',
    'Gib nur Namen aus dieser Liste zurück:',
    anlagenNames.join(', '),
    '',
    '--- Dokument ---',
    text.slice(0, 30_000),
  ].join('\n');

  const { parsed } = await chatJson<{ anlagen?: string[] }>(prompt, {
    model,
    temperature,
    signal,
  });
  const allowed = new Set(anlagenNames);
  return (parsed.anlagen ?? []).filter((n) => allowed.has(n));
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

  async run(input, ctx) {
    const t0 = Date.now();
    const katalog = await loadKatalog(input.vz);
    const anlagenNames = katalog.anlagen.map((a) => a.name);
    const allowed = new Set(anlagenNames);

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
        ms: Date.now() - t0,
      };
    }

    const regexHits = runRegex(input.text, allowed);
    const regexNames = Object.keys(regexHits);
    ctx.emit('regex_hits', { anlagen: regexNames, counts: regexHits });

    const mode = ctx.config.llmFallbackWhen ?? 'zero-or-one';
    const shouldLlm =
      mode === 'always' || (mode === 'zero-or-one' && regexNames.length <= 1);

    let llmNames: string[] = [];
    let usedLlm = false;
    if (shouldLlm) {
      try {
        llmNames = await llmClassify(
          input.text,
          anlagenNames,
          ctx.config.model ?? 'mistral-small-latest',
          ctx.config.temperature ?? 0,
          ctx.signal,
        );
        usedLlm = true;
        ctx.emit('llm_hits', { anlagen: llmNames });
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
    });

    return {
      erkannte_anlagen: union,
      regex_hits: regexHits,
      llm_hits: llmNames,
      used_llm: usedLlm,
      ms: Date.now() - t0,
    };
  },
});
