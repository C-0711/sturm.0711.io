/**
 * triage Tests — gegen die echten Hildburg-Belege auf dem Desktop.
 *
 * Ausführen:
 *   npx tsx src/workflows/elster/lib/field-mapper/triage.test.ts
 *
 * Wenn das Beleg-Verzeichnis nicht existiert, skippt die Suite mit exit 0.
 */
import { existsSync } from 'node:fs';
import { triageBeleg } from './triage.ts';
import type { HouseholdInfo } from './triage.ts';
import type { BelegTyp } from './types.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

const HILDBURG_DIR =
  process.env.BELEGE_DIR ?? '/Users/christophbertsch/Desktop/Belege/Erklärung HH';

const HILDBURG: HouseholdInfo = {
  personA: { idnr: '57438590613', vorname: 'Hildburg', nachname: 'Haubrich-Koch' },
};

interface Expected {
  filename: string;
  belegTyp: BelegTyp;
  expectedPerson: 'A' | 'B' | 'unknown';
  expectedRenderMode: 'text-extract' | 'ocr-required' | 'unsupported';
}

const FIXTURES: Expected[] = [
  { filename: 'Lohnsteuerbescheinigung_2024_57438590613_LBV_NRW.pdf',                       belegTyp: 'VaSt_LStB',     expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Lohnsteuerbescheinigung_2024_57438590613_Philips_GmbH.pdf',                  belegTyp: 'VaSt_LStB',     expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Rentenbezugsmitteilung_2024_57438590613_Deutsche_Rentenversicherung_Bund.pdf', belegTyp: 'VaSt_RBM',    expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Rentenbezugsmitteilung_2024_57438590613_Philips_Pensionskasse__VVaG_.pdf',   belegTyp: 'VaSt_RBM',      expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Krankenversicherung_2024_57438590613_Debeka_Krankenversicherungsverein_a._G..pdf', belegTyp: 'VaSt_KRV', expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Kapitalertraege_mit_Freistellungsauftrag_2024_57438590613_Kreissparkasse_Ahrweiler.pdf', belegTyp: 'VaSt_FSA', expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Kapitalertraege_mit_Freistellungsauftrag_2024_57438590613_VR_Bank_RheinAhrEifel_eG.pdf', belegTyp: 'VaSt_FSA', expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Religionszugehoerigkeit_2024_57438590613_Finanzverwaltung.pdf',              belegTyp: 'VaSt_Religion', expectedPerson: 'A', expectedRenderMode: 'text-extract' },
  { filename: 'Stammdaten_2024_57438590613_Finanzverwaltung.pdf',                           belegTyp: 'VaSt_Pers',     expectedPerson: 'A', expectedRenderMode: 'text-extract' },
];

if (!existsSync(HILDBURG_DIR)) {
  console.log(`\n(skipping — ${HILDBURG_DIR} nicht vorhanden)`);
  process.exit(0);
}

console.log('\n1. Beleg-Typ-Erkennung + Person-Routing aus Filename+Text\n');
for (const fx of FIXTURES) {
  const path = `${HILDBURG_DIR}/${fx.filename}`;
  if (!existsSync(path)) {
    console.log(`  ? skip (missing): ${fx.filename}`);
    continue;
  }
  const r = triageBeleg(path, { household: HILDBURG });
  const tag = `${fx.filename.slice(0, 50).padEnd(50)} → ${r.belegTyp}/${r.person}`;
  assert(`${tag} — belegTyp`, r.belegTyp === fx.belegTyp, { got: r.belegTyp, expect: fx.belegTyp });
  assert(`${tag} — person`,    r.person === fx.expectedPerson, { got: r.person, expect: fx.expectedPerson });
  assert(`${tag} — renderMode`, r.renderMode === fx.expectedRenderMode, { got: r.renderMode });
  if (r.detected.idnr) {
    assert(`${tag} — idnr extrahiert`, r.detected.idnr === '57438590613', r.detected.idnr);
  }
}

console.log('\n2. Steuerbescheinigung_Bank (image-only Volksbank) → ocr-required\n');
{
  const path = `${HILDBURG_DIR}/Steuerbescheinigung Volksbank 2024.pdf`;
  if (!existsSync(path)) {
    console.log('  (skip — file missing)');
  } else {
    const r = triageBeleg(path, { household: HILDBURG, minTextChars: 200 });
    assert('renderMode = ocr-required', r.renderMode === 'ocr-required', r.renderMode);
    assert('rawText = null',            r.rawText === null);
    assert('textChars < minTextChars',  r.detected.textChars < 200, r.detected.textChars);
  }
}

console.log('\n3. Person-Routing ohne household → unknown\n');
{
  const path = `${HILDBURG_DIR}/Stammdaten_2024_57438590613_Finanzverwaltung.pdf`;
  if (existsSync(path)) {
    const r = triageBeleg(path); // no household
    assert('person = unknown', r.person === 'unknown', r.person);
    assert('idnr trotzdem extrahiert', r.detected.idnr === '57438590613', r.detected.idnr);
  }
}

console.log('\n4. Datei nicht vorhanden → unsupported\n');
{
  const r = triageBeleg('/nonexistent/garbage.pdf');
  assert('renderMode = unsupported', r.renderMode === 'unsupported');
  assert('belegTyp = Unbekannt',     r.belegTyp === 'Unbekannt');
  assert('mit warning',              r.warnings.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
