import { defineStage } from '../../../core/stage.ts';
import { loadFelder } from '../lib/anlagen-katalog.ts';

export interface AnreicherungInput {
  per_anlage: Record<string, {
    anlage: string;
    fieldCount: number;
    filled: number;
    /** Legacy: Werte für Person A */
    values: Record<string, string | null>;
    /** Multi-Instanz: Person A + Person B bei Ehegatten-Veranlagung */
    instances?: Array<{
      person: 'A' | 'B' | string;
      label?: string;
      values: Record<string, string | null>;
    }>;
    durationMs: number;
    error?: string;
  }>;
  vz?: number | string;
}

export interface AngereicherterWert {
  eCode: string;
  wert: string;
  beschreibung: string;
  drucktext: string;
  vordruckzeile: string | null;
  format: string | null;
  pflichtfeld: boolean;
  /** 'A' = Ehemann/einzig; 'B' = Ehefrau. Für Einzelveranlagung immer 'A'. */
  person?: 'A' | 'B' | string;
  /** Label wie 'Ehemann' / 'Ehefrau' / 'Person A' / ... */
  person_label?: string;
}

export interface AnreicherungOutput {
  /** Pro Anlage: nur die belegten Werte, mit Elster-Metadaten angereichert. */
  per_anlage: Record<string, {
    anlage: string;
    belegte_werte: AngereicherterWert[];
    unbelegt: string[];
  }>;
  /** Flache Liste aller belegten Werte über alle Anlagen hinweg. */
  alle_werte: Array<AngereicherterWert & { anlage: string }>;
  /** Summen für den UI-Header. */
  summen: {
    werte_gesamt: number;
    anlagen_belegt: number;
    pflichtfelder_belegt: number;
  };
}

/**
 * Nimmt die Per-Anlage-Extraktion und reichert jedes belegte Feld mit den
 * Elster-Metadaten aus dem Felder-Katalog an (Beschreibung, Drucktext,
 * Vordruckzeile, Pflichtfeld, Format). Erzeugt selbstsprechendes JSON.
 */
export const anreicherungStage = defineStage<
  AnreicherungInput,
  AnreicherungOutput,
  Record<string, unknown>
>({
  id: 'elster/anreicherung',
  name: 'Elster-Metadaten anreichern',
  description:
    'Reichert jeden belegten eCode mit Beschreibung, Drucktext, Vordruckzeile, Pflichtfeld und Format aus dem Elster-Felder-Katalog an. Output ist selbstsprechendes JSON, direkt UI-tauglich.',

  async run(input, ctx) {
    const vz = input.vz;
    const perAnlage: AnreicherungOutput['per_anlage'] = {};
    const alleWerte: AnreicherungOutput['alle_werte'] = [];
    let pflichtBelegt = 0;
    let anlagenBelegt = 0;

    for (const [anlage, result] of Object.entries(input.per_anlage)) {
      if (!result || result.error) {
        perAnlage[anlage] = { anlage, belegte_werte: [], unbelegt: [] };
        continue;
      }

      const felderSchema = await loadFelder(anlage, vz).catch(() => null);
      const feldLookup = new Map<string, any>();
      if (felderSchema) {
        for (const f of felderSchema.felder) feldLookup.set(f.Name, f);
      }

      const belegte: AngereicherterWert[] = [];
      const unbelegtSet = new Set<string>();

      // Instanzen-Liste ermitteln: bevorzugt result.instances, sonst legacy result.values als A
      const instances = (Array.isArray(result.instances) && result.instances.length > 0)
        ? result.instances
        : [{ person: 'A' as const, label: undefined, values: result.values ?? {} }];

      for (const inst of instances) {
        const person = String(inst.person || 'A').toUpperCase();
        const label = inst.label;
        for (const [eCode, wert] of Object.entries(inst.values ?? {})) {
          const feld = feldLookup.get(eCode);
          const beschreibung = feld?.Beschreibung || feld?.Drucktext || eCode;
          const drucktext = feld?.Drucktext || feld?.Beschreibung || eCode;
          const vordruckzeile = feld?.Vordruckzeile || null;
          const format = feld?.Formatkennzeichen || feld?.Format || null;
          const pflichtfeld = Boolean(feld?.pflicht);

          if (wert !== null && wert !== undefined && String(wert).trim() !== '') {
            const angereichert: AngereicherterWert = {
              eCode,
              wert: String(wert),
              beschreibung,
              drucktext,
              vordruckzeile,
              format,
              pflichtfeld,
              person,
              person_label: label,
            };
            belegte.push(angereichert);
            alleWerte.push({ ...angereichert, anlage });
            if (pflichtfeld) pflichtBelegt += 1;
          } else {
            unbelegtSet.add(eCode);
          }
        }
      }

      // eCode gilt als unbelegt nur wenn er in KEINER Instanz belegt war
      const belegteCodes = new Set(belegte.map((b) => b.eCode));
      const unbelegt = [...unbelegtSet].filter((e) => !belegteCodes.has(e));

      if (belegte.length > 0) anlagenBelegt += 1;

      perAnlage[anlage] = { anlage, belegte_werte: belegte, unbelegt };
      await ctx.artifacts.write(`anreicherung/${anlage}.json`, perAnlage[anlage]);
      ctx.emit('anlage_angereichert', {
        anlage,
        werte: belegte.length,
        unbelegt: unbelegt.length,
        instanzen: instances.length,
      });
    }

    const summen = {
      werte_gesamt: alleWerte.length,
      anlagen_belegt: anlagenBelegt,
      pflichtfelder_belegt: pflichtBelegt,
    };

    ctx.emit('anreicherung_done', summen);

    return { per_anlage: perAnlage, alle_werte: alleWerte, summen };
  },
});
