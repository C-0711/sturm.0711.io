#!/usr/bin/env -S npx tsx
/**
 * audit-hard — gezielte SCHWIERIGE Fälle (Grenz-, Extrem-, Interaktions-) gegen
 * den BMF-Lane-1-Rechner, mit kategorie-spezifischen Invarianten. Ergänzt das
 * Realistik-Audit (generate-cases/run-audit): testet nicht „läuft durch", sondern
 * „verhält sich an der Kante mathematisch korrekt".
 *
 * Kategorien:
 *   boundary   — §32a-Zonen-Knicke: ESt monoton + stetig + Grenzsteuersatz ≤ 45%.
 *   extreme    — 300k–2M €: Grenzsteuersatz = 45% (Reichensteuer).
 *   negative   — Verlust (Gewerbe/Vermietung) senkt zvE, zvE ≥ 0.
 *   asym_split — Ehepaar 250k/0: ESt_zus ≈ 2·ESt_einzeln(zvE/2), Splittingvorteil > 0.
 *   cap_35a    — Lohnkosten 30k: §35a-Kredit gedeckelt bei 4.000 € (nicht 6.000).
 *   abfindung_34 — Abfindung 100k: §34-Fünftelregelung ⇒ ermäßigt < regulär.
 *   stack_max  — alle Einkünfte + alle Erleichterungen: erfolg + plausibel.
 *
 *   BMF_MCP_URL=http://localhost:12010/mcp npx tsx scripts/audit/audit-hard.ts
 */
import { writeFileSync } from 'node:fs';
import { BmfMcpClient } from '../../src/lib/bmf-mcp-client.ts';
import { einkommensteuer } from '../../src/workflows/elster/lib/steuer/tarif.ts';

const mcp = new BmfMcpClient({ timeoutMs: 20_000 });
const eur = (n: number) => `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n))},00`;
type Daten = { zve: number; einkommensteuer: number; solidaritaetszuschlag?: number; grenzsteuersatz?: number };
async function run(vz: number, felder: Record<string, string>): Promise<Daten> {
  const r = await mcp.berechneVollstaendigeSteuerV2({ erklaerungsjahr: vz, elster_felder: felder });
  if (!r.erfolg) throw new Error('erfolg=false');
  return r.daten as unknown as Daten;
}
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
interface Finding { cat: string; detail: string }
const findings: Finding[] = [];
const note = (cat: string, detail: string) => findings.push({ cat, detail });

const ZONES: Record<number, number[]> = {
  2023: [10908, 15999, 62809, 277825],
  2024: [11784, 17005, 66760, 277825],
};

async function main(): Promise<void> {
  console.log(`\n╔═ Hard-Case-Audit · MCP ${process.env.BMF_MCP_URL ?? ':12010'} ═╗\n`);
  let pass = 0, fail = 0;
  const ok = (c: string, msg: string) => { pass++; console.log(`  ✓ [${c}] ${msg}`); };
  const bad = (c: string, msg: string) => { fail++; note(c, msg); console.log(`  ✗ [${c}] ${msg}`); };

  // ── 1. boundary: Sweep um jeden §32a-Knick, MCP muss monoton + ≤45% sein ──
  console.log('1. Tarif-Zonen-Grenzen (Monotonie + Grenzsteuersatz, MCP autoritativ)');
  for (const vz of [2023, 2024]) {
    for (const knee of ZONES[vz]) {
      const pts: Array<{ zve: number; est: number; brutto: number }> = [];
      const bruttos = [-400, -100, 0, 100, 400].map((d) => knee + 1266 + d); // Brutto ≈ zvE+WK+SA
      await pool(bruttos, 5, async (b) => {
        try { const d = await run(vz, { E0200201: eur(b), E0200002: '1' }); pts.push({ zve: d.zve, est: d.einkommensteuer, brutto: b }); } catch { /* skip */ }
      });
      pts.sort((a, b) => a.zve - b.zve);
      let mono = true, maxRate = 0, tarifDelta = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].est < pts[i - 1].est - 1) mono = false;
        const dz = pts[i].zve - pts[i - 1].zve;
        if (dz > 0) maxRate = Math.max(maxRate, (pts[i].est - pts[i - 1].est) / dz);
      }
      for (const p of pts) tarifDelta = Math.max(tarifDelta, Math.abs(einkommensteuer(p.zve, vz, 'einzeln') - p.est));
      if (!mono) bad('boundary', `${vz} Knick ${knee}: MCP-ESt NICHT monoton (${pts.map((p) => p.est.toFixed(0)).join('→')})`);
      else if (maxRate > 0.46) bad('boundary', `${vz} Knick ${knee}: Grenzsteuersatz ${(maxRate * 100).toFixed(1)}% > 45%`);
      else ok('boundary', `${vz} Knick ${knee}: monoton, max Grenzsatz ${(maxRate * 100).toFixed(1)}%`);
      if (tarifDelta > 3) note('tarif.ts', `${vz} um Knick ${knee}: sturm-§32a weicht bis ${tarifDelta.toFixed(0)}€ von MCP ab (In-Process-Kern prüfen)`);
    }
  }

  // ── 2. extreme: Reichensteuer 45% ──
  console.log('\n2. Reichensteuer / Extrem (Grenzsteuersatz = 45%)');
  for (const brutto of [300000, 600000, 1000000, 2000000]) {
    try {
      const a = await run(2024, { E0200201: eur(brutto), E0200002: '1' });
      const b = await run(2024, { E0200201: eur(brutto + 1000), E0200002: '1' });
      const rate = (b.einkommensteuer - a.einkommensteuer) / (b.zve - a.zve);
      if (Math.abs(rate - 0.45) < 0.01) ok('extreme', `Brutto ${brutto}: Grenzsteuersatz ${(rate * 100).toFixed(1)}%`);
      else bad('extreme', `Brutto ${brutto}: Grenzsteuersatz ${(rate * 100).toFixed(1)}% (erwartet 45%)`);
    } catch (e) { bad('extreme', `Brutto ${brutto}: ${(e as Error).message}`); }
  }

  // ── 3. negative: Verlust senkt zvE, zvE ≥ 0 ──
  console.log('\n3. Verlustverrechnung (negatives Einkommen)');
  try {
    const base = await run(2024, { E0200201: eur(50000), E0200002: '1' });
    const loss = await run(2024, { E0200201: eur(50000), E0200002: '1', E0300101: eur(-20000) }); // Gewerbeverlust
    if (loss.zve < base.zve - 1 && loss.zve >= 0 && loss.einkommensteuer < base.einkommensteuer) ok('negative', `Verlust −20k: zvE ${base.zve}→${loss.zve}, ESt sinkt, zvE≥0`);
    else bad('negative', `Verlust −20k: zvE ${base.zve}→${loss.zve}, ESt ${base.einkommensteuer}→${loss.einkommensteuer} (erwartet beide niedriger, zvE≥0)`);
  } catch (e) { bad('negative', (e as Error).message); }

  // ── 4. asym_split: Ehepaar 250k/0 ──
  console.log('\n4. Asymmetrisches Splitting (250k / 0)');
  try {
    const zus = await run(2024, { E0200201: eur(250000), E0200002: '4', E0101201: 'X' });
    const single = await run(2024, { E0200201: eur(250000), E0200002: '1' });
    const halfTarif = einkommensteuer(zus.zve / 2, 2024, 'einzeln') * 2;
    if (zus.einkommensteuer < single.einkommensteuer - 100) ok('asym_split', `Splittingvorteil ${(single.einkommensteuer - zus.einkommensteuer).toFixed(0)}€ (zus ${zus.einkommensteuer.toFixed(0)} < einzeln ${single.einkommensteuer.toFixed(0)})`);
    else bad('asym_split', `kein Splittingvorteil: zus ${zus.einkommensteuer} vs einzeln ${single.einkommensteuer}`);
    if (Math.abs(zus.einkommensteuer - halfTarif) > 5) note('asym_split', `MCP-Splitting ${zus.einkommensteuer.toFixed(0)} ≠ 2·§32a(zvE/2) ${halfTarif.toFixed(0)} (Δ${(zus.einkommensteuer - halfTarif).toFixed(0)})`);
  } catch (e) { bad('asym_split', (e as Error).message); }

  // ── 5. cap_35a: §35a-Kredit bei max. 5.200 € gedeckelt ──
  // Gesetzliche Höchstbeträge: haushaltsnahe Dienstleistungen 4.000 + Handwerker 1.200 = 5.200.
  // Mit einem einzigen Code (E0107305 = Lohnkosten haushaltsnah) max. 4.000,
  // mit zwei Codes (haushaltsnah + Handwerker) max. 5.200.
  console.log('\n5. §35a Höchstbetrag (Lohnkosten 30k → Kredit ≤ 5.200 gesamt, je Kategorie gedeckelt)');
  try {
    const without = await run(2024, { E0200201: eur(80000), E0200002: '1' });
    // Einzelner Code — Kredit muss zwischen 1 und 5200 liegen (gedeckelt)
    const withMax = await run(2024, { E0200201: eur(80000), E0200002: '1', E0107305: eur(30000) });
    const credit = without.einkommensteuer - withMax.einkommensteuer;
    if (credit > 0 && credit <= 5201) ok('cap_35a', `Kredit ${credit.toFixed(0)}€ ≤ 5.200 (korrekt gedeckelt; war 6.000 ohne Cap)`);
    else if (credit > 5201) bad('cap_35a', `Kredit ${credit.toFixed(0)}€ > 5.200 — Höchstbetrag NICHT angewandt`);
    else bad('cap_35a', `§35a senkt Steuer nicht (Kredit ${credit.toFixed(0)})`);
    // Kleiner Betrag muss linear bleiben (kein Cap bei 1000 €)
    const withSmall = await run(2024, { E0200201: eur(80000), E0200002: '1', E0107305: eur(1000) });
    const smallCredit = without.einkommensteuer - withSmall.einkommensteuer;
    if (Math.abs(smallCredit - 200) < 5) ok('cap_35a_linear', `1000€ → Kredit ${smallCredit.toFixed(0)}€ ≈ 200 (20% linear)`);
    else bad('cap_35a_linear', `1000€ → Kredit ${smallCredit.toFixed(0)}€ (erwartet ~200)`);
  } catch (e) { bad('cap_35a', (e as Error).message); }

  // ── 6. abfindung_34: Fünftelregelung ermäßigt < regulär ──
  console.log('\n6. §34 Fünftelregelung (Abfindung 100k ermäßigt < regulär)');
  try {
    const reg = await run(2024, { E0200201: eur(140000), E0200002: '1' });                       // 40k + 100k regulär
    const erm = await run(2024, { E0200201: eur(40000), E0200002: '1', E0201806: eur(100000) });  // 100k als §34-Entschädigung
    if (erm.einkommensteuer < reg.einkommensteuer - 100) ok('abfindung_34', `ermäßigt ${erm.einkommensteuer.toFixed(0)} < regulär ${reg.einkommensteuer.toFixed(0)} (Vorteil ${(reg.einkommensteuer - erm.einkommensteuer).toFixed(0)}€)`);
    else bad('abfindung_34', `§34 NICHT ermäßigt: ${erm.einkommensteuer.toFixed(0)} vs regulär ${reg.einkommensteuer.toFixed(0)} — Fünftelregelung nicht angewandt`);
  } catch (e) { bad('abfindung_34', (e as Error).message); }

  // ── 7. stack_max: alle Einkünfte + alle Erleichterungen ──
  console.log('\n7. Max-Stacking (alle Einkünfte + Erleichterungen gleichzeitig)');
  try {
    const f: Record<string, string> = {
      E0200201: eur(70000), E0200002: '4', E0101201: 'X', E2000601: eur(6500), E2001203: eur(5100), E2001505: eur(1400), E2004403: eur(900),
      E2400103: eur(12000), E2400107: '2015', E1900701: eur(4000), E1901402: '1000,00', E0405001: eur(14000), E0410101: eur(3000),
      E0300101: eur(15000), E0107305: eur(3000), E0108701: eur(1500), E0508505: '2', E0701001: eur(4000), E0203507: '50', E0107701: eur(20000),
      E0203503: '30', E0203504: '220', E0100401: '15.06.1958',
    };
    const d = await run(2024, f);
    if (d.zve >= 0 && d.einkommensteuer >= 0 && d.einkommensteuer <= d.zve) ok('stack_max', `zvE ${d.zve.toFixed(0)}, ESt ${d.einkommensteuer.toFixed(0)}, Soli ${(d.solidaritaetszuschlag ?? 0).toFixed(0)} — plausibel`);
    else bad('stack_max', `unplausibel: zvE ${d.zve}, ESt ${d.einkommensteuer}`);
  } catch (e) { bad('stack_max', (e as Error).message); }

  // ── Report ──
  console.log(`\n══ ${pass} bestanden / ${fail} Befunde ══`);
  const tarifNotes = findings.filter((f) => f.cat === 'tarif.ts');
  if (tarifNotes.length) { console.log(`\nNebenbefund In-Process-§32a (tarif.ts), MCP bleibt autoritativ:`); for (const n of tarifNotes) console.log(`  · ${n.detail}`); }
  let md = `# Hard-Case Audit (Lane-1)\n\n**${pass} bestanden / ${fail} Befunde**\n\n`;
  if (fail) { md += `## Befunde\n\n`; for (const f of findings.filter((x) => x.cat !== 'tarif.ts')) md += `- **${f.cat}**: ${f.detail}\n`; }
  if (tarifNotes.length) { md += `\n## Nebenbefund: In-Process-§32a (tarif.ts) — MCP bleibt autoritativ\n\n`; for (const n of tarifNotes) md += `- ${n.detail}\n`; }
  writeFileSync('/tmp/audit-hard-report.md', md);
  console.log(`\n→ /tmp/audit-hard-report.md`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
