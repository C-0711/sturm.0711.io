import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/haiku-chat.ts';
import { loadFelder, type FelderSchema } from '../lib/anlagen-katalog.ts';

type Feld = FelderSchema['felder'][number];

function extractableFelderLocal(all: Feld[]): Feld[] {
  // Same predicate as extraktion.ts: only real eCodes (E + digits).
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
}

export interface QualitaetsgateOutput {
  vollstaendig: boolean;
  ergaenzt: QualitaetsgateErgaenzung[];
  alle_werte_merged: AnrWert[];
  summen: { werte_vorher: number; werte_nachher: number; ergaenzt: number };
  ms: number;
  error?: string;
}

export interface QualitaetsgateConfig {
  model?: string;
  maxCharsProSeite?: number;
  maxAnlagen?: number;
  temperature?: number;
  vz?: number | string;
}

function resolveConfig(c: QualitaetsgateConfig): Required<QualitaetsgateConfig> {
  return {
    model: c.model ?? 'claude-haiku-4-5',
    maxCharsProSeite: c.maxCharsProSeite ?? 5000,
    maxAnlagen: c.maxAnlagen ?? 7,
    temperature: c.temperature ?? 0,
    vz: (c as any).vz ?? '',
  };
}

/**
 * Baut pro Anlage einen kompakten eCode-Katalog-Auszug (eCode + Drucktext),
 * damit Haiku beim Nachmergen auf reale eCodes mappen kann.
 */
async function buildFeldKatalogKompakt(
  anlagen: string[],
  vz: number | string | undefined,
  maxFelderProAnlage = 80,
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
    } catch {
      out[name] = [];
    }
  }
  return out;
}

function buildGatePrompt(
  anlagen: string[],
  pages: Array<{ index: number; markdown: string }>,
  aktuelleWerte: AnrWert[],
  katalog: Record<string, Array<{ eCode: string; drucktext: string; zeile?: string }>>,
  maxCharsProSeite: number,
): string {
  const werteKompakt = aktuelleWerte.map((w) => ({
    anlage: w.anlage,
    eCode: w.eCode,
    wert: w.wert,
    drucktext: (w.drucktext || w.beschreibung || '').slice(0, 80),
  }));

  const katalogKompakt = Object.entries(katalog)
    .map(([anlage, felder]) => {
      const zeilen = felder
        .map((f) => `  - ${f.eCode}${f.zeile ? ` (Z${f.zeile})` : ''}: ${f.drucktext}`)
        .join('\n');
      return `${anlage}:\n${zeilen}`;
    })
    .join('\n\n');

  const seitenBlock = pages
    .map(
      (p) =>
        `=== SEITE ${(p.index ?? 0) + 1} ===\n${(p.markdown || '').slice(0, maxCharsProSeite)}`,
    )
    .join('\n\n');

  return [
    'Du bist Qualitätsprüfer für eine ELSTER-Steuerformular-Extraktion.',
    '',
    'ERKANNTE ANLAGEN: ' + anlagen.join(', '),
    '',
    'AKTUELL EXTRAHIERTE WERTE (JSON):',
    JSON.stringify(werteKompakt, null, 2),
    '',
    'KATALOG DER MÖGLICHEN FELDER PRO ANLAGE (eCode + Beschreibung):',
    katalogKompakt,
    '',
    'SEITEN-ROHTEXT DES DOKUMENTS:',
    seitenBlock,
    '',
    'AUFGABE:',
    'Prüfe, ob im Seiten-Rohtext KONKRETE WERTE stehen (Zahlen, €-Beträge, Daten, Namen, IBANs, StNr),',
    'die im EXTRAHIERTEN-WERTE-JSON fehlen, aber zu einem eCode aus dem Katalog passen.',
    '',
    'Für jede Lücke liefere:',
    '  { "eCode": "<aus Katalog>", "anlage": "<Name>", "wert": "<exakter Wert aus Rohtext>", "quelle_seite": <1-basiert> }',
    '',
    'Regeln:',
    '- NUR eCodes verwenden, die oben im Katalog stehen.',
    '- NUR Werte vorschlagen, die tatsächlich im Seiten-Rohtext auftauchen.',
    '- Keine Dubletten mit AKTUELL EXTRAHIERTEN WERTEN.',
    '- Wenn alles vollständig extrahiert ist: ergaenzt = [] und vollstaendig=true.',
    '',
    'Antwort STRIKT als JSON (nichts anderes):',
    '{"vollstaendig": boolean, "ergaenzt": [{"eCode": "...", "anlage": "...", "wert": "...", "quelle_seite": 1}]}',
  ].join('\n');
}

export const qualitaetsgateStage = defineStage<
  QualitaetsgateInput,
  QualitaetsgateOutput,
  QualitaetsgateConfig
>({
  id: 'elster/qualitaetsgate',
  name: 'Qualitätsgate (Haiku-Repair)',
  description:
    'Haiku vergleicht die Seiten-Rohtexte mit den extrahierten Werten und ' +
    'ergänzt fehlende eCode-Werte automatisch anhand des Felder-Katalogs. ' +
    'Merged die neuen Werte in alle_werte_merged.',
  async run(input, ctx) {
    const config = resolveConfig(ctx.config ?? {});
    const t0 = Date.now();

    const anlagen = (input.klassifizierung?.erkannte_anlagen || []).slice(
      0,
      config.maxAnlagen,
    );
    const aktuelleWerte: AnrWert[] = input.anreicherung?.alle_werte || [];
    const pages = input.pages || [];

    ctx.emit('gate_start', {
      werte_vorher: aktuelleWerte.length,
      anlagen_anzahl: anlagen.length,
      seiten: pages.length,
    });

    if (anlagen.length === 0 || pages.length === 0) {
      const out: QualitaetsgateOutput = {
        vollstaendig: true,
        ergaenzt: [],
        alle_werte_merged: aktuelleWerte,
        summen: {
          werte_vorher: aktuelleWerte.length,
          werte_nachher: aktuelleWerte.length,
          ergaenzt: 0,
        },
        ms: Date.now() - t0,
      };
      ctx.emit('gate_done', out.summen);
      return out;
    }

    let ergaenzt: QualitaetsgateErgaenzung[] = [];
    let vollstaendig = true;
    let error: string | undefined;

    try {
      const katalog = await buildFeldKatalogKompakt(anlagen, config.vz);
      const prompt = buildGatePrompt(
        anlagen,
        pages,
        aktuelleWerte,
        katalog,
        config.maxCharsProSeite,
      );

      const { parsed } = await chatJson<{
        vollstaendig?: boolean;
        ergaenzt?: Array<{ eCode?: string; anlage?: string; wert?: string; quelle_seite?: number }>;
      }>(prompt, {
        model: config.model,
        temperature: config.temperature,
        signal: ctx.signal,
        maxTokens: 4000,
      });

      vollstaendig = parsed.vollstaendig === true;
      const vorschlaege = Array.isArray(parsed.ergaenzt) ? parsed.ergaenzt : [];

      // Validate + dedupe
      const bekannt = new Set(aktuelleWerte.map((w) => `${w.anlage}:${w.eCode}`));
      for (const v of vorschlaege) {
        if (!v?.eCode || !v?.anlage || !v?.wert) continue;
        const key = `${v.anlage}:${v.eCode}`;
        if (bekannt.has(key)) continue;
        bekannt.add(key);
        const kat = katalog[v.anlage] || [];
        const feld = kat.find((f) => f.eCode === v.eCode);
        // only accept eCodes that live in the catalog
        if (!feld) continue;
        const e: QualitaetsgateErgaenzung = {
          eCode: v.eCode,
          anlage: v.anlage,
          wert: String(v.wert),
          quelle_seite: Number(v.quelle_seite) || 0,
          drucktext: feld.drucktext,
          vordruckzeile: feld.zeile,
          beschreibung: feld.drucktext,
        };
        ergaenzt.push(e);
        ctx.emit('gate_ergaenzung', e);
      }
    } catch (e: any) {
      error = String(e?.message ?? e);
      vollstaendig = false;
      ctx.emit('gate_error', { message: error });
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
      })),
    ];

    const out: QualitaetsgateOutput = {
      vollstaendig: vollstaendig && ergaenzt.length === 0,
      ergaenzt,
      alle_werte_merged: alleMerged,
      summen: {
        werte_vorher: aktuelleWerte.length,
        werte_nachher: alleMerged.length,
        ergaenzt: ergaenzt.length,
      },
      ms: Date.now() - t0,
      ...(error ? { error } : {}),
    };

    ctx.emit('gate_done', {
      ...out.summen,
      vollstaendig: out.vollstaendig,
      ms: out.ms,
    });

    await ctx.artifacts.write('qualitaetsgate/result.json', out);
    return out;
  },
});
