/**
 * web/extract-sonderausgaben — deterministische Parser für Belegtypen, die der
 * Haupt-Extraktor (noch) nicht abdeckt, deren Werte aber in die Berechnung
 * gehören. Liefern die kanonischen ELSTER-E-Codes, die der BMF-MCP bereits
 * verarbeitet (Module vorsorgeaufwand/haushaltsnahe_35a/spenden_10b):
 *
 *   • KV/PV-Basisbeiträge (PKV-Beitragsbescheinigung)  → E0202504 / E0202604
 *   • §35a haushaltsnahe Dienstleistungen (Arbeitslohnanteil) → E0107301
 *   • Spenden / Zuwendungen (§10b)                     → E0108701
 *
 * Rein strukturell (Labels/Summen-Zeilen), KEINE Case-Werte hartcodiert.
 * `text` kommt vom Aufrufer (pdftotext für Text-PDFs, OCR-Cache für Bilder).
 */

function parseDe(s: string): number {
  const n = Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;
const AMOUNT = /(-?\d{1,3}(?:\.\d{3})*,\d{2})/;   // deutsche Beträge mit Cent

/** PKV-Beitragsbescheinigung → abziehbare Basis-Beiträge KV + Pflege.
 *  E0202504 = Basis-Kranken, E0202604 = Pflege-Pflicht. */
export function parseKvPvBasis(text: string): { kv: number; pv: number } | null {
  if (!/Beitragsbescheinigung|Beitragsart|Basisleistung|Pflege(pflicht)?versicherung/i.test(text)) return null;
  const lines = text.split('\n');
  let art: 'kv' | 'pv' | null = null;
  let kv = 0, pv = 0;
  for (const line of lines) {
    // Beitragsart-Zeilen setzen den Kontext (mehrzeilig möglich)
    if (/Pflege(pflicht)?versicherung|Pflege-Pflicht/i.test(line)) art = 'pv';
    else if (/Krankenversicherung/i.test(line) && !/Pflege/i.test(line)) art = 'kv';
    // „Höhe der geleisteten/erstatteten Beiträge …  <Betrag>"
    if (/H[öo]he der geleisteten/i.test(line)) {
      const m = line.match(AMOUNT);
      if (m && art) { const v = parseDe(m[1]); if (art === 'kv' && !kv) kv = v; else if (art === 'pv' && !pv) pv = v; }
    }
  }
  if (kv === 0 && pv === 0) return null;
  return { kv: round2(kv), pv: round2(pv) };
}

/** §35a-Jahresbescheinigung (Wohnstift/Dienstleister) → Arbeitslohnanteil
 *  haushaltsnahe Dienstleistungen (Abs. 2). Summiert die reinen „Summe <Betrag>"-
 *  Abschnittszeilen; Brutto-„Entgeltbestandteil/Entgelte"-Zeilen werden NICHT
 *  gezählt. Liefert die abzugsfähige Basis (20%-Ermäßigung rechnet der MCP). */
export function parse35aBasis(text: string): { haushaltsnah: number } | null {
  // NUR echte §35a-Bescheinigungen (Wohnstift/Dienstleister), die explizit
  // „Aufwendungen für haushaltsnahe …" ausweisen — NICHT der ESt-Bescheid, der
  // §35a bloß als Ergebnis nennt (sonst würde dessen „Summe" fälschlich gezogen).
  if (/Steuerbescheid/i.test(text)) return null;
  if (!/Aufwendungen\s+f[üu]r\s+haushaltsnahe/i.test(text)) return null;
  let sum = 0, hits = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!/^Summe\b/i.test(t)) continue;
    if (/Entgelt/i.test(t)) continue;                 // Brutto-Entgelt-Summe ausschließen
    const m = t.match(AMOUNT);
    if (m) { sum += parseDe(m[1]); hits++; }
  }
  if (hits === 0 || sum <= 0) return null;
  return { haushaltsnah: round2(sum) };
}

/** Zuwendungsbestätigung/Spenden (§10b) → belegter Spendenbetrag.
 *  Konservativ: nur Beträge aus offiziellen Zuwendungsbestätigungen bzw.
 *  klar als „Spende/Zuwendung … <Betrag>" ausgewiesene Zeilen. */
export function parseSpenden(text: string): { betrag: number } | null {
  if (!/Zuwendung|Spende/i.test(text)) return null;
  let sum = 0, hits = 0;
  for (const line of text.split('\n')) {
    if (!/(Zuwendung|Spende|gespendet|Betrag)/i.test(line)) continue;
    const m = line.match(AMOUNT);
    if (m) { const v = parseDe(m[1]); if (v > 0 && v < 100000) { sum += v; hits++; } }
  }
  if (hits === 0 || sum <= 0) return null;
  return { betrag: round2(sum) };
}
