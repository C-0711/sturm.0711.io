/**
 * tarif.test — §32a/Soli/KiSt gegen bekannte Referenzpunkte (VZ 2023,
 * settled) + Zonen-Stetigkeit + Splitting-Identität. Reine Formel-Prüfung;
 * der Abgleich gegen die autoritative BMF-MCP läuft in tarif.mcp.test.ts.
 *
 *   npx tsx src/workflows/elster/lib/steuer/tarif.test.ts
 */
import {
  einkommensteuerGrundtarif,
  einkommensteuer,
  solidaritaetszuschlag,
  kirchensteuer,
  berechneSteuer,
} from './tarif.ts';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

console.log('\n§32a VZ 2023 — Grundtarif Referenzpunkte\n');
ok('GFB: ESt(10908)=0', einkommensteuerGrundtarif(10908, 2023) === 0);
ok('ESt(10909) knapp >0', einkommensteuerGrundtarif(10909, 2023) >= 0 && einkommensteuerGrundtarif(11000, 2023) > 0,
  einkommensteuerGrundtarif(11000, 2023));
// Zonengrenze 2/3 bei 15.999/16.000 — Stetigkeit
{
  const a = einkommensteuerGrundtarif(15999, 2023);
  const b = einkommensteuerGrundtarif(16000, 2023);
  ok('Zone2/3 stetig @16000 (≈966)', near(a, 966, 2) && near(b, 967, 2), [a, b]);
}
// Zonengrenze 3/4 bei 62.809/62.810 — Stetigkeit (~16407)
{
  const a = einkommensteuerGrundtarif(62809, 2023);
  const b = einkommensteuerGrundtarif(62810, 2023);
  ok('Zone3/4 stetig @62810 (≈16407)', near(a, b, 2) && near(b, 16407, 2), [a, b]);
}
// Zone 4 linear: 0,42·zvE − 9972,98
ok('Zone4: ESt(80000)≈23627', near(einkommensteuerGrundtarif(80000, 2023), Math.floor(0.42 * 80000 - 9972.98)),
  einkommensteuerGrundtarif(80000, 2023));
// Reichensteuer ab 277.826
ok('Zone5: ESt(300000)≈116692', near(einkommensteuerGrundtarif(300000, 2023), Math.floor(0.45 * 300000 - 18307.73)),
  einkommensteuerGrundtarif(300000, 2023));
// Bekannter Tabellenwert: zvE 60.000 single 2023 ≈ 15.242 €
ok('Tabellenwert zvE=60000 ≈ 15242', near(einkommensteuerGrundtarif(60000, 2023), 15242, 2),
  einkommensteuerGrundtarif(60000, 2023));

console.log('\nSplitting-Identität (§32a Abs. 5)\n');
for (const x of [20000, 45000, 63560, 120000]) {
  const split = einkommensteuer(2 * x, 2023, 'zusammen');
  const dbl = 2 * einkommensteuerGrundtarif(x, 2023);
  ok(`ESt_zus(2·${x}) == 2·ESt_grund(${x})`, split === dbl, [split, dbl]);
}

console.log('\nSolidaritätszuschlag (§3/§4 SolzG, VZ 2023)\n');
ok('unter Freigrenze (ESt=15000) → Soli 0', solidaritaetszuschlag(15000, 2023, 'einzeln') === 0);
ok('knapp über Freigrenze → Milderungszone < 5,5%', (() => {
  const est = 18000; // > 17543
  const soli = solidaritaetszuschlag(est, 2023, 'einzeln');
  return soli > 0 && soli < 0.055 * est; // gedeckelt durch 11,9%·(ESt−Freigrenze)
})(), solidaritaetszuschlag(18000, 2023, 'einzeln'));
ok('weit über Milderungszone → 5,5%·ESt', (() => {
  const est = 50000;
  return near(solidaritaetszuschlag(est, 2023, 'einzeln'), 0.055 * est, 0.01);
})(), solidaritaetszuschlag(50000, 2023, 'einzeln'));

console.log('\nKirchensteuer\n');
ok('9% von 10000 = 900', kirchensteuer(10000, 0.09) === 900);
ok('8% von 10000 = 800', kirchensteuer(10000, 0.08) === 800);
ok('kein Mitglied → 0', kirchensteuer(10000, 0) === 0);

console.log('\nberechneSteuer — Single zvE=63560 (ESt unter Soli-Freigrenze!), 9% KiSt, VZ2023\n');
{
  const r = berechneSteuer({ zvE: 63560, vz: 2023, art: 'einzeln', kirchensteuerHebesatz: 0.09 });
  ok('ESt ≈ 16722 (Zone 4)', near(r.einkommensteuer, Math.floor(0.42 * 63560 - 9972.98), 1), r.einkommensteuer);
  // ESt 16722 < Freigrenze 17543 ⇒ Soli 0 (Soli-Reform 2021, Normalfall Single).
  ok('Soli = 0 (ESt < Freigrenze 17543)', r.solidaritaetszuschlag === 0, r.solidaritaetszuschlag);
  ok('KiSt = 9%·ESt', near(r.kirchensteuer, 0.09 * r.einkommensteuer, 0.01), r.kirchensteuer);
  ok('Gesamt = ESt+Soli+KiSt', near(r.gesamtsteuer, r.einkommensteuer + r.solidaritaetszuschlag + r.kirchensteuer, 0.01), r.gesamtsteuer);
  ok('Grenzsteuersatz in Zone 4 = 42%', near(r.grenzsteuersatz, 0.42, 0.001), r.grenzsteuersatz);
  console.log('    →', JSON.stringify(r));
}

console.log('\nberechneSteuer — Hochverdiener zvE=120000 (Soli greift), 9% KiSt, VZ2023\n');
{
  const r = berechneSteuer({ zvE: 120000, vz: 2023, art: 'einzeln', kirchensteuerHebesatz: 0.09 });
  ok('ESt ≈ 40427 (Zone 4)', near(r.einkommensteuer, Math.floor(0.42 * 120000 - 9972.98), 1), r.einkommensteuer);
  // ESt 40427 > Freigrenze 17543 und weit über Milderungszone ⇒ 5,5%·ESt.
  ok('Soli = 5,5%·ESt', near(r.solidaritaetszuschlag, 0.055 * r.einkommensteuer, 0.01), r.solidaritaetszuschlag);
  ok('KiSt = 9%·ESt', near(r.kirchensteuer, 0.09 * r.einkommensteuer, 0.01), r.kirchensteuer);
  ok('Grenzsteuersatz = 42%', near(r.grenzsteuersatz, 0.42, 0.001), r.grenzsteuersatz);
  console.log('    →', JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
