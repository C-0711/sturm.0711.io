/**
 * Check consistency between Bescheid (Finanzamt source-of-truth) and WISO-Erklärung
 * (Mandant input).
 */
import { readFile, writeFile } from 'node:fs/promises';

interface Profile { atoms: Array<{ field_id: string; field_name: string; value: any; ecode?: string; source: { document: string; confidence: number } }> }
const profile: Profile = JSON.parse(await readFile('/tmp/profile-haubrich-koch.json', 'utf-8'));

// Tests
const checks: Array<{ check: string; expect: any; actual: any; status: 'PASS' | 'FAIL' | 'WARN'; note?: string }> = [];

const get = (id: string) => profile.atoms.find(a => a.field_id === id)?.value;

// 1) Bruttoarbeitslohn-Konsistenz: WISO StKl1+StKl6 ≈ Bescheid Summe
const stkl1 = Number(get('arbeitslohn_stkl1_2023'));   // 30525.48
const stkl6 = Number(get('arbeitslohn_stkl6_2023'));   // 4019.16
const sumWiso = Math.round(stkl1 + stkl6);              // 34545
const bescheid = Number(get('arbeitslohn_brutto_2023')); // 34544
checks.push({
  check: 'Bruttoarbeitslohn-Summe WISO ≈ Bescheid',
  expect: bescheid + ' (Bescheid)',
  actual: `${stkl1} + ${stkl6} = ${sumWiso} (WISO)`,
  status: Math.abs(sumWiso - bescheid) <= 1 ? 'PASS' : 'FAIL',
  note: 'Rundungsdifferenz ±1 € erwartet',
});

// 2) Lohnsteuer-Summe StKl 1+6 muss anrechenbarem Lohnsteuerabzug entsprechen
const lst1 = Number(get('lohnsteuer_stkl1_2023')); // 3166.92
const lst6 = Number(get('lohnsteuer_stkl6_2023')); // 330.00
const sumLst = Math.round(lst1 + lst6);             // 3497
const lstBescheid = Number(get('est_lohnsteuerabzug_2023')); // 3497
checks.push({
  check: 'Lohnsteuer-Summe WISO ≈ Lohnsteuerabzug Bescheid',
  expect: lstBescheid + ' (Bescheid)',
  actual: `${lst1} + ${lst6} = ${sumLst} (WISO)`,
  status: sumLst === lstBescheid ? 'PASS' : 'FAIL',
});

// 3) KiSt-LStB-Summe vs. Bescheid 'KiSt-Steuerabzug vom Lohn'
const kist1 = Number(get('kist_stkl1_2023')); // 285
const kist6 = Number(get('kist_stkl6_2023')); // 29.64
const kistSum = (kist1 + kist6).toFixed(2);   // 314.64
checks.push({
  check: 'KiSt LStB-Summe (WISO) = 314,64 € (matches Bescheid Seite 1 Spalte abzgl LStA)',
  expect: '314.64 (Bescheid Seite 1)',
  actual: `${kist1} + ${kist6} = ${kistSum}`,
  status: kistSum === '314.64' ? 'PASS' : 'FAIL',
});

// 4) Rentenbetrag = 23.743 in beiden Quellen
const renteWiso = Number(get('rente_jahresbetrag_2023'));
checks.push({
  check: 'Rentenbetrag (Bescheid Seite 2 = 23.743)',
  expect: 23743, actual: renteWiso,
  status: renteWiso === 23743 ? 'PASS' : 'FAIL',
});

// 5) KV-Berechnung: 1735 + 700 - 363 - 1094 = 978 (steht im Bescheid)
const kv = Number(get('kv_beitrag_2023')), pv = Number(get('pv_beitrag_2023')),
      erstattung = Number(get('kv_pv_erstattung_2023')), zuschuss = Number(get('kv_pv_zuschuss_2023'));
const restVor = kv + pv - erstattung - zuschuss;
checks.push({
  check: 'KV-Berechnung: KV+PV-Erstattung-Zuschuss = verbleiben',
  expect: '978 (Bescheid Seite 3)',
  actual: `${kv}+${pv}-${erstattung}-${zuschuss} = ${restVor}`,
  status: restVor === 978 ? 'PASS' : 'FAIL',
});

// 6) Spendensumme = 65
const sp = Number(get('spende_hospiz_2023')) + Number(get('spende_bund_2023')) + Number(get('spende_kinderhospiz_2023'));
checks.push({
  check: 'Spenden-Summe = 65 €',
  expect: 65, actual: sp,
  status: sp === 65 ? 'PASS' : 'FAIL',
});

// 7) Steuernummern-Konflikt: 2 verschiedene
const sn1 = get('steuernummer_bescheid'), sn2 = get('steuernummer_wiso');
checks.push({
  check: 'Steuernummern aus WISO und Bescheid identisch',
  expect: `identisch (${sn1})`,
  actual: `Bescheid=${sn1} | WISO=${sn2}`,
  status: sn1 === sn2 ? 'PASS' : 'WARN',
  note: 'KLÄRUNG ERFORDERLICH: Zwei verschiedene Steuernummern für gleiche Person/Jahr — möglich bei Aktenwechsel, FA-Zuständigkeitswechsel oder Erfassungsfehler',
});

// 8) Haushaltsnahe DL: Basis × 20% = Ermäßigung
const basis = Number(get('haushaltsnahe_dl_basis_2023')); // 11101
const ermaess = Number(get('haushaltsnahe_dl_ermaess_2023')); // 2221
const expected20 = Math.round(basis * 0.20);
checks.push({
  check: 'Haushaltsnahe-DL: 20 % von Basis = Ermäßigung',
  expect: `${basis} × 0.20 = ${expected20}`,
  actual: ermaess,
  status: Math.abs(ermaess - expected20) <= 1 ? 'PASS' : 'FAIL',
});

// 9) ESt-Festsetzung: Grundtarif - Ermäßigung = festgesetzt
const grundtarif = Number(get('est_grundtarif_2023'));
const estFest = Number(get('est_festgesetzt_2023'));
checks.push({
  check: 'ESt: Grundtarif - Ermäßigung = Festgesetzt',
  expect: `${grundtarif} - ${ermaess} = ${grundtarif - ermaess}`,
  actual: estFest,
  status: (grundtarif - ermaess) === estFest ? 'PASS' : 'FAIL',
});

// 10) KiSt: 9% von festgesetzter ESt
const kistFest = Number(get('kist_festgesetzt_2023'));
const kistExp = Math.round(estFest * 0.09 * 100) / 100;
checks.push({
  check: 'KiSt: 9 % von festgesetzter ESt',
  expect: `${estFest} × 0.09 = ${kistExp}`,
  actual: kistFest,
  status: Math.abs(kistFest - kistExp) <= 0.01 ? 'PASS' : 'FAIL',
});

// Print report
console.log('=== KONFLIKT-CHECK ===\n');
let passed = 0, failed = 0, warn = 0;
for (const c of checks) {
  const sym = c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✗' : '⚠';
  console.log(`${sym} ${c.check}`);
  console.log(`   expect: ${c.expect}`);
  console.log(`   actual: ${c.actual}`);
  if (c.note) console.log(`   note:   ${c.note}`);
  console.log();
  if (c.status === 'PASS') passed++;
  else if (c.status === 'FAIL') failed++;
  else warn++;
}
console.log(`Total: ${passed} PASS · ${warn} WARN · ${failed} FAIL`);

const md = ['# Profile Conflict Check — Haubrich-Koch 2023', '', `Mandant: 0711:mandant:haubrich-koch:hildburg-1935`, `Datum: ${new Date().toISOString()}`, '', ''];
for (const c of checks) {
  const sym = c.status === 'PASS' ? '✅' : c.status === 'FAIL' ? '❌' : '⚠️';
  md.push(`## ${sym} ${c.check}`, `- **expected:** ${c.expect}`, `- **actual:**   ${c.actual}`);
  if (c.note) md.push(`- **note:**     ${c.note}`);
  md.push('');
}
md.push(`---\n**Total:** ${passed} PASS · ${warn} WARN · ${failed} FAIL`);
await writeFile('/tmp/profile-conflicts.md', md.join('\n'));
console.log('\n→ /tmp/profile-conflicts.md');
