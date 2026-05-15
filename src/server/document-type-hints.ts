/**
 * eCode → Belegtyp-Suggestion. Welche Dokumentart liefert typischerweise
 * den Wert für einen bestimmten ELSTER-eCode?
 *
 * Wird in der Pflicht-Missing-Liste als Hint angezeigt: "Bezeichnung des
 * Feldes — vermutlich in: Lohnsteuerbescheinigung".
 *
 * Diese Tabelle ist Best-Effort und manuell kuratiert. Sie ist *nicht*
 * Teil der Extraction-Logik — die nutzt den BMF-Container — sondern reine
 * UI-Suggestion. Erweiterung pro Beobachtung gerne, kein Refactor nötig.
 *
 * Prefix-Matching: ein eCode wie "E0200xxx" matcht die Regel "E0200" als
 * Fallback wenn kein exakter Eintrag existiert.
 */

const EXACT: Record<string, string[]> = {
  // Anlage N — Bruttoarbeitslohn, Lohnsteuer, Soli, Kirchensteuer
  'E0200201': ['Lohnsteuerbescheinigung'],
  'E0200202': ['Lohnsteuerbescheinigung'],
  'E0200301': ['Lohnsteuerbescheinigung'],
  'E0200302': ['Lohnsteuerbescheinigung'],
  'E0200401': ['Lohnsteuerbescheinigung'],
  'E0200402': ['Lohnsteuerbescheinigung'],
  'E0200501': ['Lohnsteuerbescheinigung'],
  'E0200502': ['Lohnsteuerbescheinigung'],
};

const PREFIX: Array<{ prefix: string; docs: string[] }> = [
  { prefix: 'E0200',  docs: ['Lohnsteuerbescheinigung'] },
  { prefix: 'E0700',  docs: ['Spendenquittung', 'Mitgliedsbescheinigung Kirchensteuer'] },
  { prefix: 'E1100',  docs: ['Rentenbezugsmitteilung'] },
  { prefix: 'E1300',  docs: ['Kapitalertragsbescheinigung'] },
  { prefix: 'E1404',  docs: ['Steuerbescheinigung Bank'] },
  { prefix: 'E1500',  docs: ['Beitragsbescheinigung Krankenversicherung'] },
  { prefix: 'E1600',  docs: ['Beitragsbescheinigung Pflegeversicherung'] },
  { prefix: 'E1700',  docs: ['Beitragsbescheinigung Arbeitslosenversicherung'] },
  { prefix: 'E1800',  docs: ['Beitragsbescheinigung Berufsunfähigkeit', 'Beitragsbescheinigung Riester'] },
  { prefix: 'E2000',  docs: ['Werbungskosten-Belege (Fahrten, Arbeitsmittel, Fortbildung)'] },
  { prefix: 'E2300',  docs: ['Haushaltsnahe Dienstleistungen / Handwerker-Rechnung'] },
  { prefix: 'E2400',  docs: ['Spendenquittung (Gemeinnützig)'] },
  { prefix: 'E0107',  docs: ['(berechnet von Lane-1 BMF — nicht manuell zu pflegen)'] },
  { prefix: 'E0110',  docs: ['ESt 1A Mantelbogen (Personendaten)'] },
];

export function suggestedDocsForECode(eCode: string): string[] {
  if (EXACT[eCode]) return EXACT[eCode];
  for (const p of PREFIX) {
    if (eCode.startsWith(p.prefix)) return p.docs;
  }
  return [];
}

/** Bulk-Lookup für die Pflicht-Missing-Liste — Map<eCode, string[]>. */
export function documentTypeHintsMap(eCodes: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of eCodes) {
    const sugg = suggestedDocsForECode(c);
    if (sugg.length > 0) out[c] = sugg;
  }
  return out;
}
