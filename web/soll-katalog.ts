/**
 * soll-katalog — profil-getriebene Vollständigkeits-Sollliste gegen die volle
 * Einkommensteuererklärung (ESt 1 A + Anlagen) MIT Recovery-Regel.
 *
 * Statt jede fehlende Angabe beim Nutzer abzufragen, klassifiziert pruefeSoll die
 * Recovery-Quelle und fragt nur, was nirgends herkommt:
 *
 *   erfüllt      — liegt als Feld vor
 *   im_beleg     — steht in einem hochgeladenen Beleg, nur nicht extrahiert
 *                  (z.B. Adresse + IBAN in den Bank-Steuerbescheinigungen / JPGs) → extrahieren
 *   berechenbar  — aus den 2024-Daten ableitbar (z.B. Günstigerprüfung aus dem Steuersatz) → rechnen
 *   vorjahr      — stabile Stammdaten aus der Vorjahres-Erklärung (Geburtsdatum,
 *                  Heiratsdatum, Pendlerpauschale) → übernehmen
 *   fehlt        — in keiner Quelle → den Nutzer fragen
 *
 * Hergeleitet aus dem echten Stricker-Fall; eCodes/Zeilen aus atoms.json.
 */
import type { CaseData } from './audit.ts';

export type SollKategorie =
  | 'Stammdaten' | 'Bankverbindung' | 'Veranlagung' | 'Werbungskosten' | 'Kapitalerträge';
export type RecoveryKind = 'erfuellt' | 'im_beleg' | 'berechenbar' | 'vorjahr' | 'fehlt';

export interface SollItem {
  id: string;
  kategorie: SollKategorie;
  label: string;
  /** Erfüllt, sobald EINER dieser eCodes als Feld vorliegt. */
  eCodes: string[];
  severity: 'blocker' | 'empfohlen' | 'optional';
  /** Profil-/Veranlagungs-Bedingung — nur dann wird das Feld erwartet. */
  erwartetWenn: (ctx: SollCtx) => boolean;
  /** Vorformulierte Frage (Fallback, falls wirklich gefragt werden muss). */
  frage: string;
  herkunft: string;
  // ── Recovery-Quellen (Regel) ──
  /** Belegtypen, die den Wert enthalten (nur noch nicht extrahiert). */
  imBeleg?: string[];
  /** Aus den 2024-Daten berechenbar → liefert die Antwort statt zu fragen. */
  berechenbar?: (data: CaseData) => { antwort: string } | null;
  /** Stabile Stammdaten, aus der Vorjahres-Erklärung direkt übernehmbar. */
  vorjahr?: boolean;
}
export interface SollCtx { profile: Set<string>; veranlagung: string; hatB: boolean; }

/** Günstigerprüfung: lohnt nur, wenn der persönliche Grenzsteuersatz < 25 % Abgeltungsteuer. */
const guenstigerBerechnen = (data: CaseData): { antwort: string } | null => {
  const calc = (data.calcs ?? [])[0] as { bindend?: { grenzsteuersatz?: number } } | undefined;
  const g = calc?.bindend?.grenzsteuersatz;
  if (typeof g !== 'number') return null;
  const pct = Math.round(g * 100);
  return g < 0.25
    ? { antwort: `Berechnet: Grenzsteuersatz ${pct}% < 25 % Abgeltungsteuer → Günstigerprüfung ist vorteilhaft, Antrag wird gesetzt.` }
    : { antwort: `Berechnet: Grenzsteuersatz ${pct}% ≥ 25 % Abgeltungsteuer → Günstigerprüfung bringt keinen Vorteil, kein Antrag nötig.` };
};

const BANK = ['Steuerbescheinigung_Bank'];

const SOLL: SollItem[] = [
  // ── Stammdaten ──
  { id: 'gebdat-a', kategorie: 'Stammdaten', label: 'Geburtsdatum Person A', eCodes: ['E0100401'], severity: 'blocker',
    erwartetWenn: () => true, vorjahr: true, frage: 'Wie lautet das Geburtsdatum von Person A?', herkunft: 'Vorjahres-Erklärung (Z8)' },
  { id: 'gebdat-b', kategorie: 'Stammdaten', label: 'Geburtsdatum Person B', eCodes: ['E0101001'], severity: 'empfohlen',
    erwartetWenn: (c) => c.hatB, vorjahr: true, frage: 'Wie lautet das Geburtsdatum von Person B?', herkunft: 'Vorjahres-Erklärung (Z20)' },
  { id: 'adresse', kategorie: 'Stammdaten', label: 'Wohnanschrift (Straße, Hausnr., PLZ, Ort)', eCodes: ['E0101104', 'E0100602', 'E0100601'], severity: 'blocker',
    erwartetWenn: () => true, imBeleg: BANK, vorjahr: true, frage: 'Wie lautet die aktuelle Wohnanschrift (Straße, Hausnummer, PLZ, Ort)?', herkunft: 'Bank-Steuerbescheinigung / Vorjahr' },
  { id: 'heirat', kategorie: 'Veranlagung', label: 'Verheiratet/verpartnert seit', eCodes: ['E0100701'], severity: 'empfohlen',
    erwartetWenn: (c) => c.veranlagung === 'zusammen', vorjahr: true, frage: 'Seit wann besteht die Ehe bzw. Lebenspartnerschaft?', herkunft: 'Vorjahres-Erklärung (Z18)' },
  // ── Bankverbindung ──
  { id: 'iban', kategorie: 'Bankverbindung', label: 'IBAN (Erstattungskonto)', eCodes: ['E0102102', 'E0102603'], severity: 'blocker',
    erwartetWenn: () => true, imBeleg: BANK, vorjahr: true, frage: 'Auf welches Konto (IBAN) soll eine Steuererstattung überwiesen werden?', herkunft: 'Bank-Steuerbescheinigung / Vorjahr (Z30)' },
  // ── Werbungskosten ──
  { id: 'pendler', kategorie: 'Werbungskosten', label: 'Entfernungspauschale (Pendlerpauschale)', eCodes: ['E0203504', 'E0203508'], severity: 'empfohlen',
    erwartetWenn: (c) => c.profile.has('Arbeitnehmer'), vorjahr: true, frage: 'Fahren Sie zur Arbeit? Entfernung (km), Arbeitstage und Tätigkeitsstätte senken über die Entfernungspauschale die Steuer.', herkunft: 'Vorjahres-Erklärung (Anlage N Z30–34)' },
  { id: 'arbeitsmittel', kategorie: 'Werbungskosten', label: 'Arbeitsmittel / weitere Werbungskosten', eCodes: ['E0204401'], severity: 'optional',
    erwartetWenn: (c) => c.profile.has('Arbeitnehmer'), vorjahr: true, frage: 'Hatten Sie beruflich Aufwendungen (Arbeitsmittel, Kontoführung, Fachliteratur, Bewerbung)?', herkunft: 'Vorjahres-Erklärung (Anlage N Z57–67)' },
  // ── Kapitalerträge ──
  { id: 'guenstiger', kategorie: 'Kapitalerträge', label: 'Günstigerprüfung / Überprüfung Steuereinbehalt', eCodes: ['E1900401', 'E1900501'], severity: 'empfohlen',
    erwartetWenn: (c) => c.profile.has('Kapitalanleger'), berechenbar: guenstigerBerechnen, frage: 'Soll die Günstigerprüfung für die Kapitalerträge beantragt werden?', herkunft: 'Anlage KAP Z4/5' },
];

/** Alle von der Soll-Liste kuratierten eCodes. Der generische Vorjahres-Audit
 *  (audit.ts §G) überspringt diese — sie werden hier mit konkretem Wert geführt,
 *  damit dieselbe Angabe nicht doppelt abgefragt wird. */
export const SOLL_ECODES: Set<string> = new Set(SOLL.flatMap((s) => s.eCodes));

export interface SollErgebnis { item: SollItem; status: RecoveryKind; hinweis: string; belegTyp?: string; vorjahrWert?: string; }
export interface SollReport {
  ergebnisse: SollErgebnis[];
  imBeleg: SollErgebnis[]; berechenbar: SollErgebnis[]; vorjahr: SollErgebnis[]; fehlt: SollErgebnis[];
  abdeckung: { erfuellt: number; recoverbar: number; fehlt: number; gesamt: number };
  profile: string[];
}

function ableitProfil(anlagen: Set<string>): Set<string> {
  const p = new Set<string>();
  if (anlagen.has('N')) p.add('Arbeitnehmer');
  if (anlagen.has('KAP')) p.add('Kapitalanleger');
  if (anlagen.has('R')) p.add('Rentner');
  if (anlagen.has('VOR')) p.add('Vorsorge');
  if (anlagen.has('V')) p.add('Vermietung');
  return p;
}

/** Prüft den Fall gegen die Soll-Liste und KLASSIFIZIERT jede Lücke nach Recovery-Quelle. */
export function pruefeSoll(data: CaseData): SollReport {
  const fields = data.fields ?? [];
  const present = new Set(fields.map((f) => f.eCode));
  const belegTypen = new Set((data.belege ?? []).map((b) => String(b.belegTyp ?? '')));
  const anlagen = new Set(fields.map((f) => String(f.anlage ?? '').toUpperCase()));
  const profile = ableitProfil(anlagen);
  const hatB = data.veranlagungsart === 'zusammen' || fields.some((f) => String(f.person) === 'B');
  const ctx: SollCtx = { profile, veranlagung: data.veranlagungsart ?? '', hatB };

  const ergebnisse: SollErgebnis[] = [];
  for (const item of SOLL) {
    if (!item.erwartetWenn(ctx)) continue;
    // 1. erfüllt
    if (item.eCodes.some((e) => present.has(e))) { ergebnisse.push({ item, status: 'erfuellt', hinweis: 'liegt als Feld vor' }); continue; }
    // 2. im_beleg — Wert steckt in einem vorhandenen Beleg, nur nicht extrahiert
    const beleg = (item.imBeleg ?? []).find((t) => belegTypen.has(t));
    if (beleg) { ergebnisse.push({ item, status: 'im_beleg', belegTyp: beleg, hinweis: `steht im Beleg „${beleg}" — wird extrahiert/bestätigt` }); continue; }
    // 3. berechenbar — aus den 2024-Daten ableitbar
    const ber = item.berechenbar?.(data);
    if (ber) { ergebnisse.push({ item, status: 'berechenbar', hinweis: ber.antwort }); continue; }
    // 4. vorjahr — stabile Stammdaten aus der Vorjahres-Erklärung übernehmen.
    //    Liegt ein echter Vorjahres-Beleg vor (data.vorjahr), den konkreten Wert
    //    zum Übernehmen anbieten statt nur generisch „übernehmbar".
    if (item.vorjahr) {
      const vj = (data.vorjahr?.felder ?? []).find((v) => item.eCodes.includes(v.eCode) && v.kind !== 'frage');
      ergebnisse.push({
        item, status: 'vorjahr', vorjahrWert: vj?.wert,
        hinweis: vj ? `aus der Vorjahres-Erklärung (${vj.dokumentJahr}) übernehmbar: ${vj.wert}` : 'aus der Vorjahres-Erklärung übernehmbar',
      });
      continue;
    }
    // 5. fehlt — in keiner Quelle, fragen
    ergebnisse.push({ item, status: 'fehlt', hinweis: 'in keiner Quelle vorhanden' });
  }

  const by = (k: RecoveryKind) => ergebnisse.filter((r) => r.status === k);
  const erfuellt = by('erfuellt').length;
  const fehlt = by('fehlt');
  return {
    ergebnisse, imBeleg: by('im_beleg'), berechenbar: by('berechenbar'), vorjahr: by('vorjahr'), fehlt,
    abdeckung: { erfuellt, recoverbar: ergebnisse.length - erfuellt - fehlt.length, fehlt: fehlt.length, gesamt: ergebnisse.length },
    profile: [...profile],
  };
}
