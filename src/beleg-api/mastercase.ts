/**
 * Beleg-API — Master-Case-Aggregator.
 *
 * Liest ALLE BelegResults eines Falls (ausgang/<Fall>/*.json) und aggregiert
 * sie zu EINER Master-Datei (mastercase_<Fall>.json):
 *   jahre → personen → elsterWerte   (+ abgeleiteter engineInput für :12015)
 *   vergleich        (erstes vs letztes Jahr je e_code, sortiert nach |Δ|)
 *   fehlende_belege  (Dokumenttyp in einem Jahr vorhanden, im anderen nicht)
 *
 * Deterministisch, kein LLM. Numerische Mehrfach-Beiträge desselben e_codes
 * pro (Person,Jahr) werden summiert (v1-Strategie).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BelegConfig } from './config.ts';
import { ausgangDirFuer, fallSlug } from './schreiber.ts';
import { zuZahl } from './datentyp.ts';
import {
  BelegResult, FehlenderBeleg, MasterCase, MasterJahr, MasterPerson, Position, VergleichZeile,
} from './typen.ts';

type Skalar = number | string | boolean | null;

async function leseResults(c: BelegConfig, fall: string): Promise<BelegResult[]> {
  const dir = ausgangDirFuer(c, fall);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: BelegResult[] = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('mastercase_')) continue;
    try {
      const r = JSON.parse(await fs.readFile(path.join(dir, n), 'utf-8')) as BelegResult;
      if (r && r.schema === 'beleg-result/v1') out.push(r);
    } catch { /* defekte Datei überspringen */ }
  }
  return out;
}

function personKey(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim() || '∅';
}
function jahrKey(j: number | null | undefined): string | null {
  return typeof j === 'number' && Number.isFinite(j) ? String(j) : null;
}

interface PersonAkk {
  name: string | null;
  rolleHint?: 'A' | 'B';
  idnr: string | null;
  anlagen: Set<string>;
  belege: Set<string>;
  codeWerte: Map<string, Skalar[]>;
  codeDatentyp: Map<string, string>;
}

/** Nur monetäre Datentypen werden summiert. Alles andere (idnr, date, enum,
 *  bool, string) nimmt den letzten nicht-leeren Wert — sonst würden z. B.
 *  Identifikationsnummern numerisch aufaddiert (→ Unsinn). */
const BETRAG_TYPEN = new Set(['int_euro', 'int_nn_euro', 'decimal_eur_cent']);
function istBetrag(datentyp: string | undefined): boolean {
  return !!datentyp && BETRAG_TYPEN.has(datentyp);
}
function aggregiere(werte: Skalar[], datentyp?: string): Skalar {
  if (istBetrag(datentyp)) {
    const zahlen = werte.map(zuZahl).filter((n): n is number => n !== null);
    if (zahlen.length > 0) return Math.round(zahlen.reduce((a, b) => a + b, 0) * 100) / 100;
  }
  const nonNull = werte.filter((w) => w !== null && w !== '');
  return nonNull.length ? nonNull[nonNull.length - 1] : null;
}

/** Baut den Master-Case eines Falls (oder null, wenn keine Belege da sind). */
export async function baueMasterCase(c: BelegConfig, fall: string): Promise<MasterCase | null> {
  const results = await leseResults(c, fall);
  if (results.length === 0) return null;
  // Anzeigename aus den Results übernehmen (Ordnername kann ein Slug sein).
  const anzeigeFall = results[0].fall || fall;

  // jahr → personKey → Akkumulator
  const proJahr = new Map<string, Map<string, PersonAkk>>();
  // jahr → Set<dokument_typ>
  const belegeProJahr = new Map<string, Set<string>>();

  for (const r of results) {
    for (const dok of r.dokumente) {
      const jk = jahrKey(dok.kalenderjahr);
      if (!jk) continue;
      if (!belegeProJahr.has(jk)) belegeProJahr.set(jk, new Set());
      belegeProJahr.get(jk)!.add(dok.dokument_typ);

      const pk = personKey(dok.person);
      if (!proJahr.has(jk)) proJahr.set(jk, new Map());
      const personen = proJahr.get(jk)!;
      if (!personen.has(pk)) {
        personen.set(pk, {
          name: dok.person ?? null,
          rolleHint: dok.rolle,
          idnr: null,
          anlagen: new Set(),
          belege: new Set(),
          codeWerte: new Map(),
          codeDatentyp: new Map(),
        });
      }
      const akk = personen.get(pk)!;
      if (dok.rolle && !akk.rolleHint) akk.rolleHint = dok.rolle;
      akk.belege.add(dok.dokument_typ);

      for (const pos of dok.positionen) {
        if (pos.anlage) akk.anlagen.add(pos.anlage);
        if (pos.datentyp === 'idnr' && typeof pos.wert === 'string' && !akk.idnr) akk.idnr = pos.wert;
        if (pos.e_code) {
          const arr = akk.codeWerte.get(pos.e_code) ?? [];
          arr.push(pos.wert as Skalar);
          akk.codeWerte.set(pos.e_code, arr);
          akk.codeDatentyp.set(pos.e_code, pos.datentyp);
        }
      }
    }
  }

  // Jahre bauen
  const jahre: Record<string, MasterJahr> = {};
  const jahrListe = [...proJahr.keys()].sort();
  for (const jk of jahrListe) {
    const personenMap = proJahr.get(jk)!;
    const personen: MasterPerson[] = [];
    const keys = [...personenMap.keys()];
    keys.forEach((pk, idx) => {
      const akk = personenMap.get(pk)!;
      const rolle: 'A' | 'B' = akk.rolleHint ?? (idx === 0 ? 'A' : 'B');
      const elsterWerte: Record<string, Skalar> = {};
      for (const [code, werte] of akk.codeWerte) elsterWerte[code] = aggregiere(werte, akk.codeDatentyp.get(code));
      personen.push({
        rolle,
        person_key: pk,
        idnr: akk.idnr,
        name: akk.name,
        anlagen: [...akk.anlagen].sort(),
        belege: [...akk.belege].sort(),
        elsterWerte,
      });
    });
    personen.sort((a, b) => a.rolle.localeCompare(b.rolle));

    // Engine-Input: A direkt, B mit __B-Suffix bei Zusammenveranlagung.
    const zusammen = personen.length > 1;
    const engineWerte: Record<string, Skalar> = {};
    for (const p of personen) {
      for (const [code, wert] of Object.entries(p.elsterWerte)) {
        const key = p.rolle === 'B' && zusammen ? `${code}__B` : code;
        engineWerte[key] = wert;
      }
    }
    jahre[jk] = {
      veranlagung: zusammen ? 'zusammen' : 'einzel',
      personen,
      engineInput: { steuerjahr: parseInt(jk, 10), elsterWerte: engineWerte },
    };
  }

  return {
    fall: anzeigeFall,
    erzeugt: new Date().toISOString(),
    jahre,
    vergleich: baueVergleich(results, jahrListe),
    fehlende_belege: baueFehlendeBelege(belegeProJahr, jahrListe),
    _datei: path.join(ausgangDirFuer(c, fall), `mastercase_${fallSlug(fall)}.json`),
  };
}

/** Erstes vs. letztes Jahr je e_code, sortiert nach |Δ|. */
function baueVergleich(results: BelegResult[], jahrListe: string[]): VergleichZeile[] {
  if (jahrListe.length < 2) return [];
  const first = jahrListe[0];
  const last = jahrListe[jahrListe.length - 1];

  // jahr → e_code → numerische Summe; + Repräsentant je e_code
  const summe = new Map<string, Map<string, number>>([[first, new Map()], [last, new Map()]]);
  const rep = new Map<string, Position>();
  for (const r of results) {
    for (const dok of r.dokumente) {
      const jk = jahrKey(dok.kalenderjahr);
      if (jk !== first && jk !== last) continue;
      for (const pos of dok.positionen) {
        if (!pos.e_code) continue;
        if (!rep.has(pos.e_code)) rep.set(pos.e_code, pos);
        if (!istBetrag(pos.datentyp)) continue; // nur Beträge vergleichen (keine IdNr/Datum/Enum)
        const n = zuZahl(pos.wert as Skalar);
        if (n === null) continue;
        const m = summe.get(jk!)!;
        m.set(pos.e_code, (m.get(pos.e_code) ?? 0) + n);
      }
    }
  }

  const codes = new Set<string>([...summe.get(first)!.keys(), ...summe.get(last)!.keys()]);
  const zeilen: VergleichZeile[] = [];
  for (const code of codes) {
    const vFirst = summe.get(first)!.get(code);
    const vLast = summe.get(last)!.get(code);
    const a = vFirst ?? 0;
    const b = vLast ?? 0;
    const delta = Math.round((b - a) * 100) / 100;
    let status: VergleichZeile['status'];
    if (vFirst === undefined) status = 'neu';
    else if (vLast === undefined) status = 'entfallen';
    else status = delta === 0 ? 'gleich' : 'geändert';
    const p = rep.get(code)!;
    const row = {
      e_code: code,
      label: p.bezeichnung,
      anlage: p.anlage,
      zeile: p.zeile,
      delta,
      status,
    } as unknown as VergleichZeile;
    (row as unknown as Record<string, Skalar>)[first] = vFirst ?? null;
    (row as unknown as Record<string, Skalar>)[last] = vLast ?? null;
    zeilen.push(row);
  }
  zeilen.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return zeilen;
}

/** Dokumenttyp in einem Jahr vorhanden, in einem anderen nicht. */
function baueFehlendeBelege(
  belegeProJahr: Map<string, Set<string>>,
  jahrListe: string[],
): FehlenderBeleg[] {
  if (jahrListe.length < 2) return [];
  const alle = new Set<string>();
  for (const set of belegeProJahr.values()) for (const t of set) alle.add(t);
  const out: FehlenderBeleg[] = [];
  for (const beleg of [...alle].sort()) {
    const vorhanden = jahrListe.filter((j) => belegeProJahr.get(j)?.has(beleg));
    const fehlt = jahrListe.filter((j) => !belegeProJahr.get(j)?.has(beleg));
    if (vorhanden.length && fehlt.length) {
      for (const j of fehlt) out.push({ beleg, fehlt_in: j, vorhanden_in: vorhanden[0] });
    }
  }
  return out;
}

/** Schreibt den Master-Case (mode 0o666 → host-/teamlesbar). */
export async function schreibeMasterCase(
  c: BelegConfig,
  fall: string,
): Promise<{ datei: string; mastercase: MasterCase } | null> {
  const mc = await baueMasterCase(c, fall);
  if (!mc) return null;
  const dir = ausgangDirFuer(c, fall);
  await fs.mkdir(dir, { recursive: true });
  const datei = path.join(dir, `mastercase_${fallSlug(fall)}.json`);
  const tmp = `${datei}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(mc, null, 2) + '\n');
  await fs.rename(tmp, datei);
  await fs.chmod(datei, 0o666).catch(() => {});
  return { datei, mastercase: mc };
}
