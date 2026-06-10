/**
 * web/extract-kapital — Kapitalerträge (§20 EStG) aus Belegen, die der Haupt-
 * Extraktor offen lässt: Wohnstift-/Privatdarlehn-Zinsen ("Zinsertrag … beträgt
 * X EUR", ohne inländischen Steuerabzug) und Bank-Jahres-Steuerbescheinigungen
 * ("Höhe der Kapitalerträge … X"). Deterministisch, kein Hardcode.
 *
 * Hinweis: typischerweise unter dem Sparer-Pauschbetrag (1.000 €) → 0 € Steuer;
 * wird dennoch erfasst und ausgewiesen (Vollständigkeit).
 */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const euro = (s: string): number => {
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

export interface KapitalErtrag { betrag: number; art: 'darlehenszinsen' | 'kapitalertraege'; }

export function parseKapital(text: string): KapitalErtrag | null {
  if (!text) return null;
  // 1. Wohnstift-/Privatdarlehn: "Der Zinsertrag für das Jahr 2024 beträgt 654,48 EUR"
  //    (§20 Abs.1 Nr.7 — ohne inländischen Steuerabzug).
  let m = text.match(/Zinsertrag[^\n]{0,40}?betr[äa]gt\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s*EUR/i);
  if (m) { const b = euro(m[1]); if (b > 0) return { betrag: round2(b), art: 'darlehenszinsen' }; }
  // 2. Bank-Steuerbescheinigung: "Höhe der Kapitalerträge … 2,56"
  m = text.match(/H[öo]he der Kapitalertr[äa]ge[\s\S]{0,180}?(\d{1,3}(?:\.\d{3})*,\d{2})/i);
  if (m) { const b = euro(m[1]); if (b > 0) return { betrag: round2(b), art: 'kapitalertraege' }; }
  return null;
}
