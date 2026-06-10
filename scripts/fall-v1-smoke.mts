#!/usr/bin/env -S npx tsx
/**
 * scripts/fall-v1-smoke — Proof: lokale Mastercase-Formen → v1-Vertrag.
 *
 *  1) Evidenz-Pfad: echte extract-Samples (var/extract-samples) → harmonize()
 *     → envelopeZuV1 → var/fall-v1/{fall,mastercase}.json
 *  2) Jahres-Form-Pfad: synthetischer Mini-Fall → jahresFormZuV1
 *  3) Vertrags-Invarianten (R3/R4/R5) hart asserten; exit 1 bei Verstoß.
 *
 * Schema-Validierung danach (CI/manuell):
 *   npx --yes ajv-cli@5 validate --spec=draft2020 --strict=false \
 *     -s src/schemas/v1/fall.schema.json -r "src/schemas/v1/{profil,person,jahresblock,jahresperson,beleg,position,vergleichzeile,rechenergebnis}.schema.json" \
 *     -d var/fall-v1/fall.json
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harmonize, SAMPLE_DIR, SAMPLE_FILES, STRICKER } from '../web/mastercase-harmonize.ts';
import type { ExtractOutput } from '../web/extract-client.ts';
import { envelopeZuV1, jahresFormZuV1, E_CODE_RE, type Jahresblock } from '../src/schemas/v1/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'var', 'fall-v1');

let fehler = 0;
const ok = (cond: boolean, was: string): void => { console.log(`${cond ? '✓' : '✗'} ${was}`); if (!cond) fehler++; };

const ENGINE_KEY_RE = /^(E\d{7}(__B)?|bundesland)$/;
function pruefeJahresblock(b: Jahresblock, wo: string): void {
  for (const p of b.personen)
    ok(Object.keys(p.elsterWerte).every((k) => E_CODE_RE.test(k)), `${wo}: ${p.person_key} elsterWerte nur ^E\\d{7}$ (R3)`);
  const keys = Object.keys(b.engineInput.elsterWerte);
  ok(keys.every((k) => ENGINE_KEY_RE.test(k)), `${wo}: engineInput-Keys nur eCode/__B/bundesland`);
  ok(typeof b.engineInput.elsterWerte['bundesland'] === 'string', `${wo}: bundesland im engineInput (R4)`);
  const bPerson = b.personen.find((p) => p.rolle === 'B');
  ok(keys.filter((k) => k.endsWith('__B')).length === Object.keys(bPerson?.elsterWerte ?? {}).length,
    `${wo}: __B-Keys == Person-B-Werte (R3)`);
}

// ── 1) Evidenz-Pfad mit echten Samples ───────────────────────────────────
const files = SAMPLE_FILES.map((n) => join(SAMPLE_DIR, `${n}.json`)).filter((f) => existsSync(f));
if (!files.length) {
  console.error(`⚠ keine Samples in ${SAMPLE_DIR} — Evidenz-Pfad übersprungen`);
} else {
  const outputs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as ExtractOutput);
  const mc = harmonize(outputs, STRICKER);
  const v1 = envelopeZuV1({ fallId: 'smoke-evidenz', vz: 2024, mastercase: mc, household: STRICKER, veranlagungsart: 'zusammen' });
  ok(v1.fall.schema === 'fall/v1', 'evidenz: schema-Tag fall/v1 (R5)');
  ok(v1.mastercase.schema === 'mastercase/v1', 'evidenz: schema-Tag mastercase/v1 (R5)');
  pruefeJahresblock(v1.fall.jahre['2024'], 'evidenz');
  const zahlen = Object.values(v1.fall.jahre['2024'].engineInput.elsterWerte).filter((v) => typeof v === 'number').length;
  ok(zahlen > 0, `evidenz: Wert-Typisierung aktiv (${zahlen} number-Werte)`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'fall.json'), JSON.stringify(v1.fall, null, 2));
  writeFileSync(join(OUT_DIR, 'mastercase.json'), JSON.stringify(v1.mastercase, null, 2));
  console.log(`  → ${v1.fall.jahre['2024'].personen.map((p) => `${p.rolle}: ${Object.keys(p.elsterWerte).length} Werte`).join(' · ')} · ${v1.uebersprungen.length} übersprungen (${[...new Set(v1.uebersprungen.map((u) => u.grund))].join(', ') || '—'})`);
  console.log('  → geschrieben: var/fall-v1/{fall,mastercase}.json');
}

// ── 2) Jahres-Form-Pfad (synthetisch — keine echten Case-Daten) ─────────
const jf = jahresFormZuV1({
  label: 'smoke-jahresform', vz: 2024, veranlagungsart: 'zusammen',
  entitaeten: [
    { person: 'A', idnr: '01234567890', name: 'Max Mustermann', anlagen: ['N'] },
    { person: 'B', idnr: '09876543210', name: 'Erika Mustermann', anlagen: ['KAP'] },
  ],
  fakten: [
    { person: 'A', wert: '50.000,00', eCodeParse: 'E0200201', eCodeMap: 'E0200201' },
    { person: 'A', wert: '7.000', eCodeParse: 'E0200301', eCodeMap: null },
    { person: 'B', wert: '380,50', eCodeParse: 'E1904701', eCodeMap: 'E1904701' },
    { person: 'B', wert: 'kein-code', eCodeParse: 'X123', eCodeMap: null },
  ],
  ergebnis: { erstattung: -1234.5, zve: 48734, gesamtsteuer: 10510.83 },
});
ok(jf.fall.schema === 'fall/v1' && jf.mastercase.schema === 'mastercase/v1', 'jahresform: schema-Tags (R5)');
pruefeJahresblock(jf.fall.jahre['2024'], 'jahresform');
const ji = jf.fall.jahre['2024'].engineInput.elsterWerte;
ok(ji['E0200201'] === 50000, 'jahresform: "50.000,00" → 50000 (number)');
ok(ji['E0200301'] === 7000, 'jahresform: eCodeMap=null → Ingestion-eCode-Fallback ("7.000" → 7000)');
ok(ji['E1904701__B'] === 380.5, 'jahresform: B-Wert mit __B-Suffix → 380.5');
ok(jf.uebersprungen.length === 1 && jf.uebersprungen[0].grund === 'kein-7-stelliger-ecode', 'jahresform: unmappbarer Fakt in uebersprungen (kein drop)');
ok(jf.fall.rechen_ergebnis?.['2024']?.endwerte.nachzahlung === 1234.5, 'jahresform: erstattung<0 → nachzahlung');
ok(jf.fall.rechen_ergebnis?.['2024']?.endwerte.zve === 48734, 'jahresform: zve übernommen');

console.log(fehler ? `\n✗ ${fehler} Vertrags-Verstöße` : '\n✓ alle Vertrags-Invarianten erfüllt');
process.exit(fehler ? 1 : 0);
