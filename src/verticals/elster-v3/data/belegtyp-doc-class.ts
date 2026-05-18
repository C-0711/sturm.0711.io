/**
 * Mapping von `indikation.belegtyp` (Freitext aus beleg-indikation-Stage)
 * auf `doc_class` (= Dateiname in `nested_schemas/`).
 *
 * Multi-Doc-Bundles wie VAST ("1× Lohnsteuerbescheinigung + 2× Mitteilung
 * Kapitalerträge + 2× Religionsbescheinigung") liefern mehrere doc_classes
 * mit Häufigkeit. Der Workflow-Stage `layer1Extract` ruft pro distinct
 * doc_class einen separaten LLM-Call.
 */

export type DocClass =
  | 'lohnsteuerbescheinigung'
  | 'mitteilung_kapitalertraege'
  | 'religionszugehoerigkeit'
  | 'steuerbescheinigung_kapitalertraege'
  | 'personaldaten_hauptvordruck'
  | 'spendenquittung'
  | 'rentenbezugsmitteilung';

interface MappingRule {
  /** Substring im belegtyp (case-insensitive) → matched */
  match: string[];
  /** Optionaler Ausschluss-Substring */
  notMatch?: string[];
  docClass: DocClass;
}

const RULES: MappingRule[] = [
  // Reihenfolge wichtig: spezifischere Regeln zuerst.
  // Steuerbescheinigung Kapitalerträge (volle Bank-Jahressteuerbescheinigung)
  // vor Mitteilung freigestellte Kapitalerträge (nur Freistellungs-Betrag).
  { match: ['steuerbescheinigung'], notMatch: ['mitteilung'], docClass: 'steuerbescheinigung_kapitalertraege' },
  { match: ['jahressteuerbescheinigung'], docClass: 'steuerbescheinigung_kapitalertraege' },

  { match: ['mitteilung', 'kapitalertr'], docClass: 'mitteilung_kapitalertraege' },
  { match: ['freistellung'], docClass: 'mitteilung_kapitalertraege' },
  { match: ['freigestellte kapitalertr'], docClass: 'mitteilung_kapitalertraege' },

  { match: ['lohnsteuerbescheinigung'], docClass: 'lohnsteuerbescheinigung' },
  { match: ['lstb'], docClass: 'lohnsteuerbescheinigung' },
  { match: ['lohnsteuer-bescheinigung'], docClass: 'lohnsteuerbescheinigung' },

  { match: ['religionszugeh'], docClass: 'religionszugehoerigkeit' },
  { match: ['religionsbescheinigung'], docClass: 'religionszugehoerigkeit' },
  { match: ['konfession'], notMatch: ['lohnsteuer'], docClass: 'religionszugehoerigkeit' },

  { match: ['spende'], docClass: 'spendenquittung' },
  { match: ['mitgliedsbeitrag'], docClass: 'spendenquittung' },
  { match: ['zuwendungsbestätigung'], docClass: 'spendenquittung' },

  { match: ['rentenbezugsmitteilung'], docClass: 'rentenbezugsmitteilung' },
  { match: ['renten-bezugsmitteilung'], docClass: 'rentenbezugsmitteilung' },

  { match: ['personaldaten'], docClass: 'personaldaten_hauptvordruck' },
  { match: ['hauptvordruck'], docClass: 'personaldaten_hauptvordruck' },
  { match: ['est1a'], docClass: 'personaldaten_hauptvordruck' },
];

function matchesRule(text: string, rule: MappingRule): boolean {
  if (rule.notMatch?.some((n) => text.includes(n))) return false;
  return rule.match.every((m) => text.includes(m));
}

/**
 * Resolves ein einzelnes belegtyp-Snippet auf eine doc_class.
 * Liefert null wenn kein Mapping greift.
 */
export function resolveDocClass(belegtyp: string | null | undefined): DocClass | null {
  if (!belegtyp) return null;
  const norm = belegtyp.toLowerCase().normalize('NFKD');
  for (const rule of RULES) {
    if (matchesRule(norm, rule)) return rule.docClass;
  }
  return null;
}

/**
 * Multi-Doc-Bundle-Parser. Beispiel-Input:
 *   "1× Lohnsteuerbescheinigung + 2× Mitteilung Kapitalerträge + 2× Religionsbescheinigung"
 * Output:
 *   [{ docClass: 'lohnsteuerbescheinigung', count: 1 },
 *    { docClass: 'mitteilung_kapitalertraege', count: 2 },
 *    { docClass: 'religionszugehoerigkeit', count: 2 }]
 *
 * Bei Single-Doc-belegtyp ("Lohnsteuerbescheinigung") liefert es 1 Entry mit count=1.
 */
export interface DocClassEntry {
  docClass: DocClass;
  count: number;
}

export function resolveDocClasses(belegtyp: string | null | undefined): DocClassEntry[] {
  if (!belegtyp) return [];
  // Multi-Doc-Pattern: "N× Typ + N× Typ + ..." oder "Typ und Typ und ..."
  // Split an "+", "und", " - ", ",".
  const parts = belegtyp.split(/\s*(?:\+|\sund\s|,)\s*/);
  const acc = new Map<DocClass, number>();
  for (const part of parts) {
    if (!part.trim()) continue;
    // Count-Präfix: "1×", "2x", "2 ×"
    const m = part.match(/^\s*(\d+)\s*[×x]\s*(.+)$/);
    const count = m ? Number(m[1]) : 1;
    const rest = m ? m[2] : part;
    const dc = resolveDocClass(rest);
    if (dc) acc.set(dc, (acc.get(dc) ?? 0) + count);
  }
  // Single-Doc-Fallback wenn das Split nichts gefunden hat
  if (acc.size === 0) {
    const dc = resolveDocClass(belegtyp);
    if (dc) acc.set(dc, 1);
  }
  return Array.from(acc.entries()).map(([docClass, count]) => ({ docClass, count }));
}
