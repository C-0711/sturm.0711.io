#!/usr/bin/env node
/**
 * Parse the official ELSTER Jahresdokumentation (SpreadsheetML XML, ~13 MB)
 * and emit two JSON catalogs consumed by the ELSTER vertical at runtime:
 *
 *   feld_katalog_full.json   — every eCode with bezeichnung, xpath, datentyp,
 *                              regex, pflicht-status, vordruckzeile, drucktext
 *   hinweisregeln.json       — every Plausibilitäts-/Hinweisregel per Anlage
 *                              with prüfbedingung-expression + fehlertext
 *
 * Usage:
 *   node scripts/preprocess-jahresdokumentation.mjs \
 *     --in  "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/0711-CTAXpro/Falldaten/test_suite/Taxcatalog_Elster/Jahresdokumentation_10_2024 1.xml" \
 *     --out src/verticals/elster/data
 *
 * The script is deterministic; re-running with the same input produces
 * byte-identical output (except for the catalogVersion timestamp, which
 * defaults to the source filename).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { in: null, out: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--in') args.in = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--verbose' || argv[i] === '-v') args.verbose = true;
  }
  if (!args.in) {
    args.in = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/Desktop/0711-CTAXpro/Falldaten/test_suite/Taxcatalog_Elster/Jahresdokumentation_10_2024 1.xml`;
  }
  if (!args.out) {
    args.out = resolve(REPO_ROOT, 'src/verticals/elster/data');
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// SpreadsheetML row parser. The format is verbose but predictable:
//
//   <Worksheet ss:Name="ESt1A - Felder">
//     <Table>
//       <Row>
//         <Cell><ss:Data ss:Type="String">Kontext</ss:Data></Cell>
//         <Cell><ss:Data ss:Type="String">Name</ss:Data></Cell>
//         …
//       </Row>
//       <Row>…</Row>
//     </Table>
//   </Worksheet>
//
// Cells can have ss:Index="N" to skip columns; we honor that so column-aligned
// data stays aligned even when empty cells are omitted.
// ─────────────────────────────────────────────────────────────────────────────

const RX_WORKSHEET = /<Worksheet\s+ss:Name="([^"]+)"[^>]*>([\s\S]*?)<\/Worksheet>/g;
const RX_ROW = /<Row(?:\s[^>]*)?>([\s\S]*?)<\/Row>/g;
const RX_CELL = /<Cell([^>]*)>(?:\s*<ss:Data[^>]*>([\s\S]*?)<\/ss:Data>\s*)?<\/Cell>/g;
const RX_INDEX_ATTR = /\bss:Index="(\d+)"/;

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function parseRow(rowXml) {
  const cells = [];
  let col = 0;
  RX_CELL.lastIndex = 0;
  let m;
  while ((m = RX_CELL.exec(rowXml))) {
    const attrs = m[1] || '';
    const idxMatch = RX_INDEX_ATTR.exec(attrs);
    if (idxMatch) {
      const targetIdx = parseInt(idxMatch[1], 10) - 1;
      while (col < targetIdx) {
        cells.push('');
        col++;
      }
    }
    cells.push(decodeEntities(m[2] || '').trim());
    col++;
  }
  return cells;
}

function parseWorksheet(xmlChunk) {
  const rows = [];
  RX_ROW.lastIndex = 0;
  let m;
  while ((m = RX_ROW.exec(xmlChunk))) {
    rows.push(parseRow(m[1]));
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet-shape readers. Header row defines column meanings; data rows follow.
// ─────────────────────────────────────────────────────────────────────────────

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h);
  return rows.slice(1).map((r) => {
    const o = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (!key) continue;
      o[key] = r[i] ?? '';
    }
    return o;
  });
}

const ECODE_RX = /^E\d{7}$/;

function isEcode(s) {
  return typeof s === 'string' && ECODE_RX.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregator: walk all Worksheets and split into per-Anlage buckets.
// ─────────────────────────────────────────────────────────────────────────────

async function parseDocument(xmlPath, verbose) {
  const data = await readFile(xmlPath, 'utf-8');
  const buckets = new Map(); // anlage -> { felder: [...], regeln: [...], kennzahlen: [...], texte: [...], kontexte: [...] }
  const stats = { worksheets: 0, totalEcodes: new Set(), totalRules: 0 };

  RX_WORKSHEET.lastIndex = 0;
  let m;
  while ((m = RX_WORKSHEET.exec(data))) {
    const name = m[1];
    if (!name.includes(' - ')) continue;
    const [anlage, kind] = name.split(' - ');
    stats.worksheets++;
    const rows = parseWorksheet(m[2]);
    const objs = rowsToObjects(rows);
    if (!buckets.has(anlage)) {
      buckets.set(anlage, { felder: [], regeln: [], kennzahlen: [], texte: [], kontexte: [] });
    }
    const bucket = buckets.get(anlage);
    if (kind === 'Felder') {
      for (const o of objs) {
        if (!isEcode(o.Name)) continue;
        bucket.felder.push({
          eCode: o.Name,
          kontext: o.Kontext || '',
          bezeichnung: o.Beschreibung || '',
          maxZeilen: numOrNull(o['max. Zeilen']),
          format: o.Format || '',
          formatRegex: o['Format als regulärer Ausdruck'] || '',
          formatkennzeichen: o.Formatkennzeichen || '',
          minLaenge: numOrNull(o['Min. Länge']),
          maxLaenge: numOrNull(o['Max. Länge']),
          pflicht: parseBool(o.Pflichtfeld),
          vordruckzeile: o.Vordruckzeile || '',
          drucktext: o.Drucktext || '',
          internesERiCFeld: o['Internes ERiC-Feld'] || '',
        });
        stats.totalEcodes.add(o.Name);
      }
    } else if (kind === 'Regeln') {
      for (const o of objs) {
        if (!o.Name && !o['Prüfbedingung']) continue;
        bucket.regeln.push({
          name: o.Name || '',
          kontext: o.Kontext || '',
          fehlercode: o.Fehlercode || '',
          beschreibung: o.Beschreibung || '',
          pruefbedingung: o['Prüfbedingung'] || '',
          fehlertext: o['Fehler- /Hinweistext'] || '',
          mehrereVordrucke: o['Prüfung für mehrere Vordrucke (Vordruck von - bis)'] || '',
          mehrereZeilen: o['Prüfung für mehrere Zeilen (Zeile von - bis)'] || '',
          severity: detectSeverity(o['Fehler- /Hinweistext'] || '', o.Fehlercode || ''),
        });
        stats.totalRules++;
      }
    } else if (kind === 'Kennzahlen') {
      for (const o of objs) {
        if (!o.Feldname) continue;
        bucket.kennzahlen.push({
          feldname: o.Feldname,
          lfdNrVordruck: o['Lfd. Nr. Vordruck'] || '',
          mzi: o.MZI || '',
          sachbereich: o.Sachbereich || '',
          kennzahl: o.Kennzahl || '',
          aenderungsinformation: o.Änderungsinformation || '',
          aenderungsdetails: o.Änderungsdetails || '',
        });
      }
    } else if (kind === 'Texte') {
      bucket.texte.push(...objs);
    } else if (kind === 'Kontexte') {
      bucket.kontexte.push(...objs);
    }
  }

  if (verbose) {
    console.error(`Parsed ${stats.worksheets} worksheets across ${buckets.size} anlagen`);
    console.error(`Total distinct eCodes: ${stats.totalEcodes.size}`);
    console.error(`Total rules: ${stats.totalRules}`);
  }
  return { buckets, stats };
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBool(v) {
  if (!v) return false;
  const s = String(v).toLowerCase().trim();
  return s === 'pflicht' || s === 'ja' || s === 'true' || s === '1' || s === 'p';
}

function detectSeverity(fehlertext, fehlercode) {
  const lower = (fehlertext + ' ' + fehlercode).toLowerCase();
  if (lower.includes('hinweis') || lower.startsWith('h_')) return 'hinweis';
  if (lower.includes('fehler') || lower.startsWith('f_')) return 'fehler';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Output writers
// ─────────────────────────────────────────────────────────────────────────────

function buildFeldKatalog(buckets, sourceFile) {
  const anlagen = {};
  let totalCodes = 0;
  for (const [name, b] of [...buckets.entries()].sort()) {
    if (b.felder.length === 0 && b.regeln.length === 0 && b.kennzahlen.length === 0) continue;
    // Index felder by eCode for O(1) lookup. Multiple kontext-bindings per eCode
    // are collapsed into kontextPaths array.
    const byCode = new Map();
    for (const f of b.felder) {
      const existing = byCode.get(f.eCode);
      if (existing) {
        if (f.kontext && !existing.kontextPaths.includes(f.kontext)) {
          existing.kontextPaths.push(f.kontext);
        }
      } else {
        byCode.set(f.eCode, {
          eCode: f.eCode,
          bezeichnung: f.bezeichnung,
          datentyp: mapFormatToDatentyp(f.format, f.formatkennzeichen),
          format: f.format,
          formatkennzeichen: f.formatkennzeichen,
          formatRegex: f.formatRegex,
          minLaenge: f.minLaenge,
          maxLaenge: f.maxLaenge,
          maxZeilen: f.maxZeilen,
          pflicht: f.pflicht,
          vordruckzeile: f.vordruckzeile,
          drucktext: f.drucktext,
          kontextPaths: f.kontext ? [f.kontext] : [],
        });
      }
    }
    const codes = [...byCode.values()].sort((a, b) => a.eCode.localeCompare(b.eCode));
    anlagen[name] = {
      anlage: name,
      codeCount: codes.length,
      codes,
    };
    totalCodes += codes.length;
  }
  return {
    schemaId: 'elster',
    catalogVersion: basename(sourceFile),
    generatedAt: new Date().toISOString(),
    anlagenCount: Object.keys(anlagen).length,
    totalCodes,
    anlagen,
  };
}

function buildHinweisregeln(buckets, sourceFile) {
  const anlagen = {};
  let totalRules = 0;
  for (const [name, b] of [...buckets.entries()].sort()) {
    if (b.regeln.length === 0) continue;
    const rules = b.regeln.map((r) => ({
      ...r,
      // Pre-extract referenced eCodes for fast cross-validation lookup
      referencedECodes: extractEcodes(r.pruefbedingung + ' ' + r.fehlertext),
    }));
    anlagen[name] = {
      anlage: name,
      ruleCount: rules.length,
      rules,
    };
    totalRules += rules.length;
  }
  return {
    schemaId: 'elster',
    catalogVersion: basename(sourceFile),
    generatedAt: new Date().toISOString(),
    anlagenCount: Object.keys(anlagen).length,
    totalRules,
    anlagen,
  };
}

function extractEcodes(s) {
  if (!s) return [];
  const matches = s.match(/E\d{7}/g);
  if (!matches) return [];
  return [...new Set(matches)].sort();
}

function mapFormatToDatentyp(format, kennzeichen) {
  const k = (kennzeichen || '').toUpperCase();
  if (k.includes('GANZZAHL') || k.includes('NUMERIC')) return 'integer';
  if (k.includes('DEZIMAL') || k.includes('CURRENCY') || k.includes('BETRAG')) return 'currency';
  if (k.includes('DATUM') || k.includes('DATE')) return 'date';
  if (k.includes('KENNZ') || k.includes('FLAG') || k.includes('BOOLEAN')) return 'boolean';
  const f = (format || '').toLowerCase();
  if (f.includes('datum') || f.includes('date')) return 'date';
  if (f.includes('betrag') || f.includes('zahl') || f.includes('komma')) return 'currency';
  if (f.includes('ganzzahl') || /\bn\d+\b/.test(f)) return 'integer';
  if (f.includes('kennz') || f.includes('flag')) return 'boolean';
  return 'string';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const xmlPath = args.in;
  const outDir = args.out;

  console.error(`Reading: ${xmlPath}`);
  const { buckets, stats } = await parseDocument(xmlPath, args.verbose);

  await mkdir(outDir, { recursive: true });

  const feldKatalog = buildFeldKatalog(buckets, xmlPath);
  const feldKatalogPath = resolve(outDir, 'feld_katalog_full.json');
  await writeFile(feldKatalogPath, JSON.stringify(feldKatalog, null, 2) + '\n', 'utf-8');
  console.error(`Wrote ${feldKatalogPath}`);
  console.error(`  anlagen: ${feldKatalog.anlagenCount}, distinct eCodes: ${feldKatalog.totalCodes}`);

  const hinweisregeln = buildHinweisregeln(buckets, xmlPath);
  const hinweisregelnPath = resolve(outDir, 'hinweisregeln.json');
  await writeFile(hinweisregelnPath, JSON.stringify(hinweisregeln, null, 2) + '\n', 'utf-8');
  console.error(`Wrote ${hinweisregelnPath}`);
  console.error(`  anlagen: ${hinweisregeln.anlagenCount}, total rules: ${hinweisregeln.totalRules}`);

  // Sanity check vs. the known 2287 distinct-eCode count
  if (feldKatalog.totalCodes < 2200) {
    console.error(`WARN: extracted only ${feldKatalog.totalCodes} eCodes — expected ~2287. Inspect parser.`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
