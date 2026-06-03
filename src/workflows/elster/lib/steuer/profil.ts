/**
 * profil — DETERMINISTISCHES Steuerzahler-Profil, abgeleitet rein aus den
 * aggregierten Lane-1-Feldern. KEIN LLM, KEIN Hardcode, KEINE Case-Werte.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  WARUM ein Profil?
 *  Das Profil BESCHREIBT den Fall (Rentnerin mit Versorgungsbezügen ≠
 *  Arbeitnehmer) und STEUERT, welche Regeln die Berechnung anwendet:
 *
 *    hat Versorgungsbezüge  → §19 Abs.2: Versorgungsfreibetrag + Zuschlag,
 *                             Werbungskosten-Pauschbetrag 102 € (nicht 1.230)
 *    hat gesetzliche Rente  → §22 Nr.1: Besteuerungsanteil/Rentenfreibetrag
 *    hat Betriebsrente      → §22: eigener Posten (eigener Rentenbeginn)
 *    hat aktiven Arbeitslohn → §19 Abs.1: WK-Pauschbetrag 1.230 €
 *    privat/gesetzl. versich.→ §10 Abs.1 Nr.3: Vorsorge-Abzug
 *    Alter (Geburtsjahr)    → §24a: Altersentlastungsbetrag (Kohorte)
 *    Konfession             → Kirchensteuer (Hebesatz nach Land)
 *
 *  Das Profil ist ein Lane-1-Artefakt: deterministisch, früh, aus den
 *  Feldern. Die Berechnung liest NUR noch das Profil — nie wieder roh die
 *  E-Codes raten. Dadurch ist jede angewandte Regel im Profil begründet
 *  und im Fall-Tab sichtbar.
 * ════════════════════════════════════════════════════════════════════════
 */
import { parseEuro, type SteuerFeld } from './adapter.ts';

// ── Semantische E-Code-Mengen (ausgerichtet an adapter.ts / MCP-Vokabular) ──
//   Versorgungsbezüge (Anlage N): steuerbegünstigte Bezüge (LStB Nr. 8) +
//   maßgebendes Kalenderjahr des Versorgungsbeginns (LStB Nr. 30).
const E_VERSORGUNG_BEZUG = new Set(['E0200801']);
const E_VERSORGUNG_BEGINN = new Set(['E0201307', 'E0201904']);
const E_BRUTTOLOHN = new Set(['E0200201', 'E0200204', 'E0200203']);
// Renten: gesetzliche DRV vs. betriebliche/Pensionskasse — getrennt, weil
// eigene Rentenbeginn-Kohorte und (steuerlich) eigener Posten.
const E_RENTE_GESETZLICH = new Set(['E1800301', 'E2400103', 'E2400203']);
const E_RENTE_BETRIEB = new Set(['E1803102']);
const E_RENTENBEGINN_GESETZLICH = new Set(['E1800501', 'E2400107', 'E2400207']);
const E_RENTENBEGINN_BETRIEB = new Set(['E1803202']);
const E_RENTEN_ANPASSUNG = new Set(['E1800606', 'E2400106', 'E2400206']);
const E_KAP_ERTRAG = new Set(['E1900701']);
// Krankenversicherung: private Basis-Beiträge (eigene Anlage-VOR-Codes der
// privaten KV) signalisieren PRIVAT; gesetzliche KV-Beiträge → GESETZLICH.
const E_KV_PRIVAT = new Set(['E2003104', 'E2003202', 'E2003502']);
const E_KV_GESETZLICH = new Set(['E0202504', 'E2001203', 'E0202604', 'E2001505']);
const E_GEBURTSJAHR = new Set(['E0100401', 'E0100801']);
const E_KONFESSION = new Set(['E0100402', 'E0100802']);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const jahrAus = (wert: string): number | undefined => {
  const m = wert.match(/(?:19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : undefined;
};

/** Eine Einkunftsquelle im Profil — Vorhandensein + Betrag + (ggf.) Beginn. */
export interface Einkunftsquelle {
  vorhanden: boolean;
  /** Brutto-Jahresbetrag in Euro (0 wenn nicht vorhanden). */
  brutto: number;
  /** Maßgebendes Beginnjahr (Versorgungs-/Rentenbeginn), falls belegt. */
  beginnJahr?: number;
}

export type KrankenversicherungArt = 'privat' | 'gesetzlich' | 'unbekannt';
export type PersonTyp =
  | 'Versorgungsempfänger'   // Beamten-/Werkspension (§19 Abs.2)
  | 'Rentner'                // gesetzliche/betriebliche Rente (§22)
  | 'Arbeitnehmer'           // aktiver Arbeitslohn (§19 Abs.1)
  | 'Mischfall'              // mehrere Einkunftsarten relevant
  | 'unbekannt';

/** Profil einer steuerpflichtigen Person — rein aus Feldern abgeleitet. */
export interface PersonProfil {
  person: 'A' | 'B';
  geburtsjahr?: number;
  /** § 19 Abs. 2 — steuerbegünstigte Versorgungsbezüge (Pension). */
  versorgungsbezuege: Einkunftsquelle;
  /** § 22 Nr. 1 — gesetzliche Rente (DRV). */
  gesetzlicheRente: Einkunftsquelle & { anpassungsbetrag: number };
  /** § 22 — betriebliche Rente / Pensionskasse. */
  betriebsrente: Einkunftsquelle;
  /** § 19 Abs. 1 — aktiver Arbeitslohn (Brutto OHNE den Versorgungsanteil). */
  aktiverArbeitslohn: Einkunftsquelle;
  /** § 20 — Kapitalerträge (i.d.R. abgeltend / unter Sparer-Pauschbetrag). */
  kapitalertraege: Einkunftsquelle;
  /** § 10 Abs. 1 Nr. 3 — Art der Krankenversicherung. */
  krankenversicherung: KrankenversicherungArt;
  /** Abgeleiteter Personentyp — primär für UI + Plausibilität. */
  typ: PersonTyp;
  /** Welche Regeln greifen (Begründung je angewandter Sonderregel). */
  regeln: string[];
}

/** Gesamtprofil eines Falls. */
export interface SteuerzahlerProfil {
  vz: number;
  veranlagung: 'einzeln' | 'zusammen';
  personen: PersonProfil[];
  konfession: { kirchensteuerpflichtig: boolean; merkmal?: string; hebesatzProzent: number };
  /** Menschenlesbare Ein-Zeilen-Beschreibung des Falls (für den Fall-Tab). */
  beschreibung: string;
}

interface Akku {
  versorgungBezug: number[];
  versorgungBeginn?: number;
  bruttolohn: number[];
  renteGes: number;
  renteGesBeginn?: number;
  rentenAnpassung: number;
  renteBetrieb: number;
  renteBetriebBeginn?: number;
  kapErtrag: number;
  kvPrivat: boolean;
  kvGesetzlich: boolean;
  geburtsjahr?: number;
  konfessionMerkmal?: string;
}
const emptyAkku = (): Akku => ({
  versorgungBezug: [], bruttolohn: [], renteGes: 0, rentenAnpassung: 0,
  renteBetrieb: 0, kapErtrag: 0, kvPrivat: false, kvGesetzlich: false,
});

const groesster = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);

/** Konfession → Kirchensteuer-Pflicht. Merkmal '11'/'..' = keine KiSt. */
function konfessionAus(merkmal: string | undefined): { kirchensteuerpflichtig: boolean; merkmal?: string } {
  if (!merkmal) return { kirchensteuerpflichtig: false };
  const m = merkmal.trim().toLowerCase();
  // 'vd'/'--'/'11'/'keine'/'0' → konfessionslos; alles andere (ev/rk/02/03…) → pflichtig.
  const ohne = m === '' || m === 'vd' || m === '--' || m === '11' || m === '0' || m === '00' || /keine|konfessionslos|ohne/.test(m);
  return { kirchensteuerpflichtig: !ohne, merkmal };
}

/**
 * Leitet das deterministische Steuerzahler-Profil aus den (aggregierten +
 * deterministisch injizierten) Feldern ab. Pure Funktion, keine I/O.
 *
 * @param felder  Vollständige Feldliste EINES Falls (Lane-1-Aggregat).
 * @param opts.vz Veranlagungszeitraum.
 * @param opts.veranlagung optional erzwungen; sonst aus Person-B-Einkünften.
 * @param opts.hebesatzProzent Kirchensteuer-Hebesatz (Land), default 9.
 */
export function ableiteProfil(
  felder: SteuerFeld[],
  opts: { vz: number; veranlagung?: 'einzeln' | 'zusammen'; hebesatzProzent?: number },
): SteuerzahlerProfil {
  const akkus: Record<'A' | 'B', Akku> = { A: emptyAkku(), B: emptyAkku() };

  for (const f of felder) {
    const a = akkus[f.person] ?? akkus.A;
    const n = parseEuro(f.wert);
    if (E_VERSORGUNG_BEZUG.has(f.eCode)) { if (n && n > 0) a.versorgungBezug.push(n); }
    else if (E_VERSORGUNG_BEGINN.has(f.eCode)) { const y = jahrAus(f.wert); if (y) a.versorgungBeginn = a.versorgungBeginn ? Math.min(a.versorgungBeginn, y) : y; }
    else if (E_BRUTTOLOHN.has(f.eCode)) { if (n && n > 0) a.bruttolohn.push(n); }
    else if (E_RENTE_GESETZLICH.has(f.eCode)) { if (n) a.renteGes += n; }
    else if (E_RENTE_BETRIEB.has(f.eCode)) { if (n) a.renteBetrieb += n; }
    else if (E_RENTEN_ANPASSUNG.has(f.eCode)) { if (n) a.rentenAnpassung += n; }
    else if (E_RENTENBEGINN_GESETZLICH.has(f.eCode)) { const y = jahrAus(f.wert); if (y) a.renteGesBeginn = a.renteGesBeginn ? Math.min(a.renteGesBeginn, y) : y; }
    else if (E_RENTENBEGINN_BETRIEB.has(f.eCode)) { const y = jahrAus(f.wert); if (y) a.renteBetriebBeginn = a.renteBetriebBeginn ? Math.min(a.renteBetriebBeginn, y) : y; }
    else if (E_KAP_ERTRAG.has(f.eCode)) { if (n) a.kapErtrag += n; }
    else if (E_KV_PRIVAT.has(f.eCode)) { if (n && n > 0) a.kvPrivat = true; }
    else if (E_KV_GESETZLICH.has(f.eCode)) { if (n && n > 0) a.kvGesetzlich = true; }
    else if (E_GEBURTSJAHR.has(f.eCode)) { const y = jahrAus(f.wert); if (y) a.geburtsjahr = y; }
    else if (E_KONFESSION.has(f.eCode)) { if (f.wert.trim()) a.konfessionMerkmal = f.wert.trim(); }
  }

  const baue = (who: 'A' | 'B', a: Akku): PersonProfil => {
    const regeln: string[] = [];
    const versorgungBrutto = round2(a.versorgungBezug.reduce((s, x) => s + x, 0));
    const bruttolohnGesamt = groesster(a.bruttolohn);
    // Aktiver Arbeitslohn = Bruttolohn OHNE den Versorgungsanteil. Versorgungs-
    // bezüge sind in §19 enthalten, werden aber separat (Nr. 8) ausgewiesen;
    // der verbleibende Teil ist aktiver Lohn (häufig 0 bei reinen Pensionären).
    const aktivBrutto = Math.max(0, round2(bruttolohnGesamt - Math.min(versorgungBrutto, bruttolohnGesamt)));

    const versorgungsbezuege: Einkunftsquelle = {
      vorhanden: versorgungBrutto > 0,
      brutto: versorgungBrutto,
      beginnJahr: a.versorgungBeginn,
    };
    if (versorgungsbezuege.vorhanden) {
      regeln.push(
        `§19 Abs.2 Versorgungsfreibetrag + Zuschlag (Versorgungsbezüge ${versorgungBrutto.toFixed(2)} €` +
        `${a.versorgungBeginn ? `, Beginn ${a.versorgungBeginn}` : ', Beginn UNBEKANNT → Nr. 30 LStB fehlt'}), ` +
        `Werbungskosten-Pauschbetrag 102 € statt 1.230 €.`,
      );
    }
    const gesetzlicheRente = {
      vorhanden: a.renteGes > 0, brutto: round2(a.renteGes),
      beginnJahr: a.renteGesBeginn, anpassungsbetrag: round2(a.rentenAnpassung),
    };
    if (gesetzlicheRente.vorhanden) regeln.push(`§22 Nr.1 gesetzliche Rente (Besteuerungsanteil nach Beginn ${a.renteGesBeginn ?? '≤2005'}, festgeschriebener Rentenfreibetrag).`);
    const betriebsrente: Einkunftsquelle = { vorhanden: a.renteBetrieb > 0, brutto: round2(a.renteBetrieb), beginnJahr: a.renteBetriebBeginn };
    if (betriebsrente.vorhanden) regeln.push(`§22 betriebliche Rente/Pensionskasse (eigener Posten).`);
    const aktiverArbeitslohn: Einkunftsquelle = { vorhanden: aktivBrutto > 0, brutto: aktivBrutto };
    if (aktiverArbeitslohn.vorhanden) regeln.push(`§19 Abs.1 aktiver Arbeitslohn (WK-Pauschbetrag 1.230 €).`);
    const kapitalertraege: Einkunftsquelle = { vorhanden: a.kapErtrag > 0, brutto: round2(a.kapErtrag) };

    const krankenversicherung: KrankenversicherungArt =
      a.kvPrivat ? 'privat' : a.kvGesetzlich ? 'gesetzlich' : 'unbekannt';
    if (krankenversicherung !== 'unbekannt') regeln.push(`§10 Abs.1 Nr.3 ${krankenversicherung === 'privat' ? 'private' : 'gesetzliche'} Kranken-/Pflegeversicherung (Basisabsicherung abzugsfähig).`);

    // Altersentlastungsbetrag-Indikator (greift bei aktivem Lohn/Nebeneink.,
    // wenn die Person vor Beginn des VZ das 64. Lebensjahr vollendet hat).
    if (a.geburtsjahr && a.geburtsjahr <= opts.vz - 65) regeln.push(`§24a Altersentlastungsbetrag möglich (geb. ${a.geburtsjahr}, 64. LJ vor VZ-Beginn vollendet).`);

    // Abgeleiteter Typ.
    const flags = [versorgungsbezuege.vorhanden, gesetzlicheRente.vorhanden || betriebsrente.vorhanden, aktiverArbeitslohn.vorhanden];
    const anzahl = flags.filter(Boolean).length;
    let typ: PersonTyp = 'unbekannt';
    if (anzahl >= 2) typ = 'Mischfall';
    else if (versorgungsbezuege.vorhanden) typ = 'Versorgungsempfänger';
    else if (gesetzlicheRente.vorhanden || betriebsrente.vorhanden) typ = 'Rentner';
    else if (aktiverArbeitslohn.vorhanden) typ = 'Arbeitnehmer';
    // Sonderfall: Versorgung + Rente, aber kein aktiver Lohn → primär Versorgungsempfänger/Rentner-Mischfall.

    return {
      person: who, geburtsjahr: a.geburtsjahr,
      versorgungsbezuege, gesetzlicheRente, betriebsrente, aktiverArbeitslohn,
      kapitalertraege, krankenversicherung, typ, regeln,
    };
  };

  const profA = baue('A', akkus.A);
  const profB = baue('B', akkus.B);
  const bHatEinkunft = profB.versorgungsbezuege.vorhanden || profB.gesetzlicheRente.vorhanden
    || profB.betriebsrente.vorhanden || profB.aktiverArbeitslohn.vorhanden;
  const veranlagung = opts.veranlagung ?? (bHatEinkunft ? 'zusammen' : 'einzeln');
  const personen = bHatEinkunft ? [profA, profB] : [profA];

  // Konfession case-weit aus Person A (bei Zusammenveranlagung ggf. erweitern).
  const konf = konfessionAus(akkus.A.konfessionMerkmal ?? akkus.B.konfessionMerkmal);
  const konfession = {
    kirchensteuerpflichtig: konf.kirchensteuerpflichtig,
    merkmal: konf.merkmal,
    hebesatzProzent: konf.kirchensteuerpflichtig ? (opts.hebesatzProzent ?? 9) : 0,
  };

  const beschreibung = baueBeschreibung(personen, veranlagung, konfession);
  return { vz: opts.vz, veranlagung, personen, konfession, beschreibung };
}

function baueBeschreibung(
  personen: PersonProfil[],
  veranlagung: 'einzeln' | 'zusammen',
  konfession: { kirchensteuerpflichtig: boolean; hebesatzProzent: number },
): string {
  const teile: string[] = [];
  for (const p of personen) {
    const quellen: string[] = [];
    if (p.versorgungsbezuege.vorhanden) quellen.push(`Versorgungsbezüge ${p.versorgungsbezuege.brutto.toFixed(0)} €`);
    if (p.gesetzlicheRente.vorhanden) quellen.push(`gesetzl. Rente ${p.gesetzlicheRente.brutto.toFixed(0)} €`);
    if (p.betriebsrente.vorhanden) quellen.push(`Betriebsrente ${p.betriebsrente.brutto.toFixed(0)} €`);
    if (p.aktiverArbeitslohn.vorhanden) quellen.push(`Arbeitslohn ${p.aktiverArbeitslohn.brutto.toFixed(0)} €`);
    if (p.kapitalertraege.vorhanden) quellen.push(`Kapital ${p.kapitalertraege.brutto.toFixed(0)} €`);
    const kv = p.krankenversicherung !== 'unbekannt' ? `, ${p.krankenversicherung} versichert` : '';
    teile.push(`Person ${p.person}: ${p.typ}${quellen.length ? ` (${quellen.join(', ')})` : ''}${kv}`);
  }
  const kiSt = konfession.kirchensteuerpflichtig ? `, kirchensteuerpflichtig (${konfession.hebesatzProzent}%)` : ', konfessionslos';
  return `${veranlagung === 'zusammen' ? 'Zusammenveranlagung' : 'Einzelveranlagung'}${kiSt}. ${teile.join(' · ')}`;
}
