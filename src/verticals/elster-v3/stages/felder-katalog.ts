/**
 * elster-v4/felder-katalog — pure Container-Lookup, kein LLM-Call.
 *
 * Input:  erkannte_anlagen[] aus elster/klassifizierung
 * Output: per_anlage map mit allen Atomen aus atoms.json je Anlage
 *
 * Diese Stage wandelt die regex-erkannten Anlagen in eine vollständige
 * Felder-Spezifikation um — single-source-of-truth aus dem Container
 * (`src/verticals/elster-v3/data/atoms.json`). Kein paralleler felder/*.json
 * Cache, kein Drift-Risiko.
 *
 * Output-Shape ist Input für elster-v4/container-extract.
 */
import { defineStage } from '../../../core/stage.ts';
import {
  felderFuerAnlage,
  einkunftsartVonAtom,
  type AnlagenFeld,
  type AnlagenFelderListe,
  type CatalogAtom,
} from '../../../lib/elster-catalog.ts';
import type { CatalogHandle } from '../../../core/tools/handles.ts';

/**
 * P7-Hilfsfunktion: baut die AnlagenFelderListe aus einem rohen Atoms-Array.
 * Mirrors die Sortier-/Filter-Logik aus `felderFuerAnlage` in elster-catalog.ts
 * — wir replizieren sie hier, damit der ctx.tools-Pfad ohne den modulscope
 * loadCatalog auskommt. Bug-Fixes hier müssen synchron in beiden Pfaden landen.
 */
function felderFromAtoms(atoms: CatalogAtom[], anlage: string): AnlagenFelderListe {
  const inAnlage = atoms.filter((a) => a.metadata.anlage === anlage);
  const felder: AnlagenFeld[] = inAnlage
    .filter((a) => /^E\d+$/.test(a.field_name))
    .map((a) => ({
      eCode: a.field_name,
      drucktext: a.metadata.drucktext || a.value || a.field_name,
      bezeichnung: a.value,
      datentyp: a.metadata.datentyp,
      formatRegex: a.metadata.formatRegex,
      pflicht: a.metadata.pflicht,
      vordruckzeile: a.metadata.vordruckzeile,
      einkunftsart: einkunftsartVonAtom(a),
      maxLaenge: a.metadata.maxLaenge,
      minLaenge: a.metadata.minLaenge,
    }));
  felder.sort((a, b) => {
    if (a.pflicht !== b.pflicht) return a.pflicht ? -1 : 1;
    const za = Number(a.vordruckzeile) || Number.MAX_SAFE_INTEGER;
    const zb = Number(b.vordruckzeile) || Number.MAX_SAFE_INTEGER;
    if (za !== zb) return za - zb;
    return a.eCode.localeCompare(b.eCode);
  });
  return { anlage, felder };
}

export interface FelderKatalogInput {
  /** Anlagen-Codes von elster/klassifizierung, z.B. ["N","VOR","SA"]. */
  erkannte_anlagen: string[];
}

export interface FelderKatalogOutput {
  per_anlage: Record<string, AnlagenFelderListe>;
  total_felder: number;
  total_pflicht: number;
  ms: number;
}

export const felderKatalogStage = defineStage<
  FelderKatalogInput,
  FelderKatalogOutput,
  Record<string, never>
>({
  id: 'elster-v4/felder-katalog',
  name: 'Felder-Katalog — Container-Lookup pro Anlage',
  description:
    'Pure read-only Stage: nimmt die regex-erkannten Anlagen und löst sie ' +
    'gegen den ELSTER-Quantum-Container (atoms.json) auf. Liefert pro Anlage ' +
    'eine sortierte Felder-Liste (Pflicht zuerst, dann nach Vordruckzeile) ' +
    'mit voller Atom-Metadata (eCode, drucktext, datentyp, formatRegex, ' +
    'pflicht, vordruckzeile, einkunftsart). Kein LLM-Call.',
  hints: {
    inputs: 'erkannte_anlagen[] (von elster/klassifizierung)',
    outputs: 'per_anlage map mit AnlagenFelderListe pro Anlage + total_felder/total_pflicht/ms',
    configExample: '{}',
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'erkannte_anlagen', type: 'json', description: 'String-Array von Anlagen-Codes' },
    ],
    outputPorts: [
      { name: 'per_anlage', type: 'json', description: 'Anlage→AnlagenFelderListe' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const anlagen = Array.isArray(input.erkannte_anlagen) ? input.erkannte_anlagen : [];
    if (anlagen.length === 0) {
      return { per_anlage: {}, total_felder: 0, total_pflicht: 0, ms: Date.now() - t0 };
    }

    // P7: bevorzuge ctx.tools.get('elster-catalog') wenn die Anwendung den
    // Catalog gebunden hat. Fallback auf felderFuerAnlage (modul-scope cache).
    const cat = ctx.tools.has('elster-catalog')
      ? ctx.tools.get<CatalogHandle>('elster-catalog')
      : null;
    const atomsFromCat = cat ? cat.get<CatalogAtom[]>('atoms') : null;

    const per_anlage: Record<string, AnlagenFelderListe> = {};
    let total = 0;
    let totalPflicht = 0;
    for (const anlage of anlagen) {
      const liste = atomsFromCat
        ? felderFromAtoms(atomsFromCat, anlage)
        : await felderFuerAnlage(anlage);
      per_anlage[anlage] = liste;
      total += liste.felder.length;
      totalPflicht += liste.felder.filter((f) => f.pflicht).length;
      ctx.emit('felder_katalog_anlage', {
        anlage,
        feldCount: liste.felder.length,
        pflichtCount: liste.felder.filter((f) => f.pflicht).length,
      });
    }
    await ctx.artifacts.write('felder_katalog.json', per_anlage);
    ctx.emit('felder_katalog_done', {
      anlagen: anlagen.length,
      total_felder: total,
      total_pflicht: totalPflicht,
    });

    return { per_anlage, total_felder: total, total_pflicht: totalPflicht, ms: Date.now() - t0 };
  },
});
