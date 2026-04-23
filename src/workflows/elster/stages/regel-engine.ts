import { defineStage } from '../../../core/stage.ts';
import {
  parseMistralText,
  mappeFundstelle,
  flatteneVision,
  mappeVisionKandidat,
  wertGleich,
  bmfValidiereWert,
  getIndices,
  type Fundstelle,
  type VisionKandidat,
  type MappedFundstelle,
} from '../lib/helpers.ts';

// NOTE: Original legacy/elster-mvp/server.mjs:1348 gibt `anlagen` als String-Array
// zurueck (`[...anlagenSet]`). Die Task-Spezifikation nannte `Record<string, unknown>`;
// treu zur Leitplanke "EXAKT übernehmen" behalten wir hier das Array bei.

interface MistralTreffer {
  wert: string;
  konfidenz: number;
  raw: string;
  match: string;
}

interface VisionTreffer {
  wert: unknown;
  konfidenz: number;
  pfad: string;
  match: string;
}

interface ProCodeEintrag {
  code: string;
  anlage: string;
  kontext: string;
  personen_ctx: 'A' | 'B' | null;
  mistral?: MistralTreffer;
  vision?: VisionTreffer;
}

interface KurationsEintrag {
  code: string;
  anlage: string;
  kontext: string;
  personen_ctx: 'A' | 'B' | null;
  mistral: MistralTreffer | null;
  vision: VisionTreffer | null;
  wert?: unknown;
  quelle?: 'beide' | 'mistral' | 'vision';
  konfidenz?: number;
  bmf_regex_ok?: boolean | null;
  grund?: string;
  details?: string | null;
  mistral_wert?: unknown;
  vision_wert?: unknown;
}

interface VerworfenMistral {
  zeile?: string;
  anlage: string;
  personen_ctx?: 'A' | 'B' | null;
  drucktext_cand: string;
  wert: string;
  grund: string;
  raw?: string;
  kandidat_code?: string;
}

interface VerworfenVision {
  pfad: string;
  wert: unknown;
  grund: string;
  kandidat_code?: string;
}

export interface RegelEngineInput {
  mistralText: string;
  visionAnnotation: unknown;
  gewaehlteAnlagen?: string[];
}

export interface RegelEngineOutput {
  eindeutig: KurationsEintrag[];
  konflikte: KurationsEintrag[];
  unklarheiten: KurationsEintrag[];
  anlagen: string[];
  verworfen_mistral: VerworfenMistral[];
  verworfen_vision: VerworfenVision[];
  verworfen_anlage_nicht_erkannt?: Array<
    | (KurationsEintrag & { kategorie: 'eindeutig' | 'konflikt' | 'unklarheit' })
  >;
  alle_fundstellen_mistral: Fundstelle[];
  alle_fundstellen_vision: VisionKandidat[];
  stats: {
    mistral_fundstellen: number;
    vision_kandidaten: number;
    eindeutig: number;
    konflikte: number;
    unklarheiten: number;
    verworfen_mistral: number;
    verworfen_vision: number;
  };
}

export const regelEngineStage = defineStage<RegelEngineInput, RegelEngineOutput>({
  id: 'elster-regel-engine',
  name: 'Regel-Engine',
  description: 'Deterministisches Label-Matching Mistral-OCR + Vision gegen BMF-Katalog',
  async run(input, ctx) {
    const { mistralText, visionAnnotation, gewaehlteAnlagen } = input;
    const { elsterCatalog, bmfLabelIndex } = getIndices();

    const fundstellen = parseMistralText(mistralText || '');
    const visionExtract =
      visionAnnotation && typeof visionAnnotation === 'object'
        ? (visionAnnotation as Record<string, unknown>)
        : null;
    const visionFlach = flatteneVision(visionExtract || {});

    // Schritt 1: Anlagen sammeln, die Mistral im Roh-Text explizit erwaehnt
    // sowie vision-seitig als erkannt markiert sind.
    const mistralAnlagen = new Set<string>();
    for (const f of fundstellen) mistralAnlagen.add(f.anlage);
    const erkannteVision = (visionExtract as { erkannte_anlagen?: unknown })?.erkannte_anlagen;
    if (Array.isArray(erkannteVision)) {
      for (const a of erkannteVision) {
        if (typeof a === 'string' && elsterCatalog?.anlagen?.[a]) mistralAnlagen.add(a);
      }
    }
    const erlaubt = mistralAnlagen;

    // BUG-4-FIX: Match-Key enthaelt Personen-Kontext, damit Person A/B nicht kollidieren.
    // Fuer person-agnostische Codes (z.B. Finanzamt) ist ctx leer und der Key ist stabil.
    const proCode = new Map<string, ProCodeEintrag>();
    const verworfen_mistral: VerworfenMistral[] = [];
    const verworfen_vision: VerworfenVision[] = [];
    const keyFuerCode = (code: string, kontext: 'A' | 'B' | null | undefined): string =>
      `${code}|${kontext || ''}`;

    for (const f of fundstellen) {
      const m: MappedFundstelle | null = mappeFundstelle(f);
      if (!m) {
        if (f.drucktext_cand && f.wert) {
          verworfen_mistral.push({
            zeile: f.zeile,
            anlage: f.anlage,
            personen_ctx: f.personen_ctx,
            drucktext_cand: f.drucktext_cand,
            wert: f.wert,
            grund: 'kein Label-Match im BMF-Katalog',
            raw: f.raw,
          });
        }
        continue;
      }
      if (!erlaubt.has(m.anlage)) {
        verworfen_mistral.push({
          zeile: f.zeile,
          anlage: f.anlage,
          drucktext_cand: f.drucktext_cand,
          wert: f.wert,
          grund: `Anlage ${m.anlage} nicht in erkannten Dokument-Anlagen`,
          kandidat_code: m.code,
        });
        continue;
      }
      const key = keyFuerCode(m.code, f.personen_ctx);
      const entry: ProCodeEintrag = proCode.get(key) || {
        code: m.code,
        anlage: m.anlage,
        kontext: m.kontext,
        personen_ctx: f.personen_ctx,
      };
      entry.mistral = { wert: f.wert, konfidenz: m.konfidenz, raw: f.raw, match: m.match };
      proCode.set(key, entry);
    }

    for (const v of visionFlach) {
      if (v.wert === null || v.wert === undefined || v.wert === '') continue;
      const letzterSeg = v.pfad.split('.').pop() || '';
      if (/^_\w/.test(letzterSeg)) continue;
      const m = mappeVisionKandidat(v, bmfLabelIndex, visionExtract);
      if (!m) {
        verworfen_vision.push({
          pfad: v.pfad,
          wert: v.wert,
          grund: 'kein beschreibung-Match im BMF-Katalog',
        });
        continue;
      }
      if (!erlaubt.has(m.anlage)) {
        verworfen_vision.push({
          pfad: v.pfad,
          wert: v.wert,
          grund: `Anlage ${m.anlage} nicht in erkannten Dokument-Anlagen`,
          kandidat_code: m.code,
        });
        continue;
      }
      // Personen-Kontext aus Vision-Pfad ziehen (personen.0 / personen.1 / _a / _b / rolle)
      let visionCtx: 'A' | 'B' | null = null;
      const segs = v.pfad.split('.');
      for (let idx = 0; idx < segs.length; idx++) {
        const s = segs[idx];
        if (/^a$|_a$|person_?a|ehemann|steuerpflichtig/i.test(s)) visionCtx = 'A';
        if (/^b$|_b$|person_?b|ehefrau|ehegatt/i.test(s)) visionCtx = 'B';
        if (s === 'personen' && idx + 1 < segs.length) {
          if (segs[idx + 1] === '0') visionCtx = 'A';
          else if (segs[idx + 1] === '1') visionCtx = 'B';
        }
      }
      const key = keyFuerCode(m.code, visionCtx);
      const entry: ProCodeEintrag = proCode.get(key) || {
        code: m.code,
        anlage: m.anlage,
        kontext: m.kontext,
        personen_ctx: visionCtx,
      };
      entry.vision = { wert: v.wert, konfidenz: m.konfidenz, pfad: v.pfad, match: m.match };
      proCode.set(key, entry);
    }

    // Kategorisiere: eindeutig / konflikt / unklarheit.
    const eindeutig: KurationsEintrag[] = [];
    const konflikte: KurationsEintrag[] = [];
    const unklarheiten: KurationsEintrag[] = [];

    for (const [mapKey, e] of proCode.entries()) {
      const code = e.code || mapKey.split('|')[0];
      const hatM = !!e.mistral;
      const hatV = !!e.vision;
      const mW = e.mistral?.wert ?? null;
      const vW = e.vision?.wert ?? null;
      const gleich = hatM && hatV && wertGleich(mW, vW);

      const eintrag: KurationsEintrag = {
        code,
        anlage: e.anlage,
        kontext: e.kontext,
        personen_ctx: e.personen_ctx,
        mistral: e.mistral || null,
        vision: e.vision || null,
      };

      if (hatM && hatV && gleich) {
        eintrag.wert = mW;
        eintrag.quelle = 'beide';
        eintrag.konfidenz = Math.max(e.mistral!.konfidenz, e.vision!.konfidenz);
        const val = bmfValidiereWert(code, String(mW), e.anlage);
        eintrag.bmf_regex_ok = val?.ok ?? null;
        if (val && !val.ok)
          unklarheiten.push({ ...eintrag, grund: 'BMF-Regex bricht', details: val.details });
        else eindeutig.push(eintrag);
      } else if (hatM && !hatV) {
        eintrag.wert = mW;
        eintrag.quelle = 'mistral';
        eintrag.konfidenz = e.mistral!.konfidenz;
        const val = bmfValidiereWert(code, String(mW), e.anlage);
        eintrag.bmf_regex_ok = val?.ok ?? null;
        if (val && !val.ok)
          unklarheiten.push({ ...eintrag, grund: 'BMF-Regex bricht', details: val.details });
        else eindeutig.push(eintrag);
      } else if (!hatM && hatV) {
        eintrag.wert = vW;
        eintrag.quelle = 'vision';
        eintrag.konfidenz = e.vision!.konfidenz;
        const val = bmfValidiereWert(code, String(vW), e.anlage);
        eintrag.bmf_regex_ok = val?.ok ?? null;
        if (val && !val.ok)
          unklarheiten.push({ ...eintrag, grund: 'BMF-Regex bricht', details: val.details });
        else eindeutig.push(eintrag);
      } else if (hatM && hatV && !gleich) {
        konflikte.push({
          ...eintrag,
          grund: 'Werte unterschiedlich',
          mistral_wert: mW,
          vision_wert: vW,
        });
      }
    }

    // Anlagen-Set aus eindeutig + konflikt + unklar
    const anlagenSet = new Set<string>();
    for (const e of [...eindeutig, ...konflikte, ...unklarheiten]) anlagenSet.add(e.anlage);

    // Optional: Post-Filter gegen User-seitig gewaehlte Anlagen. Traegt Eintraege,
    // deren Anlage nicht in gewaehlteAnlagen liegt, nach verworfen_anlage_nicht_erkannt
    // aus — ohne die Original-Kategorisierung oben zu veraendern.
    let verworfen_anlage_nicht_erkannt:
      | Array<KurationsEintrag & { kategorie: 'eindeutig' | 'konflikt' | 'unklarheit' }>
      | undefined;
    if (Array.isArray(gewaehlteAnlagen) && gewaehlteAnlagen.length > 0) {
      const erlaubteAnlagen = new Set(gewaehlteAnlagen);
      verworfen_anlage_nicht_erkannt = [];
      const filtere = <T extends KurationsEintrag>(
        arr: T[],
        kategorie: 'eindeutig' | 'konflikt' | 'unklarheit',
      ): T[] => {
        const behalten: T[] = [];
        for (const item of arr) {
          if (!erlaubteAnlagen.has(item.anlage)) {
            verworfen_anlage_nicht_erkannt!.push({ ...item, kategorie });
          } else {
            behalten.push(item);
          }
        }
        return behalten;
      };
      const gefiltertEindeutig = filtere(eindeutig, 'eindeutig');
      const gefiltertKonflikte = filtere(konflikte, 'konflikt');
      const gefiltertUnklarheiten = filtere(unklarheiten, 'unklarheit');
      eindeutig.length = 0;
      eindeutig.push(...gefiltertEindeutig);
      konflikte.length = 0;
      konflikte.push(...gefiltertKonflikte);
      unklarheiten.length = 0;
      unklarheiten.push(...gefiltertUnklarheiten);
      anlagenSet.clear();
      for (const e of [...eindeutig, ...konflikte, ...unklarheiten]) anlagenSet.add(e.anlage);
    }

    const result: RegelEngineOutput = {
      eindeutig,
      konflikte,
      unklarheiten,
      anlagen: [...anlagenSet],
      verworfen_mistral,
      verworfen_vision,
      alle_fundstellen_mistral: fundstellen,
      alle_fundstellen_vision: visionFlach.filter(
        (v) =>
          v.wert !== null &&
          v.wert !== '' &&
          !/^_\w/.test(v.pfad.split('.').pop() || ''),
      ),
      stats: {
        mistral_fundstellen: fundstellen.length,
        vision_kandidaten: visionFlach.length,
        eindeutig: eindeutig.length,
        konflikte: konflikte.length,
        unklarheiten: unklarheiten.length,
        verworfen_mistral: verworfen_mistral.length,
        verworfen_vision: verworfen_vision.length,
      },
    };
    if (verworfen_anlage_nicht_erkannt) {
      result.verworfen_anlage_nicht_erkannt = verworfen_anlage_nicht_erkannt;
    }

    ctx.emit('regel_stats', result.stats);
    // Volles Output zusaetzlich separat speichern — der Runner legt die primaere
    // output.json selbst an, aber fuer Debugging ist eine explizite Detail-Datei
    // mit allen Fundstellen + Verworfen-Arrays praktisch.
    await ctx.artifacts.write('regel-details.json', result);

    return result;
  },
});
