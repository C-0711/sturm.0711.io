#!/usr/bin/env -S npx tsx
/**
 * conformance — Korrektheits-Batterie: jeder Fall durch BEIDE Engines
 * (In-Process-Rechenkern + autoritative BMF-MCP :12010), Übereinstimmung
 * gemessen und jede Abweichung als Backlog ausgewiesen.
 *
 * Die Übereinstimmung wird ZERLEGT, damit klar ist, WO es divergiert:
 *   • tarif-konform  — In-Process-§32a über die MCP-zvE == MCP-ESt?
 *                      (isoliert die Tarif-Korrektheit; sollte ~100% sein)
 *   • zve-konform    — In-Process-zvE == MCP-zvE? (isoliert die
 *                      Einkommensermittlung §§2/10/22 — hier sitzt die Lücke)
 *   • e2e-konform    — In-Process-ESt == MCP-ESt? (beides zusammen)
 *
 * Was nicht zve-konform ist, ist der priorisierte Backlog für den
 * In-Process-Kern. Die MCP bleibt für JEDEN Fall verbindlich.
 *
 *   TORNADO_ORCHESTRATOR_URL/BMF_MCP_URL optional; npx tsx scripts/conformance.ts
 */
import { BmfMcpClient } from '../src/lib/bmf-mcp-client.ts';
import { bausteineAusFelder, type SteuerFeld } from '../src/workflows/elster/lib/steuer/adapter.ts';
import { berechneSteuerfall } from '../src/workflows/elster/lib/steuer/engine.ts';
import { einkommensteuer, type Veranlagungsart } from '../src/workflows/elster/lib/steuer/tarif.ts';

interface TaxCase {
  name: string;
  vz: number;
  art: Veranlagungsart;
  elsterFelder: Record<string, string>;
}

/** JS-Zahl → deutsches Wire-Format "x,xx". */
const de = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\./g, '');

/** Systematische Fall-Batterie (Einzelveranlagung — MCP-Default, keine
 *  veranlagungsart-Parametrik nötig). Deckt alle §32a-Zonen + die
 *  Aggregations-Regeln (§19 WK, §10 Vorsorge-Höchstbetrag, §22 Rente,
 *  §20 KAP) ab. */
function* battery(): Generator<TaxCase> {
  const vz = 2023, art: Veranlagungsart = 'einzeln';
  // Reine Lohnfälle über die Tarifzonen (testet §19 WK-Pauschbetrag + Tarif).
  for (const lohn of [0, 11000, 14000, 16000, 25000, 40000, 60000, 90000, 150000, 300000]) {
    yield { name: `Lohn ${lohn}`, vz, art, elsterFelder: { E0200201: de(lohn) } };
  }
  // Lohn + Vorsorge — MCP-Vokabular: rv_beitraege=E0202204, kv_beitraege=E2003104.
  for (const [lohn, rv, kv] of [[50000, 9300, 4000], [80000, 14880, 6000], [120000, 16000, 8000]]) {
    yield { name: `Lohn ${lohn} +Vorsorge`, vz, art, elsterFelder: { E0200201: de(lohn), E0202204: de(rv), E2003104: de(kv) } };
  }
  // Rentner — MCP-Vokabular: anlage_r.rente_brutto=E2400103, renteneintritt=E2400107.
  for (const [rente, jahr] of [[24000, 2010], [30000, 2005], [18000, 2020]] as Array<[number, number]>) {
    yield { name: `Rente ${rente} (Beginn ${jahr})`, vz, art, elsterFelder: { E2400103: de(rente), E2400107: String(jahr) } };
  }
  // Mischfall Lohn + Rente.
  yield { name: 'Lohn 35k + Rente 12k (2015)', vz, art, elsterFelder: { E0200201: de(35000), E2400103: de(12000), E2400107: '2015' } };
  // Lohn + Kapitalerträge (§20 — Abgeltungsteuer, i.d.R. NICHT im zvE).
  yield { name: 'Lohn 50k + KAP 5k', vz, art, elsterFelder: { E0200201: de(50000), E1900701: de(5000) } };
}

const ABS_TOL = 1; // € — statutarische Euro-Abrundung
const near = (a: number, b: number, tol = ABS_TOL) => Math.abs(a - b) <= tol;

async function main(): Promise<void> {
  const mcp = new BmfMcpClient({ timeoutMs: 6000 });
  try { await mcp.ping(); } catch (e) {
    console.error(`MCP nicht erreichbar (${(e as Error).message.slice(0, 80)}). Conformance braucht die autoritative Engine — auf H200V ausführen.`);
    process.exit(2);
  }

  const cases = [...battery()];
  let tarifOk = 0, zveOk = 0, e2eOk = 0;
  const backlog: Array<{ name: string; mcpZve: number; ipZve: number; dZve: number; mcpEst: number; ipEst: number }> = [];

  console.log(`\nKonformitäts-Batterie: ${cases.length} Fälle gegen BMF-MCP (autoritativ)\n`);
  console.log('  Fall                             MCP-zvE   IP-zvE     ΔzvE   MCP-ESt   IP-ESt   tarif zve e2e');
  console.log('  ' + '─'.repeat(94));

  for (const c of cases) {
    const res = await mcp.berechneVollstaendigeSteuerV2({ erklaerungsjahr: c.vz, elster_felder: c.elsterFelder });
    const mcpZve = res.daten.zve, mcpEst = res.daten.einkommensteuer;

    const felder: SteuerFeld[] = Object.entries(c.elsterFelder).map(([eCode, wert]) => ({ eCode, wert, person: 'A' }));
    const { eingabe, anrechnung } = bausteineAusFelder(felder, { vz: c.vz, art: c.art, kirchensteuerHebesatz: 0 });
    const ip = berechneSteuerfall({ ...eingabe, anrechnung, kirchensteuerHebesatz: 0 });

    const tarif = near(einkommensteuer(mcpZve, c.vz, c.art), mcpEst, 1.5);   // Tarif über MCP-zvE
    const zve = near(ip.einkommen.zvE, mcpZve);                              // Aggregation
    const e2e = near(ip.steuer.einkommensteuer, mcpEst);                     // beides
    if (tarif) tarifOk++; if (zve) zveOk++; if (e2e) e2eOk++;
    if (!zve) backlog.push({ name: c.name, mcpZve, ipZve: ip.einkommen.zvE, dZve: +(ip.einkommen.zvE - mcpZve).toFixed(0), mcpEst, ipEst: ip.steuer.einkommensteuer });

    const f = (b: boolean) => (b ? ' ✓ ' : ' ✗ ');
    console.log(
      `  ${c.name.padEnd(32)} ${String(mcpZve).padStart(8)} ${String(ip.einkommen.zvE).padStart(8)} ${String(ip.einkommen.zvE - mcpZve).padStart(8)} ${String(Math.round(mcpEst)).padStart(8)} ${String(ip.steuer.einkommensteuer).padStart(8)}  ${f(tarif)}${f(zve)}${f(e2e)}`,
    );
  }

  const pct = (n: number) => `${((100 * n) / cases.length).toFixed(0)}%`;
  console.log('\n  ── Aggregat ──');
  console.log(`  Tarif-konform (§32a über MCP-zvE):  ${tarifOk}/${cases.length}  ${pct(tarifOk)}`);
  console.log(`  zvE-konform (Einkommensermittlung): ${zveOk}/${cases.length}  ${pct(zveOk)}`);
  console.log(`  e2e-konform (ESt gesamt):           ${e2eOk}/${cases.length}  ${pct(e2eOk)}`);

  if (backlog.length) {
    console.log(`\n  ── Backlog (nicht zvE-konform → In-Process-Kern erweitern) ──`);
    for (const b of backlog) {
      const cause = b.dZve < -50 ? 'Über-Abzug (vermutl. §10 Vorsorge-Höchstbetrag)'
        : b.dZve > 50 ? 'Unter-Abzug (fehlende Position)'
          : 'Rundung/§22-Anteil';
      console.log(`    ${b.name.padEnd(30)} ΔzvE=${String(b.dZve).padStart(7)}  → ${cause}`);
    }
  }
  console.log(`\n  Tarif ist die Korrektheits-Basis; Aggregation ist der Backlog. MCP bleibt für jeden Fall verbindlich.\n`);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
