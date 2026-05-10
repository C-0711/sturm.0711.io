/**
 * validator-stage — runs ELSTER Hinweisregeln against the canonical layer
 * produced by funnel-stage. Output is the canonical layer with its
 * `validator` field populated (passes count + warnings + errors).
 */
import { defineStage } from '../../../core/stage.ts';
import type { CanonicalLayer } from '../../../lib/canonical-layer.ts';
import { loadCatalog } from '../lib/elster-katalog.ts';
import { evaluateRules } from '../lib/hinweisregeln.ts';

export interface ValidatorInput {
  canonicalLayer: CanonicalLayer;
}

export interface ValidatorOutput {
  canonicalLayer: CanonicalLayer; // returned with validator field populated
  stats: {
    rulesEvaluated: number;
    rulesFired: number;
    rulesSkipped: number;
    rulesPassed: number;
    ms: number;
  };
}

export interface ValidatorConfig {
  /** Restrict to specific anlagen (otherwise infers from layer's eCode prefixes) */
  anlagen?: string[];
  /** Default true: skip rules with unsupported pathRef expressions */
  skipUnsupported?: boolean;
}

const ANLAGE_BY_CODE_PREFIX: Record<string, string> = {
  E0100: 'ESt1A', E0101: 'ESt1A', E0102: 'ESt1A', E0103: 'ESt1A', E0104: 'ESt1A',
  E0105: 'SA', E0106: 'SA', E0107: 'SA', E0108: 'SA',
  E0109: 'AgB', E0110: 'AgB', E0111: 'AgB',
  E0120: 'KAP', E0121: 'KAP', E0122: 'KAP', E0123: 'ESt1A',
  E0150: 'Kind',
  E0180: 'HA_35a', E0181: 'HA_35a',
  E0190: 'Sonst',
  E0200: 'N', E0201: 'N', E0202: 'N', E0203: 'N', E0204: 'N', E0205: 'N',
  E0206: 'N', E0207: 'N', E0208: 'N', E0209: 'N',
  E0220: 'R', E0221: 'R', E0222: 'R',
  E0224: 'KAP_BET',
  E0260: 'V',
  E0300: 'SO',
  E0400: 'L',
  E0500: 'Kind',
  E0700: 'VOR', E0701: 'VOR', E0702: 'VOR', E0703: 'VOR',
  E0800: 'SA',
  E0900: 'Kind', E0910: 'Kind',
  E1800: 'R', E1810: 'R', E1820: 'R',
  E1900: 'KAP', E1901: 'KAP', E1902: 'KAP', E1903: 'KAP', E1904: 'KAP', E1905: 'KAP',
  E1940: 'KAP_BET', E1941: 'KAP_BET',
  E2000: 'VOR', E2001: 'VOR',
  E2110: 'AV',
};

function inferAnlagen(layer: CanonicalLayer): string[] {
  const set = new Set<string>();
  for (const code of Object.keys(layer.codes)) {
    const prefix = code.substring(0, 5);
    const a = ANLAGE_BY_CODE_PREFIX[prefix];
    if (a) set.add(a);
  }
  return [...set];
}

export const validatorStage = defineStage<ValidatorInput, ValidatorOutput, ValidatorConfig>({
  id: 'elster/validator',
  name: 'ELSTER-Hinweisregeln-Validator',
  description:
    'Wertet die Hinweisregeln aus der Jahresdokumentation gegen den Canonical-Layer aus. Liefert Anzahl bestandener Regeln + Liste gefeuerter Hinweise/Fehler. Verhindert ERiC-Reject vor dem Abschicken.',

  async run(input, ctx) {
    const t0 = Date.now();
    const catalog = await loadCatalog();
    const anlagen = ctx.config.anlagen ?? inferAnlagen(input.canonicalLayer);
    const { result, details } = evaluateRules(
      input.canonicalLayer,
      catalog.hinweisregeln,
      {
        anlagen,
        skipUnsupported: ctx.config.skipUnsupported !== false,
      },
    );

    const updatedLayer: CanonicalLayer = {
      ...input.canonicalLayer,
      validator: result,
    };

    const stats = {
      rulesEvaluated: details.length,
      rulesFired: details.filter((d) => d.status === 'fired').length,
      rulesSkipped: details.filter((d) => d.status === 'skipped').length,
      rulesPassed: details.filter((d) => d.status === 'passed').length,
      ms: Date.now() - t0,
    };
    ctx.emit('validator_done', stats);

    await ctx.artifacts.write('validator_details.json', { stats, details: details.slice(0, 200) });

    return { canonicalLayer: updatedLayer, stats };
  },
});
