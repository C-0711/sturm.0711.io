/**
 * lane1 — Unified-Pipeline-Tests. Beweis: EIN Weg, austauschbarer Parser.
 * Ein injizierter Fake-Parser bringt einen "Bild"-Beleg INLINE durch
 * dieselbe Kette wie Digital-Text (detect → person → mapBeleg → aggregate).
 *
 * Ausführen:
 *   ELSTER_CATALOG_PG_URL=... npx tsx src/workflows/elster/lib/lane1.test.ts
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { runLane1 } from './lane1.ts';
import type { HouseholdInfo } from './field-mapper/triage.ts';

const { Pool } = pg;
let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

// Gescannte Bank-Steuerbescheinigung (was der OCR-Parser liefern würde).
const BANK_A = `Steuerbescheinigung
Für (Gläubiger) Herrn Rainer Stricker
Höhe der Kapitalerträge          Zeile 7 Anlage KAP          11,25
Kapitalertragsteuer              Zeile 37 Anlage KAP          2,75`;
const BANK_B = `Steuerbescheinigung
Für (Gläubiger) Frau Maria Ute Stricker
Höhe der Kapitalerträge          Zeile 7 Anlage KAP          50,00`;

async function main(): Promise<void> {
  const url = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog';
  const pool = new Pool({ connectionString: url, max: 4 });
  const dir = mkdtempSync(join(tmpdir(), 'lane1test-'));
  const imgA = join(dir, 'bankA.png'); writeFileSync(imgA, 'x');  // existiert, aber pdftotext liefert nichts
  const imgB = join(dir, 'bankB.png'); writeFileSync(imgB, 'x');
  const household: HouseholdInfo = {
    personA: { idnr: '85236749007', vorname: 'Rainer', nachname: 'Stricker' },
    personB: { idnr: '54129386608' },  // nur IdNr — Name unbekannt
  };

  console.log('\n1. OHNE parseImage → Bild-Beleg deferred (Kern bleibt netzfrei)\n');
  {
    const r = await runLane1([imgA], { vz: 2024, pool, household: structuredClone(household) });
    assert('Beleg deferred-ocr', r.belege[0]?.status === 'deferred-ocr', r.belege[0]);
    assert('Route lane2-ocr', r.deferred[0]?.route === 'lane2-ocr', r.deferred[0]);
    assert('0 Felder aggregiert', r.aggregated.length === 0, r.aggregated.length);
  }

  console.log('\n2. MIT Fake-parseImage → Bild-Beleg INLINE durch dieselbe Kette\n');
  {
    const parseImage = async (p: string) => (p === imgA ? BANK_A : BANK_B);
    const r = await runLane1([imgA], { vz: 2024, pool, household: structuredClone(household), parseImage });
    const b = r.belege[0];
    assert('method = ocr', b?.method === 'ocr', b);
    assert('belegTyp = Steuerbescheinigung_Bank', b?.belegTyp === 'Steuerbescheinigung_Bank', b);
    assert('status = mapped', b?.status === 'mapped', b);
    assert('Person A (Rainer via Gläubiger-Name)', b?.person === 'A', b);
    assert('E1900701 extrahiert (11,25→11)', r.aggregated.find((f) => f.eCode === 'E1900701')?.wert === '11',
      r.aggregated.find((f) => f.eCode === 'E1900701'));
    assert('ocrFields enthält E1900701|A', r.ocrFields.includes('E1900701|A'), r.ocrFields);
  }

  console.log('\n3. Person B aus Bild-Beleg GELERNT (VaSt kannte nur IdNr)\n');
  {
    const parseImage = async () => BANK_B;
    const hh = structuredClone(household);
    const r = await runLane1([imgB], { vz: 2024, pool, household: hh, parseImage });
    assert('Person B (Maria) erkannt', r.belege[0]?.person === 'B', r.belege[0]);
    assert('Name gelernt: "Maria Ute"', r.household.personB?.vorname === 'Maria Ute', r.household.personB);
  }

  console.log('\n4. Gemischt: Text-VaSt + Bild im selben Lauf, beide gemappt\n');
  {
    // Eine Mini-VaSt-Section als echter Text (pdftotext-äquivalent) ginge nur
    // über ein echtes PDF; hier prüfen wir, dass ein zweites Bild als zweiter
    // OCR-Beleg unabhängig durchläuft (gleicher Loop, zwei OCR-Parses).
    const parseImage = async (p: string) => (p.endsWith('bankA.png') ? BANK_A : BANK_B);
    const r = await runLane1([imgA, imgB], { vz: 2024, pool, household: structuredClone(household), parseImage });
    assert('2 Belege, beide ocr+mapped', r.belege.length === 2 && r.belege.every((b) => b.method === 'ocr' && b.status === 'mapped'), r.belege);
    assert('Person A + B getrennt', r.belege[0]?.person === 'A' && r.belege[1]?.person === 'B', r.belege.map((b) => b.person));
    // E1900701 für A (11) und B (50) getrennt aggregiert
    const a = r.aggregated.find((f) => f.eCode === 'E1900701' && f.person === 'A');
    const bF = r.aggregated.find((f) => f.eCode === 'E1900701' && f.person === 'B');
    assert('E1900701 A=11 · B=50 getrennt', a?.wert === '11' && bF?.wert === '50', [a, bF]);
  }

  console.log('\n5. Voll-Erklärung (multi-Anlage Druck) → Vordruckzeile-Extraktor\n');
  {
    const RETURN = `Einkommensteuererklärung 2024
8 Geburtsdatum   27.05.1963
13 Straße (derzeitige Adresse)   Kirchstraße
30 IBAN (inländisches Geldinstitut)   DE085735103001050569
Anlage N (Steuerpflichtige Person / Ehemann / Person A)
5 Bruttoarbeitslohn   63.559,90
6 Lohnsteuer   6.720.00
Anlage Vorsorgeaufwand`;
    const img = join(dir, 'erklaerung.png'); writeFileSync(img, 'x');
    const parseImage = async () => RETURN;
    const r = await runLane1([img], { vz: 2024, pool, household: structuredClone(household), parseImage });
    const b = r.belege[0];
    assert('belegTyp = Einkommensteuererklaerung', b?.belegTyp === 'Einkommensteuererklaerung', b);
    assert('mapped via Vordruckzeile (>0 Felder)', b?.status === 'mapped' && (b?.felder ?? 0) > 0, b);
    assert('Geburtsdatum E0100401 = 27.05.1963', r.aggregated.find((f) => f.eCode === 'E0100401')?.wert === '27.05.1963', r.aggregated.find((f) => f.eCode === 'E0100401'));
    assert('IBAN E0102102 = DE08…', r.aggregated.find((f) => f.eCode === 'E0102102')?.wert?.startsWith('DE08'), r.aggregated.find((f) => f.eCode === 'E0102102'));
    const lst = r.aggregated.find((f) => f.eCode === 'E0200304');
    assert('Lohnsteuer OCR-Punkt gefixt: 6.720.00 → 6720 (NICHT 672000)', !!lst && /^6720(,00)?$/.test(lst.wert), lst);
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((err) => { console.error('FATAL:', err); process.exit(2); });
