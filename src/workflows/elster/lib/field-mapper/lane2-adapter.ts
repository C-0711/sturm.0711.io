/**
 * lane2-adapter — verwandelt OcrEnsembleResponse in rawText, sodass
 * mapBeleg() ohne Code-Änderung weiterläuft.
 *
 * Hintergrund:
 * field-mapper arbeitet auf einem flachen rawText-String (pdftotext-Output).
 * Lane 2 liefert structured records (Text + BBox + semantic tags). Der
 * einfachste Integrationspfad: serialize records zurück in einen
 * tabellen-artigen Text, der vom existierenden extractor.ts geparst wird.
 *
 * Strategie:
 *   • Pro Page: records nach (bbox.y_center, bbox.x_center) sortieren
 *   • Records auf der selben Zeile (y-toleranz) konkatenieren mit ≥2 spaces
 *     dazwischen — das matched LABEL_VALUE_SEP_RE im extractor.
 *
 * Limit:
 *   • Wenn bbox=null (vLLM-OCR ohne BBox-Output) → kein Layout
 *     reconstruction möglich; wir geben die Records einfach in
 *     insertion-order als Zeilen aus. Die meisten Schemas funktionieren
 *     dann nur eingeschränkt — aber für structured beleg (LStB, RBM, …)
 *     reicht es oft, weil OCR-Engines die Labels in der gleichen Reihe
 *     wie die Werte liefern.
 *
 * Weitere Entwicklung:
 *   • mapBelegFromTagged(taggedPages) — bypasst rawText und arbeitet
 *     direkt auf (record, candidates)-Paaren. Ist Slice P3b.
 */
import type {
  ConsensusPage,
  OcrEnsembleResponse,
} from './ocr-ensemble-client.ts';

/** Y-Toleranz für „auf derselben Zeile" (Pixel). */
const ROW_TOL_PX = 8;

/**
 * Bündelt records auf einer Page in zeilen-orientierte Strings.
 *
 * Pro page wird ein multi-line String erzeugt:
 *   Zeile 1: "<rec1>  <rec2>  <rec3>"   (≥2 spaces zwischen records)
 *   Zeile 2: ...
 *
 * Records ohne bbox landen am Ende der Page als einzelne Zeilen
 * (insertion order).
 */
function pageToText(page: ConsensusPage): string {
  const withBox = page.records.filter((r) => r.bbox !== null);
  const noBox = page.records.filter((r) => r.bbox === null);

  // (1) bbox-records: nach y-position clustern, dann nach x sortieren.
  // bbox-Format ist Wire-Array [x0, y0, x1, y1] aus dem Rust-Endpoint
  // (serde-into-attribute).
  type Boxed = {
    text: string;
    yCenter: number;
    xCenter: number;
  };
  const boxed: Boxed[] = withBox.map((r) => {
    const [x0, y0, x1, y1] = r.bbox!;
    return { text: r.text, yCenter: (y0 + y1) * 0.5, xCenter: (x0 + x1) * 0.5 };
  });
  boxed.sort((a, b) => a.yCenter - b.yCenter || a.xCenter - b.xCenter);

  // Clustering: greedy nach y-Toleranz
  const rows: Boxed[][] = [];
  for (const r of boxed) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].yCenter - r.yCenter) <= ROW_TOL_PX) {
      last.push(r);
    } else {
      rows.push([r]);
    }
  }
  // Pro Row: x-sortieren und mit 2 Spaces joinen (matched LABEL_VALUE_SEP_RE)
  const lines: string[] = rows.map((row) =>
    row
      .sort((a, b) => a.xCenter - b.xCenter)
      .map((r) => r.text)
      .join('   '),
  );

  // (2) no-bbox records: insertion-order als eigene Zeilen
  for (const r of noBox) {
    if (r.text.trim().length > 0) lines.push(r.text);
  }

  return lines.join('\n');
}

/**
 * Konvertiert die volle OcrEnsembleResponse in einen einzigen rawText,
 * sodass mapBeleg() in unveränderter Form weiterläuft.
 *
 * Page-Trennzeichen ist ein doppelter Newline — extractor.ts behandelt
 * leerzeilen sowieso als Separator.
 */
export function ocrEnsembleToRawText(response: OcrEnsembleResponse): string {
  return response.consensus_pages
    .sort((a, b) => a.page_index - b.page_index)
    .map(pageToText)
    .join('\n\n');
}
