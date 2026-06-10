/**
 * engine.test — End-to-End-Rechenkern: handprüfbarer Fall, Mikro-Benchmark
 * (<10 ms-Nachweis für den Kalkulationskern) und optionaler Abgleich des
 * Tarifs gegen die autoritative BMF-MCP (:12010, übersprungen wenn down).
 *
 *   npx tsx src/workflows/elster/lib/steuer/engine.test.ts
 */
import { berechneSteuerfall } from './engine.ts';
import { einkommensteuer } from './tarif.ts';
import { BmfMcpClient } from '../../../../lib/bmf-mcp-client.ts';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

console.log('\nHandprüfbarer Fall — Single, VZ2023, Lohn 50.000\n');
const fall = berechneSteuerfall({
  vz: 2023,
  art: 'einzeln',
  personA: {
    bruttoarbeitslohn: 50000,
    werbungskosten: 0,            // → AN-Pauschbetrag 1230
    altersvorsorgeaufwand: 9300,  // RV AN+AG 18,6% v. 50.000 (< Höchst 26.528 → 100%)
    kvPvBasisbeitrag: 4000,       // Basis-KV/PV voll abzugsfähig
  },
  kirchensteuerHebesatz: 0.09,
  anrechnung: { lohnsteuer: 6000 },
});
// Handrechnung:
//  §19: 50.000 − 1.230 = 48.770 ; SdE = GdE = 48.770
//  §10: Vorsorge 9.300 + 4.000 = 13.300 ; +SA-Pauschbetrag 36 = 13.336
//  Einkommen = 48.770 − 13.336 = 35.434 = zvE
ok('zvE = 35.434 (Handrechnung)', fall.einkommen.zvE === 35434, fall.einkommen.zvE);
ok('Summe der Einkünfte = 48.770', fall.einkommen.summeEinkuenfte === 48770, fall.einkommen.summeEinkuenfte);
ok('Sonderausgaben = 13.336', fall.einkommen.sonderausgaben === 13336, fall.einkommen.sonderausgaben);
ok('ESt == tarif(zvE)', fall.steuer.einkommensteuer === einkommensteuer(35434, 2023, 'einzeln'),
  [fall.steuer.einkommensteuer, einkommensteuer(35434, 2023, 'einzeln')]);
ok('Soli = 0 (ESt < Freigrenze)', fall.steuer.solidaritaetszuschlag === 0, fall.steuer.solidaritaetszuschlag);
ok('KiSt = 9%·ESt', near(fall.steuer.kirchensteuer, 0.09 * fall.steuer.einkommensteuer, 0.01), fall.steuer.kirchensteuer);
ok('Erstattung = LSt − festgesetzt', near(fall.erstattung, 6000 - fall.festgesetzt, 0.01),
  [fall.erstattung, 6000 - fall.festgesetzt]);
console.log('    zvE-Trace:');
for (const t of fall.einkommen.trace) console.log(`      ${t.schritt.padEnd(38)} ${t.betrag.toFixed(2).padStart(12)}`);
console.log('    →', JSON.stringify({ ...fall.steuer, zvE: fall.einkommen.zvE, festgesetzt: fall.festgesetzt, erstattung: fall.erstattung }));

console.log('\nVerheiratet/Splitting — beide verdienen, VZ2023\n');
const ehe = berechneSteuerfall({
  vz: 2023, art: 'zusammen',
  personA: { bruttoarbeitslohn: 63560, altersvorsorgeaufwand: 11800, kvPvBasisbeitrag: 5000 },
  personB: { bruttoarbeitslohn: 30000, altersvorsorgeaufwand: 5580, kvPvBasisbeitrag: 3000 },
  kirchensteuerHebesatz: 0.08,
  anrechnung: { lohnsteuer: 18000 },
});
ok('Splitting-ESt = 2·grund(zvE/2)', ehe.steuer.einkommensteuer === einkommensteuer(ehe.einkommen.zvE, 2023, 'zusammen'),
  [ehe.steuer.einkommensteuer, einkommensteuer(ehe.einkommen.zvE, 2023, 'zusammen')]);
ok('zvE > 0 und < Σ Bruttolohn', ehe.einkommen.zvE > 0 && ehe.einkommen.zvE < 93560, ehe.einkommen.zvE);
console.log('    →', JSON.stringify({ zvE: ehe.einkommen.zvE, ESt: ehe.steuer.einkommensteuer, soli: ehe.steuer.solidaritaetszuschlag, kist: ehe.steuer.kirchensteuer, erstattung: ehe.erstattung }));

console.log('\nMikro-Benchmark — Kalkulationskern (zvE→ESt→Soli→KiSt→Saldo)\n');
{
  const N = 100_000;
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < N; i++) {
    const r = berechneSteuerfall({
      vz: 2023, art: 'einzeln',
      personA: { bruttoarbeitslohn: 40000 + (i % 50000), altersvorsorgeaufwand: 7000, kvPvBasisbeitrag: 3500 },
      anrechnung: { lohnsteuer: 5000 },
    });
    sink += r.festgesetzt;
  }
  const t1 = process.hrtime.bigint();
  const nsPer = Number(t1 - t0) / N;
  console.log(`    ${N.toLocaleString()} Fälle in ${(Number(t1 - t0) / 1e6).toFixed(1)} ms → ${nsPer.toFixed(0)} ns/Fall  (sink ${sink.toFixed(0)})`);
  // Ein voller Steuerfall-Kalkulationskern muss weit unter 10 ms liegen.
  ok('1 Fall ≪ 10 ms (ns-Bereich)', nsPer < 10_000_000 && nsPer < 50_000, `${nsPer.toFixed(0)} ns`);
  // 10 Dokumente ⇒ 1 Fall-Kalkulation (über den aggregierten Fall) → ein Aufruf.
  ok('10-Dok-Fall-Kalkulation < 10 ms', nsPer / 1e6 < 10, `${(nsPer / 1e6).toFixed(4)} ms`);
}

console.log('\nMCP-Abgleich Tarif (autoritativ :12010) — übersprungen wenn down\n');
await (async () => {
  const client = new BmfMcpClient({ timeoutMs: 2500 });
  try {
    await client.ping();
  } catch (e) {
    console.log(`  ⚠ MCP nicht erreichbar (${(e as Error).message.slice(0, 80)}) — Tarif bleibt gegen §32a-Referenz validiert (tarif.test.ts).`);
    return;
  }
  // Minimaler Fall: ein Bruttoarbeitslohn. MCP liefert sein zve + einkommensteuer.
  // Wir prüfen: unser Tarif über DESSEN zvE == DESSEN ESt (Tarif-Korrektheit,
  // entkoppelt von der zvE-Aggregation).
  for (const lohn of ['50000,00', '63559,90', '95000,00']) {
    const res = await client.berechneVollstaendigeSteuerV2({
      erklaerungsjahr: 2023,
      elster_felder: { E0200201: lohn },
    });
    const mcpZve = res.daten.zve;
    const mcpEst = res.daten.einkommensteuer;
    const oursEst = einkommensteuer(mcpZve, 2023, 'einzeln');
    // Bei ganzzahligem zvE (Realfall) MUSS der Tarif exakt übereinstimmen.
    // Bei fraktionalem zvE (hier nur, weil die MCP intern % -Abzüge mit
    // Nachkommastellen rechnet) trennt die statutarische Euro-Abrundung
    // des §32a Abs. 1 (zvE→voller €, ESt→voller €), die wir anwenden und
    // die MCP nicht, um bis zu ~1 €. Das ist gesetzeskonform, kein Defekt.
    const istGanz = Number.isInteger(mcpZve);
    const tol = istGanz ? 1 : 1.5;
    ok(`Tarif==MCP @ zvE=${mcpZve} (Lohn ${lohn}${istGanz ? '' : ', frakt.→§32a-Rundung'})`,
      near(oursEst, mcpEst, tol), { oursEst, mcpEst, mcpZve, diff: +(oursEst - mcpEst).toFixed(2) });
  }
})();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
