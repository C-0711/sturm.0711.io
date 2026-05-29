#!/usr/bin/env -S npx tsx
/**
 * mcp-pension-probe — Warum liefert die BMF-MCP zvE=0 für eine Leibrente?
 * Listet die Rechner-Tools und testet verschiedene Anlage-R-E-Code-Sätze,
 * um den vom MCP erwarteten Renten-Input zu finden.
 */
import { BmfMcpClient } from '../src/lib/bmf-mcp-client.ts';

const mcp = new BmfMcpClient({ timeoutMs: 6000 });

async function calc(label: string, felder: Record<string, string>): Promise<void> {
  try {
    const r = await mcp.berechneVollstaendigeSteuerV2({ erklaerungsjahr: 2023, elster_felder: felder });
    const z = r.daten?.berechnungsdetails?.steuer_berechnung;
    console.log(`  ${label.padEnd(46)} zvE=${String(r.daten?.zve).padStart(8)}  ESt=${String(Math.round(r.daten?.einkommensteuer ?? -1)).padStart(7)}  zone=${z?.steuerzone ?? '—'}`);
  } catch (e) {
    console.log(`  ${label.padEnd(46)} FEHLER ${(e as Error).message.slice(0, 60)}`);
  }
}

async function main(): Promise<void> {
  await mcp.ping();
  console.log('\n=== MCP-Tools mit Renten-/Anlage-R-Bezug ===');
  const tools = await mcp.listTools();
  console.log(`  (${tools.length} Tools gesamt)`);
  for (const t of tools) {
    if (/rent|anlage.?r|leibrent|pension|22|alters/i.test(`${t.name} ${t.description ?? ''}`)) {
      console.log(`  • ${t.name} — ${(t.description ?? '').slice(0, 90)}`);
    }
  }

  console.log('\n=== Renten-Input-Varianten (Referenz: Lohn 24.000 → zvE≠0) ===');
  await calc('Lohn 24.000 (Referenz §19)', { E0200201: '24000,00' });
  await calc('Rente E1800301 nur', { E1800301: '24000,00' });
  await calc('Rente E1800301 + Beginn E1800501', { E1800301: '24000,00', E1800501: '01.06.2010' });
  await calc('Rente E1800301 + Anpassung E1800606', { E1800301: '24000,00', E1800606: '0,00' });
  await calc('Rente E1800301+Beginn+Anpassung', { E1800301: '24000,00', E1800501: '01.06.2010', E1800606: '0,00' });
  // Andere Anlage-R-Kandidaten (Renten-/Leistungsbetrag-Varianten)
  await calc('E1800201 (Rentenart/-betrag?)', { E1800201: '24000,00' });
  await calc('E1800101', { E1800101: '24000,00' });
  await calc('E1801301 (Leibrente Kennzahl?)', { E1801301: '24000,00' });

  console.log('\n=== Tool-Schema des Vollrechners (erwartete Felder) ===');
  const full = tools.find((t) => /vollstaendige_steuer_v2/.test(t.name));
  if (full) console.log(JSON.stringify(full, null, 2).slice(0, 1500));
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
