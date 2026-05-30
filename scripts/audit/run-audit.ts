#!/usr/bin/env -S npx tsx
/**
 * run-audit — fährt die generierten Steuerfälle durch den Lane-1-BMF-Rechner
 * (v2-Gesamtbescheid) und auditiert das Ergebnis gegen Steuerrecht-Invarianten.
 *
 * Phasen:
 *   A · Bescheid je Fall: v2-Call → Struktur-, Tarif-, Splitting- (vs sturm-Kern),
 *       Soli-, Grundfreibetrag-Invarianten + Latenz.
 *   B · Modul-Wirksamkeit (Toggle): pro Erleichterungs-/Abzugs-Modul werden K
 *       Fälle erneut OHNE die Trigger-E-Codes des Moduls gerechnet. ΔESt muss
 *       die richtige Richtung haben (Abzug senkt Steuer). ΔESt=0 ⇒ Modul wird
 *       still ignoriert (Bug-Klasse). Das ist die eigentliche „durch alle
 *       Rechner"-Prüfung — v2 ruft die Rechner intern, der Toggle misst es.
 *   C · Determinismus: Stichprobe 2× → identische ESt.
 *
 *   BMF_MCP_URL=http://localhost:12010/mcp npx tsx scripts/audit/run-audit.ts \
 *       [--cases FILE] [--n 1000] [--conc 8] [--toggle-k 6] [--report FILE]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BmfMcpClient } from '../../src/lib/bmf-mcp-client.ts';
import { einkommensteuer } from '../../src/workflows/elster/lib/steuer/tarif.ts';

type Case = { id: string; archetype: string; erklaerungsjahr: number; veranlagungsart: 'einzeln' | 'zusammen'; elster_felder: Record<string, string>; expected_active_modules: string[] };

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CASES_FILE = arg('--cases', '/tmp/audit-cases.json');
const LIMIT = Number(arg('--n', '0')) || 0;
const CONC = Number(arg('--conc', '8'));
const TOGGLE_K = Number(arg('--toggle-k', '6'));
const REPORT = arg('--report', '/tmp/audit-report.md');

// Grundfreibetrag + Soli-Freigrenze (ESt-Betrag) je VZ/Art.
const GFB: Record<number, { einzeln: number; zusammen: number }> = { 2023: { einzeln: 10908, zusammen: 21816 }, 2024: { einzeln: 11784, zusammen: 23568 } };
const SOLI_FREI: Record<number, { einzeln: number; zusammen: number }> = { 2023: { einzeln: 17543, zusammen: 35086 }, 2024: { einzeln: 18130, zusammen: 36260 } };

// Module, die die Steuer SENKEN müssen (Abzug/Erleichterung) → Toggle-Audit.
// Income-Module (anlage_r/kap/v/g/s/so/l/aus, tarif_32a) sind ausgenommen.
const RELIEF_TRIGGERS: Record<string, string[]> = {
  haushaltsnahe_35a: ['E0107301', 'E0107302', 'E0107303', 'E0107304', 'E0107305', 'E0107306'],
  energie_35c: ['E0107701', 'E0107702', 'E0107703', 'E0107710'],
  spenden_10b: ['E0105502', 'E0107602', 'E0108004', 'E0108405', 'E0108701', 'E0108702'],
  aussergewoehnliche_33: ['E0701001', 'E0701002', 'E0701003', 'E0701004', 'E0701101', 'E0701201', 'E0701301'],
  behinderten_pauschbetrag: ['E0203507', 'E0223706'],
  pflege_pauschbetrag: ['E0702101'],
  hinterbliebenen_pauschbetrag: ['E0109704', 'E0109705'],
  anlage_kind: ['E0000001', 'E0504505', 'E0505002', 'E0507301', 'E0508505', 'E0508506', 'E0508507'],
  ausbildungsfreibetrag: ['E0507301'],
  anlage_unterhalt: ['E0107601', 'E0108001'],
  entfernungspauschale: ['E0203503', 'E0203504', 'E0207116'],
};
/** STRENG: echte Kredite/Sonderausgaben OHNE Schwelle — MÜSSEN die Steuer
 *  senken, ΔGesamt=0 ist ein Bug (v2 integriert das Modul nicht). */
const STRICT_MODULES = new Set(['haushaltsnahe_35a', 'energie_35c', 'spenden_10b']);
/** NACHSICHTIG: Schwellen-/Günstigerprüfungs-Module — ΔGesamt=0 kann KORREKT
 *  sein (Entfernungspauschale < WK-Pauschbetrag; §33 < zumutbare Belastung;
 *  Kinderfreibetrag verliert Günstigerprüfung gegen Kindergeld). Nur die
 *  FALSCHE Richtung (Steuer steigt) ist hier ein Befund. */
// (alle übrigen RELIEF_TRIGGERS)

const mcp = new BmfMcpClient({ timeoutMs: 20_000 });

async function v2(vz: number, felder: Record<string, string>) {
  const t0 = process.hrtime.bigint();
  const r = await mcp.berechneVollstaendigeSteuerV2({ erklaerungsjahr: vz, elster_felder: felder });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { r, ms };
}
/** felder ohne die (auch __B-) Codes eines Moduls. */
function strip(felder: Record<string, string>, codes: string[]): Record<string, string> {
  const set = new Set(codes); const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(felder)) if (!set.has(k.replace(/__B$/, ''))) out[k] = v;
  return out;
}
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

interface Finding { case: string; check: string; detail: string }

async function main(): Promise<void> {
  let cases: Case[] = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  if (LIMIT) cases = cases.slice(0, LIMIT);
  console.log(`\n╔═ Lane-1-Audit · ${cases.length} Fälle · MCP ${process.env.BMF_MCP_URL ?? ':12010'} ═╗\n`);

  // ── Phase A: Bescheid je Fall ──
  const findings: Finding[] = [];
  const lat: number[] = [];
  let ok = 0, hardErr = 0;
  const estByCase = new Map<string, number>();
  const soliByCase = new Map<string, number>();

  const results = await pool(cases, CONC, async (c) => {
    try { const { r, ms } = await v2(c.erklaerungsjahr, c.elster_felder); return { c, r, ms }; }
    catch (e) { return { c, err: (e as Error).message }; }
  });

  for (const res of results) {
    const c = res.c;
    if ('err' in res) { hardErr++; findings.push({ case: c.id, check: 'RPC', detail: res.err! }); continue; }
    const d = res.r.daten; lat.push(res.ms);
    if (!res.r.erfolg) { findings.push({ case: c.id, check: 'erfolg', detail: 'erfolg=false' }); continue; }
    const zve = Number(d.zve), est = Number(d.einkommensteuer), soli = Number(d.solidaritaetszuschlag ?? 0);
    estByCase.set(c.id, est); soliByCase.set(c.id, soli);
    const F = (check: string, detail: string) => findings.push({ case: c.id, check, detail });
    const gfb = GFB[c.erklaerungsjahr][c.veranlagungsart], frei = SOLI_FREI[c.erklaerungsjahr][c.veranlagungsart];
    if (!(zve >= 0)) F('zve>=0', `zvE=${zve}`);
    if (!(est >= 0)) F('est>=0', `ESt=${est}`);
    if (est > zve + 1) F('est<=zve', `ESt ${est} > zvE ${zve}`);
    if (zve <= gfb && est > 1) F('grundfreibetrag', `zvE ${zve} ≤ GFB ${gfb} aber ESt ${est}`);
    // Soli=0 nur weit UNTER der Freigrenze prüfen (Milderungszone-Rand meiden).
    if (est < frei * 0.85 && soli > 0.01) F('soli-nullzone', `ESt ${est} ≪ Freigr. ${frei} aber Soli ${soli}`);
    if (soli > est * 0.06 + 1) F('soli<=5.5%', `Soli ${soli} > 5,5% ESt`);
    if (d.grenzsteuersatz != null && Number(d.grenzsteuersatz) > 0.4501) F('grenz<=45%', `${d.grenzsteuersatz}`);
    // Tarif-Konformität vs sturm-Kern — NUR auf reinen Fällen: Kredite (§35a/§35c)
    // senken die MCP-ESt NACH dem Tarif, anlage_aus bringt Progressionsvorbehalt
    // → dort ist MCP-ESt ≠ tarifliche §32a(zvE), Vergleich wäre Apfel/Birne.
    const confound = c.expected_active_modules.some((m) => m === 'haushaltsnahe_35a' || m === 'energie_35c' || m === 'anlage_aus' || m === 'anlage_kind');
    if (!confound) {
      const ip = einkommensteuer(zve, c.erklaerungsjahr, c.veranlagungsart === 'zusammen' ? 'zusammen' : 'einzeln');
      if (Math.abs(ip - est) > 2) F('tarif-konform', `sturm §32a=${ip} vs MCP=${est} (Δ${(ip - est).toFixed(0)}) zvE=${zve} ${c.veranlagungsart}`);
    }
    if (findings.filter((x) => x.case === c.id).length === 0) ok++;
  }

  // ── Phase B: Modul-Wirksamkeit (Toggle) ──
  type ModStat = { strict: boolean; tested: number; fired: number; noEffect: string[]; wrong: string[] };
  const modStats: Record<string, ModStat> = {};
  for (const [mod, codes] of Object.entries(RELIEF_TRIGGERS)) {
    const hits = cases.filter((c) => c.expected_active_modules.includes(mod) && estByCase.has(c.id)).slice(0, TOGGLE_K);
    const st: ModStat = { strict: STRICT_MODULES.has(mod), tested: 0, fired: 0, noEffect: [], wrong: [] };
    await pool(hits, CONC, async (c) => {
      try {
        const { r } = await v2(c.erklaerungsjahr, strip(c.elster_felder, codes));
        if (!r.erfolg) return;
        // Wirkung auf ESt+Soli (Kinderfreibetrag etc. wirkt teils nur auf Soli/KiSt).
        const without = Number(r.daten.einkommensteuer) + Number(r.daten.solidaritaetszuschlag ?? 0);
        const full = estByCase.get(c.id)! + (soliByCase.get(c.id) ?? 0);
        st.tested++;
        if (full > without + 0.5) st.wrong.push(c.id);          // Steuer STIEG durch Abzug → immer Bug
        else if (without - full < 0.5) st.noEffect.push(c.id);  // kein Effekt (strict=Bug, sonst Schwelle)
        else st.fired++;                                         // Steuer sank → korrekt
      } catch { /* skip */ }
    });
    modStats[mod] = st;
  }

  // ── Phase C: Determinismus (Stichprobe) ──
  const sample = cases.filter((c) => estByCase.has(c.id)).slice(0, 40);
  let detOk = 0, detFail = 0;
  await pool(sample, CONC, async (c) => {
    try { const { r } = await v2(c.erklaerungsjahr, c.elster_felder);
      if (Math.abs(Number(r.daten.einkommensteuer) - estByCase.get(c.id)!) < 0.005) detOk++; else { detFail++; findings.push({ case: c.id, check: 'determinismus', detail: `ESt ${r.daten.einkommensteuer} ≠ ${estByCase.get(c.id)}` }); } }
    catch { /* skip */ }
  });

  // ── Report ──
  lat.sort((a, b) => a - b);
  const pct = (n: number, t: number) => t ? (n / t * 100).toFixed(1) + '%' : '—';
  const p = (q: number) => lat.length ? lat[Math.floor(lat.length * q)].toFixed(0) : '—';
  const byCheck: Record<string, number> = {};
  for (const f of findings) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;

  let md = `# Lane-1 Audit Report\n\n`;
  md += `**Fälle:** ${cases.length} · **fehlerfrei:** ${ok} (${pct(ok, cases.length)}) · **harte RPC-Fehler:** ${hardErr}\n`;
  md += `**Latenz v2** (ms): p50 ${p(0.5)} · p95 ${p(0.95)} · max ${lat.length ? lat[lat.length - 1].toFixed(0) : '—'}\n`;
  md += `**Determinismus:** ${detOk} ok / ${detFail} abweichend\n\n`;

  md += `## Invarianten — Verstöße je Check\n\n| Check | Verstöße |\n|---|---|\n`;
  const checks = ['erfolg', 'zve>=0', 'est>=0', 'est<=zve', 'grundfreibetrag', 'soli-nullzone', 'soli<=5.5%', 'grenz<=45%', 'tarif-konform', 'determinismus', 'RPC'];
  for (const ch of checks) md += `| ${ch} | ${byCheck[ch] ?? 0} |\n`;

  md += `\n## ★ Modul-Wirksamkeit (Toggle: Trigger-Codes entfernt → Steuer muss sinken)\n\n`;
  md += `Typ **streng** = Kredit/Sonderausgabe ohne Schwelle → ΔSteuer=0 ist ein Bug. `;
  md += `Typ **Schwelle** = Pauschbetrag/Günstigerprüfung → ΔSteuer=0 kann korrekt sein (nur falsche Richtung = Bug).\n\n`;
  md += `| Modul | Typ | getestet | senkt Steuer | kein Effekt | falsche Richtung |\n|---|---|---|---|---|---|\n`;
  for (const [mod, st] of Object.entries(modStats)) {
    const bug = (st.strict && st.noEffect.length) || st.wrong.length;
    md += `| ${mod}${bug ? ' ⚠️' : ''} | ${st.strict ? 'streng' : 'Schwelle'} | ${st.tested} | ${st.fired} | ${st.noEffect.length} | ${st.wrong.length} |\n`;
  }
  const bugMods = Object.entries(modStats).filter(([, s]) => (s.strict && s.noEffect.length) || s.wrong.length);
  if (bugMods.length) {
    md += `\n### ⚠️ Auffällige Module (v2-Integration prüfen)\n\n`;
    for (const [mod, s] of bugMods) {
      if (s.strict && s.noEffect.length) md += `- **${mod}** (streng): ${s.noEffect.length}/${s.tested} Fälle OHNE Steuereffekt trotz Kredit → v2 wendet das Modul nicht an. z.B. \`${s.noEffect.slice(0, 3).join(', ')}\`\n`;
      if (s.wrong.length) md += `- **${mod}**: ${s.wrong.length}/${s.tested} Fälle mit FALSCHER Richtung (Abzug erhöht Steuer). z.B. \`${s.wrong.slice(0, 3).join(', ')}\`\n`;
    }
  }

  if (findings.length) {
    md += `\n## Befund-Beispiele (max 25)\n\n`;
    for (const f of findings.slice(0, 25)) md += `- \`${f.case}\` **${f.check}**: ${f.detail}\n`;
  }

  writeFileSync(REPORT, md);
  writeFileSync(REPORT.replace(/\.md$/, '') + '.json', JSON.stringify({ ok, hardErr, total: cases.length, byCheck, modStats, latency: { p50: p(0.5), p95: p(0.95) }, findings }, null, 2));

  // ── Konsolen-Summary ──
  console.log(`Phase A: ${ok}/${cases.length} fehlerfrei · ${hardErr} RPC-Fehler · Latenz p50 ${p(0.5)}ms p95 ${p(0.95)}ms`);
  console.log(`Invarianten-Verstöße: ${Object.entries(byCheck).map(([k, v]) => `${k}=${v}`).join(' · ') || 'keine'}`);
  console.log(`Determinismus: ${detOk} ok / ${detFail} fail`);
  console.log(`\nModul-Wirksamkeit (streng=Kredit, Schwelle=Pauschbetrag):`);
  for (const [mod, st] of Object.entries(modStats)) {
    const bug = (st.strict && st.noEffect.length) || st.wrong.length;
    console.log(`  ${mod.padEnd(28)} [${st.strict ? 'streng  ' : 'Schwelle'}] senkt ${st.fired}/${st.tested}${st.noEffect.length ? `  kein-Effekt ${st.noEffect.length}` : ''}${st.wrong.length ? `  ✗falsch ${st.wrong.length}` : ''}${bug ? '  ⚠️' : ''}`);
  }
  console.log(`\n→ Report: ${REPORT}  (+ .json)`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
