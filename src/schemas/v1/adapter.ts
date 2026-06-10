/**
 * src/schemas/v1/adapter — Harmonisierung der lokalen Mastercase-Formen auf
 * die kanonischen v1-Verträge (fall/v1, mastercase/v1).
 *
 * Quellformen:
 *   A) Evidenz-Form   (web/mastercase-harmonize.ts):
 *      { entitaeten[{person:'A'|'B'}], fakten[{person, e_code, value:string}] }
 *   B) Jahres-Form    (src/server/mastercase.ts buildMastercase):
 *      { label, vz, veranlagungsart, entitaeten, fakten[{eCodeParse, eCodeMap, wert}], ergebnis }
 *
 * Vertragsregeln (SCHEMAS-README.md):
 *   R1  Stammdaten → profil; jahresvariable Werte → jahre.YYYY.personen[].elsterWerte
 *   R2  engineInput ist ABGELEITET — hier bei jedem Bau frisch aggregiert
 *   R3  __B-Suffix NUR im engineInput; jahresperson.elsterWerte strikt ^E\d{7}$
 *   R4  bundesland immer im engineInput (Default rheinland-pfalz, eCodeBridge-Konvention)
 *   R5  schema-Tag fall/v1 | mastercase/v1
 *
 * Kein silent drop: Was nicht in den Vertrag passt (kein 7-stelliger eCode,
 * leerer Wert, Wert-Kollision), kommt in `uebersprungen[]` zurück — der
 * Aufrufer entscheidet, ob er das loggt, anzeigt oder eskaliert.
 */
import type {
  Beleg, ElsterWert, ElsterWerte, EngineInput, Fall, Jahresblock, JahresPerson,
  MasterCase, Person, Position, RechenErgebnis,
} from './types.ts';
import { SCHEMA_TAG_FALL, SCHEMA_TAG_MASTERCASE } from './types.ts';

export const DEFAULT_BUNDESLAND = 'rheinland-pfalz';
export const E_CODE_RE = /^E\d{7}$/;
const JAHR_RE = /^(19|20|21)\d{2}$/;

// ── Eingabe-Formen (strukturell, damit src/schemas nicht von web/ abhängt) ──
export interface RosterPersonRoh { idnr?: string; vorname?: string; nachname?: string }
export interface HouseholdRoh { personA?: RosterPersonRoh; personB?: RosterPersonRoh }

export interface EvidenzEntitaet { person: 'A' | 'B'; idnr?: string; name?: string }
export interface EvidenzFakt { person: 'A' | 'B'; e_code: string; value: string }
export interface EvidenzMastercase { entitaeten: EvidenzEntitaet[]; fakten: EvidenzFakt[] }

export interface JahresFormEntitaet { person: 'A' | 'B'; idnr?: string; name?: string; anlagen?: string[] }
export interface JahresFormFakt { person: 'A' | 'B'; wert: string; eCodeParse: string; eCodeMap: string | null }
export interface JahresFormMastercase {
  label: string; vz: number; veranlagungsart: string;
  entitaeten: JahresFormEntitaet[]; fakten: JahresFormFakt[];
  ergebnis: { erstattung?: number; zve?: number; gesamtsteuer?: number } | null;
}

export interface BelegRoh {
  source?: string; vorjahr?: boolean; belegTyp?: string;
  felderListe?: Array<{ eCode: string; label?: string; wert?: string; person?: string }>;
}

export interface Uebersprungen { person: string; e_code: string; wert: string; grund: string }

// ── Wert-Typisierung: String-Werte aus der Extraktion → ElsterWert ───────
const NUR_ZIFFERN_RE = /^\d{9,}$/;                                  // IdNr/eTIN: Kennung, kein Betrag
const FUEHRENDE_NULL_RE = /^0\d+$/;                                  // PLZ "01067" etc.: Ziffernfolge, kein Betrag
const DE_ZAHL_RE = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;       // 13.440,00 | 604,86 | 1280
const EN_DEZIMAL_RE = /^-?\d+\.\d{1,2}$/;                            // 338.94 (bereits maschinell geparst)
const DE_DATUM_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;                   // 09.07.1965 → 1965-07-09

/** Deutsch-formatierte Extraktions-Strings typgenau machen; Kennungen
 *  (IdNr, führende Nullen) bleiben bewusst Text. Unparsebares bleibt String. */
export function zuElsterWert(roh: unknown): ElsterWert {
  if (roh === null || roh === undefined) return null;
  if (typeof roh === 'number' || typeof roh === 'boolean') return roh;
  const s = String(roh).trim();
  if (!s) return null;
  if (NUR_ZIFFERN_RE.test(s) || FUEHRENDE_NULL_RE.test(s)) return s;
  const dm = DE_DATUM_RE.exec(s);
  if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`;
  if (DE_ZAHL_RE.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (EN_DEZIMAL_RE.test(s)) return Number(s);
  return s;
}

/** person_key-Konvention: lowercase-Vollname (wie beleg-api), sonst p_a/p_b. */
export function personKeyAus(name: string | undefined | null, rolle: 'A' | 'B'): string {
  const k = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return k || (rolle === 'B' ? 'p_b' : 'p_a');
}

const nurZiffern = (s?: string): string | null => {
  const d = (s ?? '').replace(/\D/g, '');
  return d || null;
};

const normVeranlagung = (v?: string): string | undefined => {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  return ['einzel', 'zusammen', 'getrennt'].includes(s) ? s : 'unbekannt';
};

// ── Kern: Personen-Werte falten + engineInput ableiten (R2/R3/R4) ────────
interface PersonenWerte {
  rolle: 'A' | 'B'; person_key: string; idnr: string | null; name: string | null;
  anlagen?: string[]; belege?: string[]; elsterWerte: ElsterWerte;
}

/** Fakten je Person in elsterWerte falten. Erster Wert je eCode gewinnt
 *  (Eingang ist bereits gevotet/sortiert); abweichende Nachzügler → uebersprungen. */
function falteWerte(
  fakten: Array<{ person: 'A' | 'B'; e_code: string | null; wert: string }>,
  uebersprungen: Uebersprungen[],
): Record<'A' | 'B', ElsterWerte> {
  const werte: Record<'A' | 'B', ElsterWerte> = { A: {}, B: {} };
  for (const f of fakten) {
    const skip = (grund: string) => uebersprungen.push({ person: f.person, e_code: f.e_code ?? '', wert: f.wert, grund });
    if (!f.e_code || !E_CODE_RE.test(f.e_code)) { skip('kein-7-stelliger-ecode'); continue; }
    const wert = zuElsterWert(f.wert);
    if (wert === null) { skip('leer'); continue; }
    const ziel = werte[f.person];
    if (f.e_code in ziel) {
      if (ziel[f.e_code] !== wert) skip('kollision-erster-wert-gewinnt');
      continue;
    }
    ziel[f.e_code] = wert;
  }
  return werte;
}

/** engineInput frisch aggregieren: A pur + B mit __B-Suffix + bundesland. */
export function bauEngineInput(steuerjahr: number, personen: JahresPerson[], bundesland: string): EngineInput {
  const elsterWerte: ElsterWerte = {};
  for (const p of personen) {
    const suffix = p.rolle === 'B' ? '__B' : '';
    for (const [code, wert] of Object.entries(p.elsterWerte)) elsterWerte[code + suffix] = wert;
  }
  elsterWerte['bundesland'] = bundesland;
  return { steuerjahr, elsterWerte };
}

export interface JahresblockOptionen {
  steuerjahr: number;
  veranlagung?: string;
  bundesland?: string;
  /** Beleg-Namen je Person (für jahresperson.belege, optional). */
  belegeJePerson?: Partial<Record<'A' | 'B', string[]>>;
  /** Anlagen je Person (für jahresperson.anlagen, optional). */
  anlagenJePerson?: Partial<Record<'A' | 'B', string[]>>;
}

function bauJahresblock(
  entitaeten: Array<{ person: 'A' | 'B'; idnr?: string; name?: string }>,
  werte: Record<'A' | 'B', ElsterWerte>,
  opt: JahresblockOptionen,
): Jahresblock {
  if (!JAHR_RE.test(String(opt.steuerjahr)))
    throw new Error(`steuerjahr ${opt.steuerjahr} ist kein gültiger jahre-Key (^(19|20|21)\\d{2}$)`);
  const personen: JahresPerson[] = [];
  for (const rolle of ['A', 'B'] as const) {
    const ent = entitaeten.find((e) => e.person === rolle);
    const elsterWerte = werte[rolle];
    if (!ent && !Object.keys(elsterWerte).length) continue;     // Person existiert nicht im Fall
    const p: JahresPerson = {
      person_key: personKeyAus(ent?.name, rolle),
      rolle,
      idnr: nurZiffern(ent?.idnr),
      name: ent?.name ?? null,
      elsterWerte,
    };
    const anlagen = opt.anlagenJePerson?.[rolle];
    if (anlagen?.length) p.anlagen = [...anlagen].sort();
    const belege = opt.belegeJePerson?.[rolle];
    if (belege?.length) p.belege = [...new Set(belege)].sort();
    personen.push(p);
  }
  const block: Jahresblock = {
    personen,
    engineInput: bauEngineInput(opt.steuerjahr, personen, opt.bundesland ?? DEFAULT_BUNDESLAND),
  };
  const v = normVeranlagung(opt.veranlagung);
  if (v) block.veranlagung = v;
  return block;
}

// ── A) Evidenz-Form → Jahresblock ────────────────────────────────────────
export function evidenzZuJahresblock(
  mc: EvidenzMastercase,
  opt: JahresblockOptionen,
): { jahresblock: Jahresblock; uebersprungen: Uebersprungen[] } {
  const uebersprungen: Uebersprungen[] = [];
  const werte = falteWerte(mc.fakten.map((f) => ({ person: f.person, e_code: f.e_code, wert: f.value })), uebersprungen);
  return { jahresblock: bauJahresblock(mc.entitaeten, werte, opt), uebersprungen };
}

// ── Bausteine: MasterCase / Fall / Beleg / RechenErgebnis ────────────────
export function zuMasterCaseV1(args: {
  fall: string;
  jahre: Record<string, Jahresblock>;
  erzeugt?: string;
  quelle?: string;
}): MasterCase {
  const mc: MasterCase = {
    schema: SCHEMA_TAG_MASTERCASE,
    fall: args.fall,
    erzeugt: args.erzeugt ?? new Date().toISOString(),
    jahre: args.jahre,
  };
  if (args.quelle) mc._quelle = args.quelle;
  return mc;
}

function bauProfilPersonen(household: HouseholdRoh | undefined, entitaeten: Array<{ person: 'A' | 'B'; idnr?: string; name?: string }>): Person[] {
  const personen: Person[] = [];
  for (const rolle of ['A', 'B'] as const) {
    const r = rolle === 'A' ? household?.personA : household?.personB;
    const ent = entitaeten.find((e) => e.person === rolle);
    if (rolle === 'B' && !r?.idnr && !r?.nachname && !r?.vorname && !ent) continue;
    const name = [r?.vorname, r?.nachname].filter(Boolean).join(' ') || ent?.name || null;
    const p: Person = {
      rolle,
      person_key: personKeyAus(name, rolle),
      idnr: nurZiffern(r?.idnr ?? ent?.idnr),
      name,
    };
    if (r?.vorname) p.vorname = r.vorname;
    if (r?.nachname) p.nachname = r.nachname;
    personen.push(p);
  }
  return personen;
}

export function zuFallV1(args: {
  fall_id: string;
  household?: HouseholdRoh;
  entitaeten?: Array<{ person: 'A' | 'B'; idnr?: string; name?: string }>;
  veranlagung?: string;
  bundesland?: string;
  jahre: Record<string, Jahresblock>;
  belege?: Beleg[];
  rechen_ergebnis?: Record<string, RechenErgebnis>;
  tenant?: string;
  erzeugt?: string;
}): Fall {
  const haushalt: Fall['profil']['haushalt'] = { bundesland: args.bundesland ?? DEFAULT_BUNDESLAND };
  const v = normVeranlagung(args.veranlagung);
  if (v) haushalt.veranlagung = v;
  const fall: Fall = {
    schema: SCHEMA_TAG_FALL,
    fall_id: args.fall_id,
    erzeugt: args.erzeugt ?? new Date().toISOString(),
    profil: { haushalt, personen: bauProfilPersonen(args.household, args.entitaeten ?? []) },
    jahre: args.jahre,
  };
  if (args.tenant) fall.tenant = args.tenant;
  if (args.belege?.length) fall.belege = args.belege;
  if (args.rechen_ergebnis && Object.keys(args.rechen_ergebnis).length) fall.rechen_ergebnis = args.rechen_ergebnis;
  return fall;
}

const datentypVon = (w: ElsterWert): string => {
  if (typeof w === 'number') return Number.isInteger(w) ? 'integer' : 'number';
  if (typeof w === 'boolean') return 'boolean';
  if (typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w)) return 'date';
  return 'string';
};

/** Lokale Beleg-Liste (runLane1) → Beleg[] nach beleg.schema.json.
 *  Vorjahres-Belege bleiben draußen (gehören nicht in den Fall des VZ). */
export function belegeZuV1(
  belege: BelegRoh[],
  personKeyVon: (rolle: 'A' | 'B') => string,
  kalenderjahr: number | null,
): Beleg[] {
  const out: Beleg[] = [];
  let i = 0;
  for (const b of belege ?? []) {
    i++;
    if (b.vorjahr) continue;
    const quelle = String(b.source ?? '').split('#')[0];
    const dateiname = quelle ? quelle.split('/').pop() ?? quelle : null;
    const beleg_id = (dateiname ?? `beleg-${i}`).replace(/[^\w.\- ]/g, '_');
    const felder = b.felderListe ?? [];
    const bCount = felder.filter((f) => String(f.person).toUpperCase() === 'B').length;
    const rolle: 'A' | 'B' = bCount > felder.length / 2 ? 'B' : 'A';
    const positionen: Position[] = felder.map((f) => {
      const wert = zuElsterWert(f.wert);
      return {
        bezeichnung: f.label ?? f.eCode,
        anlage: null,
        zeile: null,
        wert,
        e_code: E_CODE_RE.test(f.eCode) ? f.eCode : null,
        elster_kennziffer: null,
        kennzahl: [],
        datentyp: datentypVon(wert),
        person_key: personKeyVon(String(f.person).toUpperCase() === 'B' ? 'B' : 'A'),
        quelle_beleg_id: beleg_id,
      };
    });
    const beleg: Beleg = {
      beleg_id,
      dateiname,
      sha256: null,
      dokument_typ: b.belegTyp ?? 'unbekannt',
      aussteller: null,
      person_key: personKeyVon(rolle),
      kalenderjahr,
      status: 'extrahiert',
    };
    if (positionen.length) beleg.positionen = positionen;
    out.push(beleg);
  }
  return out;
}

/** Lokales Pre-Calc-Ergebnis → RechenErgebnis (lokale Engine, NICHT bmf-api —
 *  als solche im engine-Feld ausgewiesen). erstattung<0 wird zu nachzahlung. */
export function rechenErgebnisAusCalc(
  steuerjahr: number,
  calc: { erstattung?: number; bindend?: { zve?: number; gesamtsteuer?: number } } | null | undefined,
  engine = 'sturm-precalc',
): RechenErgebnis | null {
  if (!calc) return null;
  const endwerte: RechenErgebnis['endwerte'] = {};
  if (typeof calc.bindend?.zve === 'number') endwerte.zve = calc.bindend.zve;
  if (typeof calc.bindend?.gesamtsteuer === 'number') endwerte.gesamtsteuer = calc.bindend.gesamtsteuer;
  if (typeof calc.erstattung === 'number') {
    if (calc.erstattung >= 0) endwerte.erstattung = calc.erstattung;
    else endwerte.nachzahlung = -calc.erstattung;
  }
  if (!Object.keys(endwerte).length) return null;
  return { steuerjahr, engine, berechnet_am: new Date().toISOString(), endwerte };
}

// ── One-Stop für den Envelope-Pfad (web/server.ts kickMastercase) ────────
export function envelopeZuV1(args: {
  fallId: string;
  vz: number;
  mastercase: EvidenzMastercase;
  household?: HouseholdRoh;
  veranlagungsart?: string;
  belege?: BelegRoh[];
  calc?: { erstattung?: number; bindend?: { zve?: number; gesamtsteuer?: number } } | null;
  bundesland?: string;
}): { fall: Fall; mastercase: MasterCase; uebersprungen: Uebersprungen[] } {
  const keyVon = (rolle: 'A' | 'B'): string =>
    personKeyAus(args.mastercase.entitaeten.find((e) => e.person === rolle)?.name, rolle);
  const belegeV1 = belegeZuV1(args.belege ?? [], keyVon, args.vz || null);
  const belegeJePerson: Partial<Record<'A' | 'B', string[]>> = {};
  for (const b of belegeV1) {
    const rolle: 'A' | 'B' = b.person_key === keyVon('B') ? 'B' : 'A';
    (belegeJePerson[rolle] ??= []).push(b.dokument_typ !== 'unbekannt' ? b.dokument_typ : b.beleg_id);
  }
  const { jahresblock, uebersprungen } = evidenzZuJahresblock(args.mastercase, {
    steuerjahr: args.vz,
    veranlagung: args.veranlagungsart,
    bundesland: args.bundesland,
    belegeJePerson,
  });
  const jahre = { [String(args.vz)]: jahresblock };
  const mastercase = zuMasterCaseV1({ fall: args.fallId, jahre, quelle: 'web-envelope' });
  const ergebnis = rechenErgebnisAusCalc(args.vz, args.calc);
  const fall = zuFallV1({
    fall_id: args.fallId,
    household: args.household,
    entitaeten: args.mastercase.entitaeten,
    veranlagung: args.veranlagungsart,
    bundesland: args.bundesland,
    jahre,
    belege: belegeV1,
    rechen_ergebnis: ergebnis ? { [String(args.vz)]: ergebnis } : undefined,
  });
  return { fall, mastercase, uebersprungen };
}

// ── B) Jahres-Form (src/server/mastercase.ts) → v1 ──────────────────────
export function jahresFormZuV1(
  mc: JahresFormMastercase,
  opt?: { fallId?: string; bundesland?: string; quelle?: string },
): { mastercase: MasterCase; fall: Fall; uebersprungen: Uebersprungen[] } {
  const uebersprungen: Uebersprungen[] = [];
  // eCode-Auflösung: map-once-Ergebnis bevorzugt, sonst Ingestion-eCode.
  const fakten = mc.fakten.map((f) => ({
    person: f.person,
    e_code: (f.eCodeMap && E_CODE_RE.test(f.eCodeMap)) ? f.eCodeMap
      : (E_CODE_RE.test(f.eCodeParse) ? f.eCodeParse : null),
    wert: f.wert,
  }));
  const werte = falteWerte(fakten, uebersprungen);
  const anlagenJePerson: Partial<Record<'A' | 'B', string[]>> = {};
  for (const e of mc.entitaeten) if (e.anlagen?.length) anlagenJePerson[e.person] = e.anlagen;
  const jahresblock = bauJahresblock(mc.entitaeten, werte, {
    steuerjahr: mc.vz,
    veranlagung: mc.veranlagungsart,
    bundesland: opt?.bundesland,
    anlagenJePerson,
  });
  const fallId = opt?.fallId || mc.label || 'fall';
  const jahre = { [String(mc.vz)]: jahresblock };
  const mastercase = zuMasterCaseV1({ fall: fallId, jahre, quelle: opt?.quelle });
  const ergebnis = rechenErgebnisAusCalc(mc.vz, mc.ergebnis ? { erstattung: mc.ergebnis.erstattung, bindend: { zve: mc.ergebnis.zve, gesamtsteuer: mc.ergebnis.gesamtsteuer } } : null);
  const fall = zuFallV1({
    fall_id: fallId,
    entitaeten: mc.entitaeten,
    veranlagung: mc.veranlagungsart,
    bundesland: opt?.bundesland,
    jahre,
    rechen_ergebnis: ergebnis ? { [String(mc.vz)]: ergebnis } : undefined,
  });
  return { mastercase, fall, uebersprungen };
}
