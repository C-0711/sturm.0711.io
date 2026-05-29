#!/usr/bin/env -S npx tsx
/**
 * e2e-steuerfall — DIE ganze Kette in einem Lauf, auf echten Dokumenten:
 *   PDF/Scan → OCR/pdftotext → runLane1 (extract → ELSTER-map → normalize →
 *   case) → je Steuerpflichtigem: berechneSteuerfallAuthoritativ (MCP-
 *   verbindlich + In-Process-Vorschau + Abgleich) → Steuerbescheid.
 *
 *   ELSTER_CATALOG_PG_URL=… TORNADO_ORCHESTRATOR_URL=… BMF_MCP_URL=… \
 *     npx tsx scripts/e2e-steuerfall.ts [--vz 2023] <doc...>
 */
import { extname } from 'node:path';
import pg from 'pg';
import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';
import { ocrEnsembleFromPath, pingOrchestrator } from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import { berechneSteuerfallAuthoritativ } from '../src/workflows/elster/lib/steuer/authoritative.ts';
import type { SteuerFeld } from '../src/workflows/elster/lib/steuer/adapter.ts';

const { Pool } = pg;
const args = process.argv.slice(2);
const vz = Number((args.find((a) => a.startsWith('--vz')) ?? '2023').replace(/\D/g, '') || 2023);
const docs = args.filter((a) => !a.startsWith('--'));
const HEBESATZ = 0.09;
const baseUrl = process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://127.0.0.1:7180';
const pgUrl = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

async function main(): Promise<void> {
  if (docs.length === 0) { console.error('Usage: e2e-steuerfall [--vz 2023] <doc...>'); process.exit(2); }
  const pool = new Pool({ connectionString: pgUrl, max: 4 });
  const orchUp = await pingOrchestrator(baseUrl);
  const parseImage = async (p: string) => ocrEnsembleToRawText(await ocrEnsembleFromPath(p, { baseUrl }));

  console.log(`\n╔═ E2E Steuerfall · ${docs.length} Dokument(e) · VZ ${vz} · Orchestrator ${orchUp ? 'up' : 'DOWN'} ═╗\n`);
  const t0 = process.hrtime.bigint();
  const r = await runLane1(docs, { vz, pool, parseImage: orchUp ? parseImage : undefined });
  const tLane1 = Number(process.hrtime.bigint() - t0) / 1e6;
  await pool.end();

  const methods = r.belege.reduce((m, b) => ((m[b.method] = (m[b.method] ?? 0) + 1), m), {} as Record<string, number>);
  console.log(`① Extraktion: ${r.belege.length} Belege (${JSON.stringify(methods)}) → ${r.aggregated.length} gemappte E-Code-Felder · ${tLane1.toFixed(0)} ms`);
  console.log(`   Household: A=${r.household.personA?.vorname ?? '?'} ${r.household.personA?.nachname ?? ''} · B=${r.household.personB?.vorname ?? '—'} ${r.household.personB?.nachname ?? ''}\n`);

  const felder: SteuerFeld[] = r.aggregated.map((f) => ({ eCode: f.eCode, wert: f.wert, person: f.person, anlage: f.anlage, pdfLabel: f.pdfLabel }));

  for (const person of ['A', 'B'] as const) {
    const pf = felder.filter((f) => f.person === person).map((f) => ({ ...f, person: 'A' as const }));
    if (pf.length === 0) continue;
    const res = await berechneSteuerfallAuthoritativ({ felder: pf, vz, kirchensteuerHebesatz: HEBESATZ });
    const b = res.bindend;
    console.log(`══ Steuerpflichtige/r „Person ${person}" · ${pf.length} Felder · Quelle: ${res.quelle.toUpperCase()} ══`);
    console.log(`   zu versteuerndes Einkommen (zvE)   ${eur(b.zve).padStart(16)}`);
    console.log(`   Einkommensteuer (§32a)             ${eur(b.einkommensteuer).padStart(16)}`);
    console.log(`   Solidaritätszuschlag               ${eur(b.solidaritaetszuschlag).padStart(16)}`);
    console.log(`   Kirchensteuer (9%)                 ${eur(b.kirchensteuer).padStart(16)}`);
    console.log(`   festgesetzte Gesamtsteuer          ${eur(b.gesamtsteuer).padStart(16)}`);
    console.log(`   − angerechnet (LSt/Soli/KiSt/KapESt)${eur(res.angerechnet).padStart(15)}`);
    const saldo = res.erstattung >= 0 ? `ERSTATTUNG ${eur(res.erstattung)}` : `NACHZAHLUNG ${eur(-res.erstattung)}`;
    console.log(`   ▶ ${saldo}`);
    if (res.abgleich) {
      console.log(`   Abgleich In-Process↔MCP: ΔzvE=${res.abgleich.zveDelta} ΔESt=${res.abgleich.estDelta} konform=${res.abgleich.konform} · Latenz Vorschau ${res.latenzMs.vorschau.toFixed(2)}ms / MCP ${res.latenzMs.mcp?.toFixed(0)}ms`);
    } else {
      console.log(`   (MCP nicht erreichbar → In-Process-Fallback; ${res.mcpFehler?.slice(0, 60)})`);
    }
    if (res.konflikte.length) console.log(`   ⚠ ${res.konflikte.length} E-Code-Konflikt(e) dedupliziert`);
    console.log('');
  }
  console.log('(Multi-Steuerpflichtigen-Korpus → pro Person ein Einzelveranlagungs-Bescheid; Beträge illustrativ.)');
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
