#!/usr/bin/env bash
#
# h200v-smoke-ocr-ensemble.sh — Smoke-Test gegen die neue Rust-Endpoint.
#
# Pre-conditions auf H200V (Lane 2 = OCR-required path):
#   • tornado-orchestrator gebaut + neu gestartet mit dem
#     `/api/v1/ocr-ensemble` Routing-Patch (pipeline.rs + server.rs).
#   • paddleocr-classical FastAPI läuft auf :11440 (vorhanden — Slice F).
#   • vLLM EmbeddingGemma auf :11436 erreichbar (vorhanden).
#   • Eine PDF als Testkandidat (z.B. eine der OCR-only Hildburg-Belege
#     wie "Steuerbescheinigung Volksbank 2024.pdf").
#
# Ablauf:
#   1. Health-Check
#   2. POST /api/v1/ocr-ensemble mit einer Test-PDF
#   3. Anzeigen wie viele consensus-records + tagged-pages zurückkamen
#   4. End-zu-End: rawText-Rekonstruktion via lane2-adapter
#
# Aufruf:
#   ./scripts/h200v-smoke-ocr-ensemble.sh [pdf_path]
#
set -euo pipefail

BASE_URL="${TORNADO_ORCHESTRATOR_URL:-http://h200v:7180}"
PDF_PATH="${1:-/Users/christophbertsch/Desktop/Belege/Erklärung HH/Steuerbescheinigung Volksbank 2024.pdf}"

if [ ! -f "$PDF_PATH" ]; then
  echo "PDF nicht gefunden: $PDF_PATH"
  exit 1
fi

echo "── Health-Check ──"
curl -sf "$BASE_URL/api/v1/health" -o /dev/null -w "HTTP %{http_code}\n" || {
  echo "Orchestrator nicht erreichbar an $BASE_URL"
  exit 2
}

echo ""
echo "── Version ──"
curl -sf "$BASE_URL/api/v1/version"
echo ""
echo ""

echo "── POST /api/v1/ocr-ensemble ──"
echo "PDF: $PDF_PATH  ($(stat -f '%z' "$PDF_PATH" 2>/dev/null || stat -c '%s' "$PDF_PATH") bytes)"
echo ""

RESPONSE_FILE="/tmp/ocr-ensemble-response.json"
HTTP_CODE=$(curl -sf -o "$RESPONSE_FILE" -w "%{http_code}" \
  --max-time 180 \
  -X POST "$BASE_URL/api/v1/ocr-ensemble" \
  -H "Content-Type: application/pdf" \
  --data-binary "@$PDF_PATH" || echo "fail")

if [ "$HTTP_CODE" != "200" ]; then
  echo "HTTP $HTTP_CODE — Response:"
  cat "$RESPONSE_FILE"
  exit 3
fi

echo "HTTP 200 — Response stats:"
node -e "
  const r = require('$RESPONSE_FILE');
  console.log('  document_sha256_hex:', r.document_sha256_hex);
  console.log('  consensus_pages    :', r.consensus_pages.length);
  console.log('  total records      :', r.consensus_pages.reduce((s,p) => s + p.records.length, 0));
  console.log('  tagged_pages       :', r.tagged_pages.length);
  console.log('  total tagged       :', r.tagged_pages.reduce((s,p) => s + p.records.length, 0));
  // erste 3 records pro page anzeigen
  for (const p of r.consensus_pages) {
    console.log('  --- page ' + p.page_index + ' ---');
    for (const rec of p.records.slice(0, 3)) {
      console.log('    text=\"' + rec.text.slice(0,40) + '\"  bbox=' + (rec.bbox ? 'yes' : 'null'));
    }
  }
"

echo ""
echo "✓ ocr-ensemble endpoint live + functional"
