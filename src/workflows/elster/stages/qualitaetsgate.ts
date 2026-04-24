import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/haiku-chat.ts';
import { loadFelder, type FelderSchema } from '../lib/anlagen-katalog.ts';

type Feld = FelderSchema['felder'][number];

function extractableFelderLocal(all: Feld[]): Feld[] {
  return all.filter((f) => /^E\d+$/.test(f.Name));
}

type AnrWert = {
  eCode: string;
  anlage: string;
  wert: string;
  beschreibung?: string;
  drucktext?: string;
  vordruckzeile?: string;
  pflichtfeld?: boolean;
  format?: string;
  person?: 'A' | 'B' | string;
  person_label?: string;
};

type AnrOutput = {
  alle_werte: AnrWert[];
  summen?: { werte_gesamt: number; pflichtfelder_belegt: number };
  per_anlage?: Record<string, unknown>;
};

export interface QualitaetsgateInput {
  pages: Array<{ index: number; markdown: string; chars: number }>;
  anreicherung: AnrOutput;
  klassifizierung: { erkannte_anlagen: string[] };
  vz?: number | string;
}

export interface QualitaetsgateErgaenzung {
  eCode: string;
  anlage: string;
  wert: string;
  quelle_seite: number;
  beschreibung?: string;
  drucktext?: string;
  vordruckzeile?: string;
  pflichtfeld?: boolean;
  person?: 'A' | 'B' | string;
}

export interface QualitaetsgateOutput {
  vollstaendig: boolean;
  status: 'ok_vollstaendig' | 'ok_ergaenzt' | 'unklar' | 'fehler';
  ergaenzt: QualitaetsgateErgaenzung[];
  alle_werte_merged: AnrWert[];
  summen: { werte_vorher: number; werte_nachher: number; ergaenzt: number };
  verworfen: Array<{ eCode: string; anlage: string; grund: string }>;
  ms: number;
  calls: number;
  error?: string;
}

export interface QualitaetsgateConfig {
  model?: string;
  maxCharsProSeite?: number;
  maxFelderProAnlage?: number;
  temperature?: number;
  chunkSchwelle?: number;
}

function resolveConfig(c: QualitaetsgateConfig): Required<QualitaetsgateConfig> {
  return {
    model: c.model ?? 'claude-haiku-4-5',
    maxCharsProSeite: c.maxCharsProSeite ?? 4000,
    maxFelderProAnlage: c.maxFelderProAnlage ?? 200,
    temperature: c.temperature ?? 0,
    chunkSchwelle: c.chunkSchwelle ?? 3,
  };
}

async function buildFeldKatalogKompakt(
  anlagen: string[],
  vz: number | string | undefined,
  maxFelderProAnlage: number,
): Promise<Record<string, Array<{ eCode: string; drucktext: string; zeile?: string }>>> {
  const out: Record<string, Array<{ eCode: string; drucktext: string; zeile?: string }>> = {};
  for (const name of anlagen) {
    try {
      const raw = await loadFelder(name, vz);
      const felder = extractableFelderLocal(raw.felder).slice(0, maxFelderProAnlage);
      out[name] = felder.map((f: any) => ({
        eCode: String(f.Name),
        drucktext: String(f.Drucktext || f.Beschreibung || '').slice(0, 100),
        zeile: f.Vordruckzeile ? String(f.Vordruckzeile) : undefined,
      }));
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[qualitaetsgate] katalog-build fehlgeschlagen für ${name} (vz=${vz}): ${e?.message ?? e}`);
      out[name] = [];
    }
  }
  return out;
}

function buildGatePrompt(
  anlagenSubset: string[],
  pages: Array<{ index: number; markdown: string }>,
  aktuelleWerteAnlagen: AnrWert[],
  katalog: Record<string, Array<{ eCode: string; drucktext: string; zeile?: string }>>,
  maxCharsProSeite: number,
): string {
  const werteKompakt = aktuelleWerteAnlagen.map((w) => ({
    anlage: w.anlage,
    person: w.person || 'A',
    eCode: w.eCode,
    wert: w.wert,
    drucktext: (w.drucktext || w.beschreibung || '').slice(0, 80),
  }));

  const katalogKompakt = anlagenSubset
    .map((a) => {
      const felder = katalog[a] || [];
      const zeilen = felder
        .map((f) => `  ${f.eCode}${f.zeile ? ` (Z${f.zeile})` : ''}: ${f.drucktext}`)
        .join('\n');
      return `### ${a}\n${zeilen}`;
    })
    .join('\n\n');

  const seitenBlock = pages
    .map(
      (p) =>
        `--- SEITE ${(p.index ?? 0) + 1} ---\n${(p.markdown || '').slice(0, maxCharsProSeite)}`,
    )
    .join('\n\n');

  return [
    'Du bist Qualitätsprüfer für ELSTER-Steuerformular-Extraktion.',
    '',
    `ZU PRÜFENDE ANLAGEN: ${anlagenSubset.join(', ')}`,
    '',
    'SCHON EXTRAHIERT (JSON):',
    JSON.stringify(werteKompakt),
    '',
    'KATALOG — NUR DIESE eCODES SIND ERLAUBT:',
    katalogKompakt,
    '',
    'DOKUMENT-ROHTEXT:',
    seitenBlock,
    '',
    'AUFGABE:',
    'Finde konkrete Werte (Zahlen, Beträge, Daten, Namen, IBANs, StNr, etc.),',
    'die im Rohtext stehen, zu einer der ZU PRÜFENDEN ANLAGEN gehören,',
    'einem eCode aus dem KATALOG entsprechen, und NICHT in SCHON EXTRAHIERT sind.',
    '',
    'REGELN:',
    '1. NUR eCodes aus dem KATALOG (exakt mit E-Präfix abschreiben).',
    '2. NUR Werte, die tatsächlich im Rohtext stehen (kein Raten).',
    '3. Dublette = SELBER eCode UND SELBER Wert. Ein gleicher eCode mit einem ANDEREN Wert ist KEINE Dublette!',
    '   Das passiert häufig bei Ehegatten-Veranlagung: Anlage KAP, Anlage N, Anlage AV etc.',
    '   kommen in der Steuererklärung ZWEIMAL vor (Person A / Ehemann und Person B / Ehefrau).',
    '   Beispiel: Person A hat E1904701 (Kapitalertragsteuer) = 26,69 €. Person B hat E1904701 = 1,99 €.',
    '   BEIDE sind gültig und müssen ergänzt werden, wenn der Rohtext "Anlage KAP (Ehefrau / Person B)" enthält.',
    '4. Achte auf Markierungen wie "(Ehefrau / Person B)", "(Ehemann / Person A)", "Person A", "Person B" im Rohtext.',
    '   Wenn du siehst, dass eine Anlage zweimal vorkommt, ergänze die fehlenden Werte der zweiten Person.',
    '5. "quelle_seite" ist 1-basiert und entspricht SEITE X.',
    '',
    'Antwort STRIKT als JSON:',
    '{"ergaenzt": [{"eCode":"E...","anlage":"...","person":"A" oder "B","wert":"...","quelle_seite":1}]}',
    '',
    'person: "A" = Ehemann / Steuerpflichtige Person / einzig; "B" = Ehefrau.',
    'Wenn nicht klar erkennbar, lass person weg (Default "A").',
    '',
    'Wenn nichts zu ergänzen ist: {"ergaenzt": []}',
  ].join('\n');
}

function chunkAnlagen(anlagen: string[], schwelle: number): string[][] {
  if (anlagen.length <= schwelle) return [anlagen];
  const chunks: string[][] = [];
  for (let i = 0; i < anlagen.length; i += schwelle) {
    chunks.push(anlagen.slice(i, i + schwelle));
  }
  return chunks;
}

export const qualitaetsgateStage = defineStage<
  QualitaetsgateInput,
  QualitaetsgateOutput,
  QualitaetsgateConfig
>({
  id: 'elster/qualitaetsgate',
  name: 'Qualitätsgate v2 (Haiku-Repair, chunked)',
  description:
    'Haiku vergleicht Seiten-Rohtexte mit extrahierten Werten und ergänzt ' +
    'fehlende eCode-Werte. Bei vielen Anlagen chunked. Persistiert raw LLM ' +
    'responses und verworfene Vorschläge zum Debugging.',
  async run(input, ctx) {
    const config = resolveConfig(ctx.config ?? {});
    const t0 = Date.now();

    const anlagen = input.klassifizierung?.erkannte_anlagen || [];
    const aktuelleWerte: AnrWert[] = input.anreicherung?.alle_werte || [];
    const pages = input.pages || [];
    const vz = input.vz;

    ctx.emit('gate_start', {
      werte_vorher: aktuelleWerte.length,
      anlagen_anzahl: anlagen.length,
      seiten: pages.length,
    });

    if (anlagen.length === 0 || pages.length === 0) {
      const out: QualitaetsgateOutput = {
        vollstaendig: true,
        status: 'ok_vollstaendig',
        ergaenzt: [],
        alle_werte_merged: aktuelleWerte,
        summen: { werte_vorher: aktuelleWerte.length, werte_nachher: aktuelleWerte.length, ergaenzt: 0 },
        verworfen: [],
        calls: 0,
        ms: Date.now() - t0,
      };
      ctx.emit('gate_done', { ...out.summen, status: out.status });
      return out;
    }

    const katalog = await buildFeldKatalogKompakt(
      anlagen,
      vz,
      config.maxFelderProAnlage,
    );

    // Log katalog-size pro Anlage damit wir im Artefakt sehen, was Haiku zu sehen bekommt
    const katalogSizes: Record<string, number> = {};
    for (const [a, felder] of Object.entries(katalog)) katalogSizes[a] = felder.length;
    ctx.emit('gate_katalog', { vz, sizes: katalogSizes });

    const chunks = chunkAnlagen(anlagen, config.chunkSchwelle);
    const ergaenzt: QualitaetsgateErgaenzung[] = [];
    const verworfen: Array<{ eCode: string; anlage: string; grund: string }> = [];
    // Zwei Dubletten-Keys:
    // 1. anlage + eCode + wert  (exakte Dublette)
    // 2. anlage + zeile + wert  (Slot-Dublette: ELSTER hat oft mehrere eCodes
    //    für dieselbe Vordruckzeile, z.B. E0200201 / E0200204 / E0200207 für
    //    Z5 Bruttoarbeitslohn. Wenn Person A's Wert schon drin ist und Haiku
    //    einen anderen eCode für dieselbe Zeile + denselben Wert vorschlägt,
    //    ist das eine Slot-Redundanz.)
    //
    // Ehegatten-Veranlagung: Anlage KAP kommt zweimal vor. Gleiche Zeile,
    // aber UNTERSCHIEDLICHER Wert = keine Dublette (Person B).
    const bekannt = new Set(aktuelleWerte.map((w) => `${w.anlage}:${w.eCode}:${w.wert}`));
    const slotBelegt = new Set(
      aktuelleWerte
        .filter((w) => w.vordruckzeile)
        .map((w) => `${w.anlage}:Z${w.vordruckzeile}:${w.wert}`),
    );
    const rawResponses: Array<{ chunk: string[]; raw: string }> = [];
    let error: string | undefined;
    let calls = 0;

    // Parallelisierung: alle Chunks gleichzeitig zu Haiku schicken.
    // Erspart bei 7 Anlagen / 3-er-Chunks etwa 2/3 der Gate-Zeit.
    calls = chunks.length;
    type ChunkRes = {
      chunk: string[];
      parsed: { ergaenzt?: Array<{ eCode?: string; anlage?: string; wert?: string; quelle_seite?: number }> };
      raw: string;
      err: string | null;
    };
    const chunkResults: ChunkRes[] = await Promise.all(
      chunks.map(async (chunk): Promise<ChunkRes> => {
        const werteFürChunk = aktuelleWerte.filter((w) => chunk.includes(w.anlage));
        try {
          const prompt = buildGatePrompt(chunk, pages, werteFürChunk, katalog, config.maxCharsProSeite);
          const r = await chatJson<{
            ergaenzt?: Array<{ eCode?: string; anlage?: string; wert?: string; quelle_seite?: number }>;
          }>(prompt, {
            model: config.model,
            temperature: config.temperature,
            signal: ctx.signal,
            maxTokens: 3000,
          });
          return { chunk, parsed: r.parsed, raw: r.raw, err: null };
        } catch (e: any) {
          return { chunk, parsed: { ergaenzt: [] }, raw: '', err: String(e?.message ?? e) };
        }
      }),
    );

    for (const r of chunkResults) {
      const { chunk, parsed, raw, err } = r;
      if (err) {
        error = err;
        ctx.emit('gate_error', { chunk, message: err });
        continue;
      }
      rawResponses.push({ chunk, raw: raw.slice(0, 4000) });

      const vorschlaege = Array.isArray(parsed.ergaenzt) ? parsed.ergaenzt : [];
        for (const v of vorschlaege) {
          if (!v?.eCode || !v?.anlage || v?.wert == null) {
            verworfen.push({ eCode: String(v?.eCode ?? '?'), anlage: String(v?.anlage ?? '?'), grund: 'unvollstaendig' });
            continue;
          }
          if (!chunk.includes(v.anlage)) {
            verworfen.push({ eCode: v.eCode, anlage: v.anlage, grund: 'anlage_nicht_im_chunk' });
            continue;
          }
          const key = `${v.anlage}:${v.eCode}:${v.wert}`;
          if (bekannt.has(key)) {
            verworfen.push({ eCode: v.eCode, anlage: v.anlage, grund: 'dublette' });
            continue;
          }
          const kat = katalog[v.anlage] || [];
          const feld = kat.find((f) => f.eCode === v.eCode);
          if (!feld) {
            verworfen.push({ eCode: v.eCode, anlage: v.anlage, grund: 'eCode_nicht_im_katalog' });
            continue;
          }
          // Slot-Redundanz: derselbe Wert steckt schon in einem anderen eCode derselben Zeile
          if (feld.zeile) {
            const slotKey = `${v.anlage}:Z${feld.zeile}:${v.wert}`;
            if (slotBelegt.has(slotKey)) {
              verworfen.push({ eCode: v.eCode, anlage: v.anlage, grund: 'slot_redundant' });
              continue;
            }
            slotBelegt.add(slotKey);
          }
          bekannt.add(key);
          const e: QualitaetsgateErgaenzung = {
            eCode: v.eCode,
            anlage: v.anlage,
            wert: String(v.wert),
            quelle_seite: Number(v.quelle_seite) || 0,
            drucktext: feld.drucktext,
            vordruckzeile: feld.zeile,
            beschreibung: feld.drucktext,
            person: typeof (v as any).person === 'string' ? (v as any).person.toUpperCase() : undefined,
          };
        ergaenzt.push(e);
        ctx.emit('gate_ergaenzung', e);
      }
    }

    // Merge
    const alleMerged: AnrWert[] = [
      ...aktuelleWerte,
      ...ergaenzt.map((e) => ({
        eCode: e.eCode,
        anlage: e.anlage,
        wert: e.wert,
        beschreibung: e.beschreibung,
        drucktext: e.drucktext,
        vordruckzeile: e.vordruckzeile,
        pflichtfeld: e.pflichtfeld,
        person: e.person,
      })),
    ];

    // Status: klare Semantik
    let status: QualitaetsgateOutput['status'];
    if (error) status = 'fehler';
    else if (ergaenzt.length > 0) status = 'ok_ergaenzt';
    else if (verworfen.length === 0) status = 'ok_vollstaendig';
    else status = 'unklar'; // LLM schlug was vor, aber wir haben alles verworfen

    const out: QualitaetsgateOutput = {
      vollstaendig: status === 'ok_vollstaendig',
      status,
      ergaenzt,
      alle_werte_merged: alleMerged,
      summen: {
        werte_vorher: aktuelleWerte.length,
        werte_nachher: alleMerged.length,
        ergaenzt: ergaenzt.length,
      },
      verworfen,
      calls,
      ms: Date.now() - t0,
      ...(error ? { error } : {}),
    };

    ctx.emit('gate_done', {
      ...out.summen,
      status: out.status,
      vollstaendig: out.vollstaendig,
      calls,
      verworfen: verworfen.length,
      ms: out.ms,
    });

    await ctx.artifacts.write('qualitaetsgate/result.json', out);
    await ctx.artifacts.write('qualitaetsgate/raw_responses.json', rawResponses);
    return out;
  },
});
