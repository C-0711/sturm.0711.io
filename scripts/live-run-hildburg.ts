/**
 * live-run-hildburg.ts — End-to-End-Lauf field-mapper gegen Hildburg-Belege
 *
 * Echte Belege statt Test-Fixtures. pdftotext (poppler-utils) extrahiert
 * den text-layer der digitalen VaSt-PDFs; danach mapBeleg() pro Beleg.
 *
 * Ausführung:
 *   tsx scripts/live-run-hildburg.ts
 *
 * Exit-Code:
 *   0 — alle erwarteten Belegtypen erkannt, ≥1 Required-Feld pro Beleg gefunden
 *   1 — mindestens ein Beleg konnte gar nicht klassifiziert werden
 *   2 — mindestens ein required-Feld fehlt
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mapBeleg, aggregate } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import type { BelegInput, BelegTyp, MappingResult } from '../src/workflows/elster/lib/field-mapper/types.ts';

const BELEGE_DIR = '/Users/christophbertsch/Desktop/Belege/Erklärung HH';

// Filename-pattern → expected BelegTyp + Person.
// Hildburg is Person A throughout her household.
interface Fixture {
  filename: string;
  belegTyp: BelegTyp;
  person: 'A' | 'B';
  description: string;
}

const FIXTURES: Fixture[] = [
  {
    filename: 'Lohnsteuerbescheinigung_2024_57438590613_LBV_NRW.pdf',
    belegTyp: 'VaSt_LStB',
    person: 'A',
    description: 'LStB LBV NRW (Steuerklasse 1 — Hauptarbeitgeber)',
  },
  {
    filename: 'Lohnsteuerbescheinigung_2024_57438590613_Philips_GmbH.pdf',
    belegTyp: 'VaSt_LStB',
    person: 'A',
    description: 'LStB Philips GmbH (Steuerklasse 6 — Zweitarbeitgeber)',
  },
  {
    filename: 'Rentenbezugsmitteilung_2024_57438590613_Deutsche_Rentenversicherung_Bund.pdf',
    belegTyp: 'VaSt_RBM',
    person: 'A',
    description: 'RBM Deutsche Rentenversicherung Bund (gesetzlich)',
  },
  {
    filename: 'Rentenbezugsmitteilung_2024_57438590613_Philips_Pensionskasse__VVaG_.pdf',
    belegTyp: 'VaSt_RBM',
    person: 'A',
    description: 'RBM Philips Pensionskasse (bAV — Branch erwartet)',
  },
  {
    filename: 'Krankenversicherung_2024_57438590613_Debeka_Krankenversicherungsverein_a._G..pdf',
    belegTyp: 'VaSt_KRV',
    person: 'A',
    description: 'KRV Debeka (privat — Hildburg ist Beamtin)',
  },
  {
    filename: 'Kapitalertraege_mit_Freistellungsauftrag_2024_57438590613_Kreissparkasse_Ahrweiler.pdf',
    belegTyp: 'VaSt_FSA',
    person: 'A',
    description: 'FSA Kreissparkasse Ahrweiler',
  },
  {
    filename: 'Kapitalertraege_mit_Freistellungsauftrag_2024_57438590613_VR_Bank_RheinAhrEifel_eG.pdf',
    belegTyp: 'VaSt_FSA',
    person: 'A',
    description: 'FSA VR Bank RheinAhrEifel',
  },
  {
    filename: 'Religionszugehoerigkeit_2024_57438590613_Finanzverwaltung.pdf',
    belegTyp: 'VaSt_Religion',
    person: 'A',
    description: 'Religionszugehörigkeit (Finanzverwaltung)',
  },
  {
    filename: 'Stammdaten_2024_57438590613_Finanzverwaltung.pdf',
    belegTyp: 'VaSt_Pers',
    person: 'A',
    description: 'Stammdaten (Finanzverwaltung)',
  },
  {
    filename: 'Steuerbescheinigung Volksbank 2024.pdf',
    belegTyp: 'Steuerbescheinigung_Bank',
    person: 'A',
    description: 'Steuerbescheinigung Volksbank 2024 (echte Kapitalerträge)',
  },
];

function extractText(pdfPath: string): string {
  // pdftotext -layout preserves the "Label   Wert" Tabellenform
  // die unser extractor.ts in Strategy 1 erwartet.
  return execSync(
    `pdftotext -layout ${JSON.stringify(pdfPath)} -`,
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
}

interface RunStats {
  fixture: Fixture;
  pdfBytes: number;
  textChars: number;
  extractMs: number;
  mapMs: number;
  result: MappingResult | null;
  error: string | null;
}

function runOne(f: Fixture): RunStats {
  const pdfPath = `${BELEGE_DIR}/${f.filename}`;
  if (!existsSync(pdfPath)) {
    return {
      fixture: f, pdfBytes: 0, textChars: 0, extractMs: 0, mapMs: 0,
      result: null, error: `MISSING: ${pdfPath}`,
    };
  }

  const t0 = performance.now();
  let rawText: string;
  try {
    rawText = extractText(pdfPath);
  } catch (e) {
    return {
      fixture: f, pdfBytes: 0, textChars: 0, extractMs: 0, mapMs: 0,
      result: null, error: `pdftotext failed: ${(e as Error).message}`,
    };
  }
  const t1 = performance.now();

  const input: BelegInput = {
    belegTyp: f.belegTyp,
    person: f.person,
    rawText,
    source: { pdfPath },
  };
  const result = mapBeleg(input);
  const t2 = performance.now();

  // Approx PDF size via fs.statSync would be cleaner, but we don't need
  // it for correctness — just for the report.
  let pdfBytes = 0;
  try {
    const { statSync } = require('node:fs');
    pdfBytes = statSync(pdfPath).size;
  } catch {
    pdfBytes = 0;
  }

  return {
    fixture: f, pdfBytes, textChars: rawText.length,
    extractMs: Math.round(t1 - t0),
    mapMs: Math.round(t2 - t1),
    result, error: null,
  };
}

function classify(s: RunStats): 'ok' | 'partial' | 'fail' {
  if (s.error || !s.result) return 'fail';
  if (s.result.missingExpected.length > 0) return 'partial';
  if (s.result.felder.length === 0) return 'fail';
  return 'ok';
}

function fmt(n: number): string {
  return n.toLocaleString('de-DE');
}

function main(): void {
  console.log('');
  console.log('═'.repeat(82));
  console.log(`  live-run-hildburg  —  field-mapper gegen ${FIXTURES.length} echte Belege`);
  console.log(`  Belege-Dir: ${BELEGE_DIR}`);
  console.log('═'.repeat(82));
  console.log('');

  const stats: RunStats[] = [];
  const allResults: MappingResult[] = [];
  for (const fx of FIXTURES) {
    const s = runOne(fx);
    stats.push(s);
    if (s.result) allResults.push(s.result);
  }

  // ── Per-Beleg Detail ────────────────────────────────────────────────────
  console.log('Per-Beleg Detail:');
  console.log('─'.repeat(82));
  for (const s of stats) {
    const status = classify(s);
    const flag = status === 'ok' ? '✓' : status === 'partial' ? '◐' : '✗';
    const r = s.result;
    console.log('');
    console.log(`${flag} [${s.fixture.belegTyp.padEnd(24)}] ${s.fixture.description}`);
    console.log(`     ${s.fixture.filename}`);
    if (s.error) {
      console.log(`     ERROR: ${s.error}`);
      continue;
    }
    if (r) {
      console.log(
        `     pdf=${fmt(s.pdfBytes)}B  text=${fmt(s.textChars)}c  `
        + `extract=${s.extractMs}ms  map=${s.mapMs}ms`,
      );
      console.log(
        `     felder=${r.felder.length}  required-missing=${r.missingExpected.length}  `
        + `unmatched=${r.unmatched.length}  warnings=${r.warnings.length}`,
      );
      for (const f of r.felder) {
        const w = (f.warnings ?? []).length > 0 ? '⚠' : ' ';
        console.log(
          `       ${w} ${f.eCode.padEnd(10)} ${f.anlage.padEnd(6)} `
          + `${(f.kontextSubpath ?? '').padEnd(40)} `
          + `${f.wert.padEnd(15)} ← ${f.pdfLabel.slice(0, 38)}`,
        );
      }
      if (r.missingExpected.length > 0) {
        console.log(`     missing-required: ${r.missingExpected.join(', ')}`);
      }
      if (r.warnings.length > 0) {
        for (const w of r.warnings) console.log(`     warning: ${w}`);
      }
    }
  }

  // ── Aggregation über alle Belege ────────────────────────────────────────
  console.log('');
  console.log('═'.repeat(82));
  console.log('  Aggregation über alle Belege (mehrfach-Beleg-Summen)');
  console.log('═'.repeat(82));
  const merged = aggregate(allResults);
  console.log(`  Konsolidierte Felder: ${merged.length}`);
  // Group by anlage for readability
  const byAnlage = new Map<string, typeof merged>();
  for (const f of merged) {
    const arr = byAnlage.get(f.anlage) ?? [];
    arr.push(f);
    byAnlage.set(f.anlage, arr);
  }
  for (const [anlage, list] of [...byAnlage.entries()].sort()) {
    console.log('');
    console.log(`  ─── Anlage ${anlage} (${list.length} Felder) ───`);
    for (const f of list) {
      const w = (f.warnings ?? []).length > 0 ? '⚠' : ' ';
      console.log(
        `   ${w} ${f.eCode.padEnd(10)} ${(f.kontextSubpath ?? '').padEnd(40)} `
        + `${f.wert.padEnd(15)} ← ${f.pdfLabel.slice(0, 35)}`,
      );
      if (f.warnings && f.warnings.length > 0) {
        for (const ww of f.warnings) console.log(`       ⚠ ${ww}`);
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const total = stats.length;
  const ok = stats.filter((s) => classify(s) === 'ok').length;
  const partial = stats.filter((s) => classify(s) === 'partial').length;
  const fail = stats.filter((s) => classify(s) === 'fail').length;
  const totalFelder = allResults.reduce((acc, r) => acc + r.felder.length, 0);
  const totalMissing = allResults.reduce((acc, r) => acc + r.missingExpected.length, 0);
  const totalUnmatched = allResults.reduce((acc, r) => acc + r.unmatched.length, 0);

  console.log('');
  console.log('═'.repeat(82));
  console.log('  Summary');
  console.log('═'.repeat(82));
  console.log(`  Belege:           ${total}  (✓ ${ok}  ◐ ${partial}  ✗ ${fail})`);
  console.log(`  Felder extrahiert (vor Aggregation): ${totalFelder}`);
  console.log(`  Felder konsolidiert (nach Aggregation): ${merged.length}`);
  console.log(`  Required-Felder fehlend: ${totalMissing}`);
  console.log(`  Unmatched-Labels (im PDF, nicht im Schema): ${totalUnmatched}`);
  console.log('');

  if (fail > 0) process.exit(1);
  if (totalMissing > 0) process.exit(2);
  process.exit(0);
}

main();
