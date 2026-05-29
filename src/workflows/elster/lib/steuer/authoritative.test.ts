/**
 * authoritative.test — MCP-autoritative Verdrahtung: verbindliche Quelle,
 * Abgleich, Konflikt-Logging und Fallback. Der MCP-Pfad läuft live gegen
 * :12010 (auf H200V erreichbar); ist die MCP down, werden nur die
 * Fallback-/Konflikt-Asserts geprüft.
 *
 *   npx tsx src/workflows/elster/lib/steuer/authoritative.test.ts
 */
import { berechneSteuerfallAuthoritativ, feldateToElsterFelder } from './authoritative.ts';
import { BmfMcpClient } from '../../../../lib/bmf-mcp-client.ts';
import type { SteuerFeld } from './adapter.ts';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

// Einzelner Steuerpflichtiger, VZ2023, mit einem Duplikat für den Konflikt-Test.
const felder: SteuerFeld[] = [
  { eCode: 'E0200201', wert: '50000', person: 'A', anlage: 'N' },     // Bruttolohn
  { eCode: 'E0200201', wert: '48000', person: 'A', anlage: 'N' },     // Duplikat → Konflikt
  { eCode: 'E0200301', wert: '9000,00', person: 'A', anlage: 'N' },   // einbeh. LSt (Anrechnung)
  { eCode: 'E2000601', wert: '9300', person: 'A', anlage: 'VOR' },    // Altersvorsorge
  { eCode: 'E2003104', wert: '4000', person: 'A', anlage: 'VOR' },    // Basis-KV
];

console.log('\nDedup → elster_felder + Konflikt-Logging\n');
{
  const { elsterFelder, konflikte } = feldateToElsterFelder(felder);
  ok('E0200201 dedupliziert auf größeren Wert (50000)', elsterFelder.E0200201 === '50000', elsterFelder.E0200201);
  ok('Konflikt für E0200201 protokolliert', konflikte.some((k) => k.startsWith('E0200201:')), konflikte);
  ok('nicht-duplizierte Codes unverändert', elsterFelder.E0200301 === '9000,00' && elsterFelder.E2000601 === '9300');
}

console.log('\nFallback: MCP nicht erreichbar → quelle=in-process-fallback\n');
{
  const deadClient = new BmfMcpClient({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 600 });
  const r = await berechneSteuerfallAuthoritativ({ felder, vz: 2023, kirchensteuerHebesatz: 0.09, mcp: deadClient });
  ok('quelle = in-process-fallback', r.quelle === 'in-process-fallback', r.quelle);
  ok('mcpFehler gesetzt', typeof r.mcpFehler === 'string' && r.mcpFehler.length > 0, r.mcpFehler);
  ok('bindend == Vorschau (ESt)', r.bindend.einkommensteuer === r.vorschau.steuer.einkommensteuer, [r.bindend.einkommensteuer, r.vorschau.steuer.einkommensteuer]);
  ok('Vorschau-Latenz < 10 ms', r.latenzMs.vorschau < 10, `${r.latenzMs.vorschau.toFixed(3)} ms`);
  ok('Konflikte durchgereicht', r.konflikte.length >= 1, r.konflikte);
  console.log(`    Vorschau (Fallback): zvE=${r.bindend.zve} ESt=${r.bindend.einkommensteuer} gesamt=${r.bindend.gesamtsteuer} erstattung=${r.erstattung}`);
}

console.log('\nLive MCP-autoritativ (:12010) — übersprungen wenn down\n');
{
  const probe = new BmfMcpClient({ timeoutMs: 2500 });
  let up = true;
  try { await probe.ping(); } catch (e) { up = false; console.log(`  ⚠ MCP down (${(e as Error).message.slice(0, 70)}) — autoritative Asserts übersprungen.`); }
  if (up) {
    const r = await berechneSteuerfallAuthoritativ({ felder, vz: 2023, kirchensteuerHebesatz: 0.09 });
    ok('quelle = mcp (verbindlich)', r.quelle === 'mcp', r.quelle);
    ok('bindende Festsetzung aus MCP (zvE>0)', r.bindend.zve > 0, r.bindend);
    ok('MCP-Latenz gemessen', r.latenzMs.mcp !== null, r.latenzMs);
    ok('Abgleich Vorschau↔MCP vorhanden', !!r.abgleich, r.abgleich);
    ok('Erstattung = angerechnet − Festsetzung', Math.abs(r.erstattung - (r.angerechnet - r.bindend.gesamtsteuer)) < 0.01, [r.erstattung, r.angerechnet, r.bindend.gesamtsteuer]);
    console.log(`    BINDEND (MCP): zvE=${r.bindend.zve} ESt=${r.bindend.einkommensteuer} Soli=${r.bindend.solidaritaetszuschlag} KiSt=${r.bindend.kirchensteuer} gesamt=${r.bindend.gesamtsteuer}`);
    console.log(`    Vorschau     : zvE=${r.vorschau.einkommen.zvE} ESt=${r.vorschau.steuer.einkommensteuer}  → Δ zvE=${r.abgleich?.zveDelta} ΔESt=${r.abgleich?.estDelta} konform=${r.abgleich?.konform}`);
    console.log(`    Latenz: Vorschau ${r.latenzMs.vorschau.toFixed(2)} ms · MCP ${r.latenzMs.mcp?.toFixed(1)} ms · Erstattung ${r.erstattung} €`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
