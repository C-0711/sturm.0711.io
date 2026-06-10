/**
 * web/extract-versorgungsbeginn — maßgebendes Kalenderjahr des Versorgungs-
 * beginns (Nr. 30 LStB), § 19 Abs. 2 Satz 3 EStG. Bestimmt die FESTGESCHRIEBENE
 * Versorgungsfreibetrags-Kohorte. Bei mehreren Versorgungsbezügen ist das
 * FRÜHESTE Jahr maßgebend (höchster Freibetrag) — der Aufrufer bildet das Min.
 *
 * Der Lane-1-Zeilenextraktor lässt Nr. 30 bewusst aus ("mehrdeutig"); hier
 * SEMANTISCH über das Label statt über die fragile Zeilennummer. Deterministisch,
 * kein Hardcode, kein Case-Wert.
 */
export function parseVersorgungsbeginn(text: string): number | null {
  if (!text) return null;
  // "maßgebende(s) Kalenderjahr des Versorgungsbeginns … 1991" (Jahr i.d.R.
  // rechts auf derselben Zeile, durch Whitespace getrennt).
  const m = text.match(
    /ma[ßs]gebende[sn]?\s+Kalenderjahr\s+des\s+Versorgungsbeginns[^\n\d]*((?:19|20)\d{2})/i,
  );
  if (!m) return null;
  const jahr = parseInt(m[1], 10);
  return jahr >= 1950 && jahr <= 2099 ? jahr : null;
}
