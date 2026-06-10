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
    assert('IBAN E0102102 = DE08…', Boolean(r.aggregated.find((f) => f.eCode === 'E0102102')?.wert?.startsWith('DE08')), r.aggregated.find((f) => f.eCode === 'E0102102'));
    // Code-agnostisch: Lohnsteuer hat mehrere Instanz-E-Codes (E0200301..304),
    // die deterministische Auswahl darf variieren — der WERT muss stimmen.
    const lst = r.aggregated.find((f) => f.anlage === 'N' && /Lohnsteuer/i.test(f.pdfLabel ?? ''));
    assert('Lohnsteuer OCR-Punkt gefixt: 6.720.00 → 6720 (NICHT 672000)', !!lst && /^6720(,00)?$/.test(lst.wert), lst);
  }

  console.log('\n6. Volksbank-Erträgnisaufstellung (Realformat) durch die VOLLE Pipeline + Cross-Doc-Summierung\n');
  {
    // Echtes OCR-Layout (d25a6856.jpg, Maria Ute Stricker): Spaltenkopf „Höhe der
    // Kapitalerträge" über zwei Zeilen zerlegt + Umlaute weg, Summe inline auf der
    // „steuerpflichtigen Einzelerträge"-Zeile (Typo „Surmme"). Vor dem Fix: 0 Felder
    // → Person Bs Kapitalertrag (319 €) ging verloren. Hier: durch detect → person →
    // mapBeleg → aggregate, und gegen einen ZWEITEN B-Beleg (50) auf Summe geprüft.
    const VOLKSBANK = `Volksbanken Raiffeisenbanken
Erträgnisaufstellung für das Jahr 2024 für lhre privaten Kapitalerträge
Für (Gläubiger) Frau Maria Ute Stricker
Geschaftsdatum   Hohe der   Gewinne   Zeilen-Nr.
Konto-Nr./   Art der Kapitalertrage   Kapitalertrage   (davon Aktiengewinne)   Anlage KAP
28.03.2024 Zinsen Einlagen   4.06
28.06.2024 Zinsen Einlagen   5,16   7
30.12.2024 Zinsen Einlagen   293,75
Summe zur vorstehenden Tabelle (siche auch auf der Steuerbescheinigung)   EUR/CT   Zeilen-Nr.
Anlage KAP
Ermittelt aus der Surmme der steuerpflichtigen Einzelertrage Gewinne/Veriuste   319,35`;
    const imgVb = join(dir, 'volksbank.png'); writeFileSync(imgVb, 'x');
    const imgB2 = join(dir, 'bankB2.png'); writeFileSync(imgB2, 'x');
    const hh = structuredClone(household); hh.personB = { idnr: '54129386608', vorname: 'Maria Ute', nachname: 'Stricker' };
    const parseImage = async (p: string) => (p.endsWith('volksbank.png') ? VOLKSBANK : BANK_B);
    const r = await runLane1([imgVb, imgB2], { vz: 2024, pool, household: hh, parseImage });
    const vb = r.belege.find((b) => String(b.source).endsWith('volksbank.png'));
    assert('Volksbank belegTyp = Steuerbescheinigung_Bank', vb?.belegTyp === 'Steuerbescheinigung_Bank', vb);
    assert('Volksbank mapped (≥1 Feld, NICHT 0)', vb?.status === 'mapped' && (vb?.felder ?? 0) >= 1, vb);
    assert('Volksbank Person B (Maria Ute)', vb?.person === 'B', vb?.person);
    // E1900701 B = 319 (Volksbank-Summe) + 50 (BANK_B) → cross-doc summiert
    const capB = r.aggregated.find((f) => f.eCode === 'E1900701' && f.person === 'B');
    assert('E1900701 B summiert: 319 + 50 = 369', capB?.wert === '369', capB);
  }

  console.log('\n7. Vorjahres-Erklärung (2023) im VZ-2024-Fall → NICHT in die Berechnung, als Vorjahres-Kontext\n');
  {
    // Kern-Bug: eine 2023er Einkommensteuererklärung neben 2024er Belegen darf
    // NICHT mitgerechnet werden — sonst summiert aggregate() Bruttoarbeitslohn
    // 2023 (50.000) + 2024 (60.000) = 110.000. Stattdessen: 2024 zählt, 2023
    // wird zu Vorjahres-Kontext (Prefill für fehlende Stammdaten wie IBAN).
    const ERKL_2023 = `Einkommensteuererklärung 2023
8 Geburtsdatum   27.05.1963
30 IBAN (inländisches Geldinstitut)   DE085735103001050569
Anlage N (Steuerpflichtige Person / Ehemann / Person A)
5 Bruttoarbeitslohn   50.000,00
Anlage Vorsorgeaufwand`;
    const ERKL_2024 = `Einkommensteuererklärung 2024
8 Geburtsdatum   27.05.1963
Anlage N (Steuerpflichtige Person / Ehemann / Person A)
5 Bruttoarbeitslohn   60.000,00
Anlage Vorsorgeaufwand`;
    const vj = join(dir, 'erkl2023.png'); writeFileSync(vj, 'x');
    const cur = join(dir, 'erkl2024.png'); writeFileSync(cur, 'x');
    const parseImage = async (p: string) => (p.endsWith('erkl2023.png') ? ERKL_2023 : ERKL_2024);
    const r = await runLane1([vj, cur], { vz: 2024, pool, household: structuredClone(household), parseImage });

    const b2023 = r.belege.find((b) => String(b.source).endsWith('erkl2023.png'));
    const b2024 = r.belege.find((b) => String(b.source).endsWith('erkl2024.png'));
    assert('2023-Beleg als Vorjahr markiert (vorjahr=true, dokumentJahr=2023)', b2023?.vorjahr === true && b2023?.dokumentJahr === 2023, b2023);
    assert('2024-Beleg ist NICHT Vorjahr', !b2024?.vorjahr && b2024?.dokumentJahr === 2024, b2024);

    const brutto = r.aggregated.find((f) => f.anlage === 'N' && /Bruttoarbeitslohn/i.test(f.pdfLabel ?? ''));
    assert('Bruttoarbeitslohn = 60000 (NUR 2024, NICHT 50000+60000=110000)', brutto?.wert === '60000', brutto);

    // IBAN war nur 2023 da → darf NICHT in den Rechen-Feldern stehen …
    assert('IBAN NICHT in aggregated (kein Vorjahres-Leak in die Berechnung)', !r.aggregated.some((f) => f.eCode === 'E0102102'), r.aggregated.filter((f) => f.eCode === 'E0102102'));
    // … sondern als Vorjahres-Prefill angeboten werden.
    assert('Vorjahr erkannt: jahr=2023', r.vorjahr?.jahr === 2023, r.vorjahr);
    const ibanVj = r.vorjahr?.felder.find((f) => f.eCode === 'E0102102');
    assert('IBAN als Vorjahres-Prefill (kind=prefill)', ibanVj?.kind === 'prefill', ibanVj);
    assert('stats.vorjahrFelder > 0', (r.stats.vorjahrFelder ?? 0) > 0, r.stats.vorjahrFelder);
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((err) => { console.error('FATAL:', err); process.exit(2); });
