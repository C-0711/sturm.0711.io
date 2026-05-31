/**
 * soll-katalog — profil-getriebene Vollständigkeits-Sollliste gegen die volle
 * Einkommensteuererklärung (ESt 1 A + Anlagen). Vergleicht ERWARTETE EST-Felder
 * mit dem, was im Fall vorhanden ist (extrahierte Felder + household), und liefert
 * die Lücken. Input für den Auditor: er fragt genau diese fehlenden Felder ab.
 *
 * Hergeleitet aus dem echten Stricker-EST-Vergleich (Adresse, IBAN, Geburtsdatum,
 * Pendlerpauschale, Günstigerprüfung fehlten) — eCodes/Zeilen aus atoms.json.
 */
import type { CaseData } from './audit.ts';

export type SollKategorie =
  | 'Stammdaten' | 'Bankverbindung' | 'Veranlagung' | 'Werbungskosten' | 'Kapitalerträge';

export interface SollItem {
  id: string;
  kategorie: SollKategorie;
  label: string;
  /** Erfüllt, sobald EINER dieser eCodes als Feld vorliegt. */
  eCodes: string[];
  severity: 'blocker' | 'empfohlen' | 'optional';
  /** Profil-/Veranlagungs-Bedingung — nur dann wird das Feld erwartet. */
  erwartetWenn: (ctx: SollCtx) => boolean;
  /** Vorformulierte Frage (der Auditor darf sie verfeinern). */
  frage: string;
  /** Aus welchem Beleg/Quelle der Wert normalerweise kommt. */
  herkunft: string;
}
export interface SollCtx { profile: Set<string>; veranlagung: string; hatB: boolean; }

const SOLL: SollItem[] = [
  // ── Stammdaten (Hauptvordruck) ──
  { id: 'gebdat-a', kategorie: 'Stammdaten', label: 'Geburtsdatum Person A', eCodes: ['E0100401'], severity: 'blocker',
    erwartetWenn: () => true, frage: 'Wie lautet das Geburtsdatum von Person A?', herkunft: 'Stammdaten (Pflichtangabe Z8)' },
  { id: 'gebdat-b', kategorie: 'Stammdaten', label: 'Geburtsdatum Person B', eCodes: ['E0101001'], severity: 'empfohlen',
    erwartetWenn: (c) => c.hatB, frage: 'Wie lautet das Geburtsdatum von Person B?', herkunft: 'Stammdaten (Z20)' },
  { id: 'adresse', kategorie: 'Stammdaten', label: 'Wohnanschrift (Straße, Hausnr., PLZ, Ort)', eCodes: ['E0101104', 'E0100602', 'E0100601'], severity: 'blocker',
    erwartetWenn: () => true, frage: 'Wie lautet die aktuelle Wohnanschrift (Straße, Hausnummer, PLZ, Ort)?', herkunft: 'Stammdaten (Pflichtangabe Z13–16)' },
  { id: 'heirat', kategorie: 'Veranlagung', label: 'Verheiratet/verpartnert seit', eCodes: ['E0100701'], severity: 'empfohlen',
    erwartetWenn: (c) => c.veranlagung === 'zusammen', frage: 'Seit wann besteht die Ehe bzw. Lebenspartnerschaft?', herkunft: 'Hauptvordruck Z18' },
  // ── Bankverbindung (Erstattung) ──
  { id: 'iban', kategorie: 'Bankverbindung', label: 'IBAN (Erstattungskonto)', eCodes: ['E0102102', 'E0102603'], severity: 'blocker',
    erwartetWenn: () => true, frage: 'Auf welches Konto (IBAN) soll eine Steuererstattung überwiesen werden?', herkunft: 'Hauptvordruck Z30' },
  // ── Werbungskosten (nur Arbeitnehmer) — senken das zvE ──
  { id: 'pendler', kategorie: 'Werbungskosten', label: 'Entfernungspauschale (Pendlerpauschale)', eCodes: ['E0203504', 'E0203508'], severity: 'empfohlen',
    erwartetWenn: (c) => c.profile.has('Arbeitnehmer'), frage: 'Fahren Sie zur Arbeit? Entfernung (km), Arbeitstage und Tätigkeitsstätte senken über die Entfernungspauschale die Steuer.', herkunft: 'Anlage N Z30–34' },
  { id: 'arbeitsmittel', kategorie: 'Werbungskosten', label: 'Arbeitsmittel / weitere Werbungskosten', eCodes: ['E0204401'], severity: 'optional',
    erwartetWenn: (c) => c.profile.has('Arbeitnehmer'), frage: 'Hatten Sie beruflich Aufwendungen (Arbeitsmittel, Kontoführung, Fachliteratur, Bewerbung)?', herkunft: 'Anlage N Z57–67' },
  // ── Kapitalerträge — Antrag, oft Erstattung ──
  { id: 'guenstiger', kategorie: 'Kapitalerträge', label: 'Günstigerprüfung / Überprüfung Steuereinbehalt', eCodes: ['E1900401', 'E1900501'], severity: 'empfohlen',
    erwartetWenn: (c) => c.profile.has('Kapitalanleger'), frage: 'Soll die Günstigerprüfung für die Kapitalerträge beantragt werden? Bei niedrigem Steuersatz oft eine Erstattung.', herkunft: 'Anlage KAP Z4/5' },
];

export interface SollErgebnis { item: SollItem; status: 'erfuellt' | 'fehlt'; }
export interface SollReport { ergebnisse: SollErgebnis[]; fehlt: SollItem[]; abdeckung: { erfuellt: number; gesamt: number }; profile: string[]; }

function ableitProfil(anlagen: Set<string>): Set<string> {
  const p = new Set<string>();
  if (anlagen.has('N')) p.add('Arbeitnehmer');
  if (anlagen.has('KAP')) p.add('Kapitalanleger');
  if (anlagen.has('R')) p.add('Rentner');
  if (anlagen.has('VOR')) p.add('Vorsorge');
  if (anlagen.has('V')) p.add('Vermietung');
  return p;
}

/** Prüft den Fall gegen die Soll-Liste → erfüllte + fehlende erwartete Felder. */
export function pruefeSoll(data: CaseData): SollReport {
  const fields = data.fields ?? [];
  const present = new Set(fields.map((f) => f.eCode));
  const anlagen = new Set(fields.map((f) => String(f.anlage ?? '').toUpperCase()));
  const profile = ableitProfil(anlagen);
  const hatB = data.veranlagungsart === 'zusammen' || fields.some((f) => String(f.person) === 'B');
  const ctx: SollCtx = { profile, veranlagung: data.veranlagungsart ?? '', hatB };

  const ergebnisse: SollErgebnis[] = [];
  for (const item of SOLL) {
    if (!item.erwartetWenn(ctx)) continue;
    const erfuellt = item.eCodes.some((e) => present.has(e));
    ergebnisse.push({ item, status: erfuellt ? 'erfuellt' : 'fehlt' });
  }
  const fehlt = ergebnisse.filter((r) => r.status === 'fehlt').map((r) => r.item);
  return { ergebnisse, fehlt, abdeckung: { erfuellt: ergebnisse.length - fehlt.length, gesamt: ergebnisse.length }, profile: [...profile] };
}
