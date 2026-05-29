/**
 * steuerfall-demo — End-to-End-Vorschau: gemappte E-Codes (runLane1 --json)
 * → Adapter → Rechenkern → Steuerbescheid, je Steuerpflichtigem getrennt.
 *
 * Demonstriert den I/O-freien Kalkulationsteil der Pipeline auf ECHTEN
 * Feldern. Da das Testkorpus Belege MEHRERER Personen mischt, wird pro
 * Person ein eigener (Einzelveranlagungs-)Fall gerechnet — eine Summen-
 * Erklärung über gemischte Steuerpflichtige wäre bedeutungslos.
 *
 *   npx tsx src/workflows/elster/lib/steuer/steuerfall-demo.ts <fields.json> [vz]
 */
import { readFileSync } from 'node:fs';
import { bausteineAusFelder, type SteuerFeld } from './adapter.ts';
import { berechneSteuerfall } from './engine.ts';

const path = process.argv[2];
const vz = Number(process.argv[3] ?? 2023);
if (!path) { console.error('Usage: steuerfall-demo <fields.json> [vz]'); process.exit(2); }

const raw = JSON.parse(readFileSync(path, 'utf8'));
const all: SteuerFeld[] = (raw.fields ?? []).map((f: Record<string, unknown>) => ({
  eCode: String(f.eCode ?? ''),
  wert: String(f.wert ?? ''),
  person: (f.person === 'B' ? 'B' : 'A') as 'A' | 'B',
  anlage: f.anlage as string | undefined,
  pdfLabel: f.pdfLabel as string | undefined,
}));

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

for (const person of ['A', 'B'] as const) {
  // Eine Person isolieren und als alleinigen Steuerpflichtigen behandeln.
  const pf = all.filter((f) => f.person === person).map((f) => ({ ...f, person: 'A' as const }));
  if (pf.length === 0) continue;

  const t0 = process.hrtime.bigint();
  const { eingabe, anrechnung, notes } = bausteineAusFelder(pf, { vz, art: 'einzeln', kirchensteuerHebesatz: 0.09 });
  const b = berechneSteuerfall({ ...eingabe, anrechnung, kirchensteuerHebesatz: 0.09 });
  const t1 = process.hrtime.bigint();

  console.log(`\n══════ Steuerpflichtige/r „Person ${person}" — VZ ${vz} (Einzelveranlagung) ══════`);
  console.log(`  Felder: ${pf.length}   ·   Adapter+Rechenkern: ${(Number(t1 - t0) / 1e6).toFixed(3)} ms`);
  for (const note of notes) console.log(`  ⚠ ${note}`);
  console.log('  ── Bemessungsgrundlage ──');
  for (const t of b.einkommen.trace) console.log(`    ${t.schritt.padEnd(38)} ${eur(t.betrag).padStart(16)}`);
  console.log('  ── Festsetzung ──');
  console.log(`    Einkommensteuer (§32a)                 ${eur(b.steuer.einkommensteuer).padStart(16)}`);
  console.log(`    Solidaritätszuschlag                   ${eur(b.steuer.solidaritaetszuschlag).padStart(16)}`);
  console.log(`    Kirchensteuer (9%)                     ${eur(b.steuer.kirchensteuer).padStart(16)}`);
  console.log(`    festgesetzte Gesamtsteuer              ${eur(b.festgesetzt).padStart(16)}`);
  console.log('  ── Anrechnung (einbehalten) ──');
  console.log(`    Lohnsteuer                             ${eur(b.anrechnung.lohnsteuer).padStart(16)}`);
  console.log(`    Soli + KiSt + KapESt                   ${eur(b.anrechnung.solidaritaetszuschlag + b.anrechnung.kirchensteuer + b.anrechnung.kapitalertragsteuer).padStart(16)}`);
  console.log(`    angerechnet gesamt                     ${eur(b.angerechnet).padStart(16)}`);
  const saldo = b.erstattung >= 0 ? `ERSTATTUNG ${eur(b.erstattung)}` : `NACHZAHLUNG ${eur(-b.erstattung)}`;
  console.log(`  ▶ ${saldo}   (Grenzsteuersatz ${(b.steuer.grenzsteuersatz * 100).toFixed(0)}%, Ø ${(b.steuer.durchschnittssteuersatz * 100).toFixed(1)}%)`);
}
console.log('\n(Vorschau auf gemischtem Multi-Steuerpflichtigen-Korpus — Beträge illustrativ, nicht bindend.)');
