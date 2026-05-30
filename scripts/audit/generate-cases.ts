#!/usr/bin/env -S npx tsx
/**
 * generate-cases — synthetischer Steuerfall-Generator für das Lane-1-Audit.
 *
 * Erzeugt N Fälle im MCP-Wire-Format ({erklaerungsjahr, elster_felder,
 * veranlagungsart}) nach einer REALISTISCHEN Steuerzahler-Verteilung
 * (Archetyp-Häufigkeiten + Abzugs-/Erleichterungs-Prävalenzen), nicht als
 * Covering-Array. Seed-deterministisch (LCG) → reproduzierbar.
 *
 * Jeder Fall wird mit `expected_active_modules` getaggt: die Lane-1-Module,
 * deren Trigger-E-Codes (DB-SSOT module_mappings) im Fall vorkommen. Das ist
 * die Referenz für den Audit (Modul muss feuern → ΔESt≠0).
 *
 *   npx tsx scripts/audit/generate-cases.ts [--n 1000] [--seed 42] [--out FILE]
 */
import { writeFileSync } from 'node:fs';

// ── DB-SSOT: Modul → Trigger-E-Codes (lane1_bmf_calculator.module_mappings) ──
const TRIGGER: Record<string, string[]> = {
  altersentlastungsbetrag_24a: ['E0100401', 'E0101001'],
  anlage_aus: ['E1100102', 'E1100301', 'E1100302'],
  anlage_g: ['E0300101', 'E0300201', 'E0300301', 'E0300401', 'E0301101', 'E0301201', 'E0301301', 'E0301401'],
  anlage_kap: ['E0801401', 'E1900701', 'E1901401', 'E1901402'],
  anlage_kind: ['E0000001', 'E0504505', 'E0505002', 'E0507301', 'E0508505', 'E0508506', 'E0508507'],
  anlage_l: ['E0600101'],
  anlage_r: ['E1800301', 'E2400103', 'E2400107', 'E2400203', 'E2400207'],
  anlage_s: ['E0300101', 'E0300201', 'E0300301', 'E0300401', 'E0301101', 'E0301201', 'E0301301', 'E0301401'],
  anlage_so: ['E0900101', 'E0900102'],
  anlage_unterhalt: ['E0107601', 'E0108001'],
  anlage_v: ['E0405001', 'E0405101', 'E0408101', 'E0408102', 'E0410101', 'E0410102', 'E0410201', 'E0410501', 'E0410801', 'E0410901', 'E0411001', 'E0411201'],
  arbeitnehmer_sparzulage: ['E0218101'],
  ausbildungsfreibetrag: ['E0507301'],
  aussergewoehnliche_33: ['E0701001', 'E0701002', 'E0701003', 'E0701004', 'E0701101', 'E0701201', 'E0701301'],
  behinderten_pauschbetrag: ['E0203507', 'E0223706'],
  energie_35c: ['E0107701', 'E0107702', 'E0107703', 'E0107710'],
  entfernungspauschale: ['E0203503', 'E0203504', 'E0207116'],
  haushaltsnahe_35a: ['E0107301', 'E0107302', 'E0107303', 'E0107304', 'E0107305', 'E0107306'],
  hinterbliebenen_pauschbetrag: ['E0109704', 'E0109705'],
  kleinunternehmer_ust: ['E0300501'],
  pflege_pauschbetrag: ['E0702101'],
  spenden_10b: ['E0105502', 'E0107602', 'E0108004', 'E0108405', 'E0108701', 'E0108702'],
  tarif_32a: ['E0101201', 'E0104301', 'E0121101', 'E0200201', 'E0200203', 'E0200204', 'E0203410', 'E0203420', 'E0203706', 'E0203707', 'E0203708', 'E0204402', 'E0204403', 'E0204803', 'E0204901', 'E0205406', 'E0223410', 'E0223706'],
  vorsorgeaufwand: ['E0202204', 'E0202504', 'E0202604', 'E0202704', 'E2000401', 'E2000601', 'E2001203', 'E2001505', 'E2003001', 'E2003002', 'E2003104', 'E2003201', 'E2003202', 'E2004003', 'E2004103', 'E2004403'],
  werbungskosten_pauschbetraege: ['E0200201', 'E0200801'],
};

// ── seed-deterministischer RNG (LCG) ──
let _s = 42;
const rnd = (): number => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p: number): boolean => rnd() < p;
const eur = (n: number): string => {
  const c = Math.round(Math.abs(n) * 100); const e = Math.floor(c / 100); const r = c % 100;
  return `${n < 0 ? '-' : ''}${e},${String(r).padStart(2, '0')}`;
};
/** gewichtete Wahl. */
function weighted<T>(items: Array<[T, number]>): T {
  const tot = items.reduce((s, [, w]) => s + w, 0); let x = rnd() * tot;
  for (const [v, w] of items) { if ((x -= w) <= 0) return v; } return items[items.length - 1][0];
}

type Felder = Record<string, string>;
type Case = {
  id: string; archetype: string; erklaerungsjahr: number;
  veranlagungsart: 'einzeln' | 'zusammen'; elster_felder: Felder;
  expected_active_modules: string[];
};

/** Vorsorge-Block (KV/PV/RV/ALV) grob proportional zum Bruttolohn. */
function vorsorge(f: Felder, brutto: number, suffix = ''): void {
  f['E2000601' + suffix] = eur(Math.round(brutto * 0.093));  // RV AN
  f['E2001203' + suffix] = eur(Math.round(brutto * 0.073));  // KV AN
  f['E2001505' + suffix] = eur(Math.round(brutto * 0.020));  // PV AN
  f['E2004403' + suffix] = eur(Math.round(brutto * 0.013));  // ALV AN
}
function lohnPerson(f: Felder, suffix: string, brutto: number, stkl: number): void {
  f['E0200201' + suffix] = eur(brutto);
  f['E0200301' + suffix] = eur(Math.round(brutto * (brutto > 60000 ? 0.24 : brutto > 30000 ? 0.15 : 0.07)));
  f['E0200002' + suffix] = String(stkl);
  vorsorge(f, brutto, suffix);
}

// ── Archetypen (realistische Häufigkeit) ──
const ARCHES: Array<[string, number]> = [
  ['single_employee', 0.32], ['couple_dual', 0.20], ['couple_single_earner', 0.12],
  ['pensioner_single', 0.16], ['pensioner_couple', 0.06], ['landlord', 0.07],
  ['self_employed', 0.05], ['low_income', 0.02],
];

function buildCase(i: number): Case {
  const arch = weighted(ARCHES);
  const vz = chance(0.5) ? 2023 : 2024;
  const f: Felder = {};
  let art: 'einzeln' | 'zusammen' = 'einzeln';
  const konf = (s = '') => { if (chance(0.55)) f['E0100402' + (s === '__B' ? '' : s)] = weighted([['02', 5], ['03', 4], ['11', 3]]); };
  // ── Basis-Einkommen je Archetyp ──
  if (arch === 'single_employee') {
    lohnPerson(f, '', ri(22000, 85000), 1); konf();
  } else if (arch === 'couple_dual') {
    art = 'zusammen'; f['E0101201'] = 'X';
    lohnPerson(f, '', ri(28000, 80000), 4); lohnPerson(f, '__B', ri(18000, 65000), 4);
    if (chance(0.5)) f['E0100402'] = '02'; if (chance(0.5)) f['E0101002'] = '03';
  } else if (arch === 'couple_single_earner') {
    art = 'zusammen'; f['E0101201'] = 'X';
    lohnPerson(f, '', ri(35000, 95000), 3); if (chance(0.6)) f['E0100402'] = '02';
  } else if (arch === 'pensioner_single') {
    const rente = ri(12000, 32000);
    f['E2400103'] = eur(rente); f['E2400107'] = String(ri(2005, 2022));
    if (chance(0.3)) { const vb = ri(8000, 30000); f['E0200201'] = eur(vb); f['E0200801'] = eur(vb); }
    if (chance(0.5)) f['E2003104'] = eur(ri(1800, 4500)); konf();
  } else if (arch === 'pensioner_couple') {
    art = 'zusammen'; f['E0101201'] = 'X';
    f['E2400103'] = eur(ri(12000, 28000)); f['E2400107'] = String(ri(2005, 2020));
    f['E2400103__B'] = eur(ri(8000, 20000)); f['E2400107__B'] = String(ri(2006, 2021));
  } else if (arch === 'landlord') {
    lohnPerson(f, '', ri(30000, 90000), 1);
    f['E0405001'] = eur(ri(6000, 24000));   // Mieteinnahmen
    f['E0410101'] = eur(ri(1500, 6000));    // AfA Gebäude
    f['E0410201'] = eur(ri(500, 4000));     // Schuldzinsen/Werbungskosten
    konf();
  } else if (arch === 'self_employed') {
    f['E0300101'] = eur(ri(20000, 95000));  // Gewinn (Anlage S/G)
    f['E2003104'] = eur(ri(2400, 6000));    // private KV
    if (chance(0.4)) f['E0300501'] = eur(ri(8000, 21000)); // Kleinunternehmer-Umsatz
    konf();
  } else { // low_income
    lohnPerson(f, '', ri(8000, 12500), 1);
  }

  const employed = arch === 'single_employee' || arch === 'couple_dual' || arch === 'couple_single_earner' || arch === 'landlord' || arch === 'low_income';
  const couple = art === 'zusammen';

  // ── Abzüge / Erleichterungen (Prävalenz) ──
  if (employed && chance(0.40)) { f['E0203503'] = String(ri(5, 45)); f['E0203504'] = String(ri(200, 230)); } // Entfernung
  if (chance(0.30)) f['E0108701'] = eur(ri(50, 2500));                       // Spenden §10b
  if (chance(couple ? 0.45 : 0.18)) { f['E0508505'] = String(ri(1, 3)); f['E0505002'] = '01'; } // Kinder
  if (chance(0.28)) f['E0107305'] = eur(ri(200, 4500));                      // §35a haushaltsnah
  if (chance(0.09)) f['E0701001'] = eur(ri(600, 7000));                      // §33 a.g. Belastungen
  if (chance(0.07)) f['E0203507'] = String(weighted([['30', 3], ['50', 4], ['70', 2], ['100', 1]])); // GdB §33b
  if (chance(0.03)) f['E0107701'] = eur(ri(6000, 45000));                    // §35c energetisch
  if (employed && chance(0.06)) f['E0218101'] = eur(ri(150, 470));           // AN-Sparzulage
  if (couple && chance(0.05)) { f['E0507301'] = eur(ri(900, 1200)); }         // Ausbildungsfreibetrag

  // ── Kapitalerträge (sehr häufig) ──
  if (chance(0.45)) { f['E1900701'] = eur(ri(50, 9000)); f['E1901402'] = chance(0.5) ? '1000,00' : '801,00'; }
  if (couple && chance(0.25)) { f['E1900701__B'] = eur(ri(50, 4000)); f['E1901402__B'] = '801,00'; }

  // ── Altersentlastungsbetrag §24a: Geburtsdatum bei Rentnern + älteren AN ──
  const pensioner = arch.startsWith('pensioner');
  if (pensioner || (employed && chance(0.08))) {
    f['E0100401'] = `${ri(1, 28)}.${ri(1, 12)}.${ri(1945, pensioner ? 1958 : 1959)}`;
    if (couple) f['E0101001'] = `${ri(1, 28)}.${ri(1, 12)}.${ri(1947, 1960)}`;
  }

  // ── seltene Einkünfte/Erleichterungen (niedrige Prävalenz, Audit-Coverage) ──
  if (chance(0.02)) f['E0702101'] = weighted([['1', 3], ['2', 2], ['3', 1]]);  // Pflege-Pauschbetrag §33b(6)
  if (chance(0.015)) f['E0109704'] = '1';                                       // Hinterbliebenen-Pauschbetrag
  if (chance(0.025)) f['E0107601'] = eur(ri(3000, 11000));                      // Unterhalt (Anlage Unterhalt)
  if (chance(0.02)) f['E0900101'] = eur(ri(500, 6000));                         // sonstige Einkünfte (Anlage SO)
  if (chance(0.015)) f['E1100301'] = eur(ri(2000, 25000));                      // ausländische Einkünfte (Anlage AUS)
  if (chance(0.01)) f['E0600101'] = eur(ri(3000, 20000));                       // Land- & Forstwirtschaft (Anlage L)

  // ── erwartete aktive Module (Trigger ∩ vorhandene Codes) ──
  const present = new Set(Object.keys(f).map((k) => k.replace(/__B$/, '')));
  const expected = Object.entries(TRIGGER)
    .filter(([, codes]) => codes.some((c) => present.has(c)))
    .map(([m]) => m).sort();

  return { id: `case_${String(i).padStart(4, '0')}`, archetype: arch, erklaerungsjahr: vz, veranlagungsart: art, elster_felder: f, expected_active_modules: expected };
}

// ── main ──
const args = process.argv.slice(2);
const argN = Number((args.find((a) => a.startsWith('--n')) ?? '').replace(/\D/g, '')) || 1000;
const seedArg = Number((args.find((a) => a.startsWith('--seed')) ?? '').replace(/\D/g, ''));
if (seedArg) _s = seedArg;
const out = args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp/audit-cases.json';

const cases: Case[] = [];
for (let i = 1; i <= argN; i++) cases.push(buildCase(i));
writeFileSync(out, JSON.stringify(cases, null, 0));

// ── Statistik ──
const byArch: Record<string, number> = {}; const byMod: Record<string, number> = {}; let zus = 0;
for (const c of cases) {
  byArch[c.archetype] = (byArch[c.archetype] ?? 0) + 1;
  if (c.veranlagungsart === 'zusammen') zus++;
  for (const m of c.expected_active_modules) byMod[m] = (byMod[m] ?? 0) + 1;
}
const modulesHit = Object.keys(byMod).length, modulesTotal = Object.keys(TRIGGER).length;
console.log(`\n${cases.length} Fälle → ${out}  (seed ${seedArg || 42})`);
console.log(`Veranlagung: ${cases.length - zus} einzeln / ${zus} zusammen`);
console.log('\nArchetyp-Verteilung:');
for (const [a, n] of Object.entries(byArch).sort((x, y) => y[1] - x[1])) console.log(`  ${a.padEnd(24)} ${n} (${(n / cases.length * 100).toFixed(0)}%)`);
console.log(`\nModul-Coverage: ${modulesHit}/${modulesTotal} Module getriggert`);
for (const [m, n] of Object.entries(byMod).sort((x, y) => y[1] - x[1])) console.log(`  ${m.padEnd(28)} ${n} Fälle (${(n / cases.length * 100).toFixed(0)}%)`);
const missing = Object.keys(TRIGGER).filter((m) => !byMod[m]);
if (missing.length) console.log(`\n⚠ nie getriggert: ${missing.join(', ')}`);
