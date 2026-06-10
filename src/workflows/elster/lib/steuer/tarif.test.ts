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

console.log('\n§32a VZ 2024 — Monotonie & Stetigkeit (fängt den Zonenkoeffizienten-Bug)\n');
{
  // 1. MONOTONIE: feiner Sweep, ESt darf NIE fallen (der 2024-Bug: an 17005/66760 fiel sie).
  for (const art of ['einzeln', 'zusammen'] as const) {
    let prev = -1, prevZ = -1, mono = true, worst = '';
    for (let zve = 0; zve <= 320000; zve += 25) {
      const est = einkommensteuer(zve, 2024, art);
      if (est < prev - 0.001) { mono = false; worst = `zvE ${prevZ}→${zve}: ESt ${prev.toFixed(2)}→${est.toFixed(2)}`; break; }
      prev = est; prevZ = zve;
    }
    ok(`2024 ${art}: ESt monoton (0..320k)`, mono, worst);
  }
  // 2. Feinsweep ±20 € exakt um jeden Knick (dort brach es).
  for (const knee of [11784, 17005, 66760, 277825]) {
    let prev = einkommensteuerGrundtarif(knee - 20, 2024), mono = true, worst = '';
    for (let zve = knee - 19; zve <= knee + 20; zve++) {
      const est = einkommensteuerGrundtarif(zve, 2024);
      if (est < prev - 0.001) { mono = false; worst = `${zve - 1}→${zve}: ${prev.toFixed(2)}→${est.toFixed(2)}`; break; }
      prev = est;
    }
    ok(`2024 Knick ${knee}: monoton (±20 €)`, mono, worst);
  }
  // 3. STETIGKEIT: Sprung an den Knicken < 2 € (gesetzlich zulässig: der
  //    Programmablaufplan floort je Zone auf volle Euro → max. 1 € Artefakt).
  //    Der Bug gab 43 € / 181 € — das wäre hier längst aufgefallen.
  for (const knee of [17005, 66760, 277825]) {
    const jump = Math.abs(einkommensteuerGrundtarif(knee + 1, 2024) - einkommensteuerGrundtarif(knee, 2024));
    ok(`2024 Knick ${knee}: stetig (Sprung ${jump.toFixed(2)} € < 2)`, jump < 2, jump);
  }
  // 4. Amtliche Zonenwerte (BMF EStH 2024): lineare Zonen 4/5 sind eindeutig.
  ok('2024 GFB 11784 → ESt 0', einkommensteuerGrundtarif(11784, 2024) === 0);
  ok('2024 Zone4: ESt(80000) = 0,42·x−10636,31', near(einkommensteuerGrundtarif(80000, 2024), Math.floor(0.42 * 80000 - 10636.31), 1), einkommensteuerGrundtarif(80000, 2024));
  ok('2024 Zone5: ESt(300000) = 0,45·x−18971,06', near(einkommensteuerGrundtarif(300000, 2024), Math.floor(0.45 * 300000 - 18971.06), 1), einkommensteuerGrundtarif(300000, 2024));
  // 5. Grenzsteuersatz ∈ [0, 45 %] über den ganzen Bereich.
  let rateOk = true, rb = '';
  for (let zve = 11785; zve <= 320000; zve += 137) {
    const r = einkommensteuerGrundtarif(zve + 100, 2024) - einkommensteuerGrundtarif(zve, 2024);
    if (r < -0.001 || r > 45.5) { rateOk = false; rb = `zvE ${zve}: ${r.toFixed(2)} €/100 €`; break; }
  }
  ok('2024 Grenzsteuersatz ∈ [0, 45 %]', rateOk, rb);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
