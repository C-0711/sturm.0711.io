/**
 * audit — Vorjahres-Kontext → Befunde (deterministisch, DB-/LLM-frei).
 * Beweist: fremdjährige Felder werden zu Prefill-/Rückfrage-Findings, ohne
 * doppelt zu fragen (Soll-Liste + bereits vorhandene eCodes übersprungen).
 *
 * Ausführen:  npx tsx web/audit.test.ts
 */
import { auditCase, type CaseData } from './audit.ts';
import { SOLL_ECODES } from './soll-katalog.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

// E0100081 (Steuer-ID A) ist NICHT in der Soll-Liste → generischer Vorjahres-Pfad.
assert('Vorbedingung: E0100081 nicht in SOLL_ECODES', !SOLL_ECODES.has('E0100081'));

const data: CaseData = {
  fields: [{ eCode: 'E0200201', wert: '60000', person: 'A', anlage: 'N' }], // aktuell: Bruttoarbeitslohn vorhanden
  belege: [{ belegTyp: 'Einkommensteuererklaerung', person: 'A', status: 'mapped', felder: 3, method: 'ocr', vorjahr: true, dokumentJahr: 2023 }],
  warnings: [],
  calcs: [{ person: 'A+B' }],
  veranlagungsart: 'einzeln',
  vorjahr: {
    jahr: 2023,
    felder: [
      { eCode: 'E0100081', person: 'A', wert: '12 345 678 901', pdfLabel: 'Steuer-Identifikationsnummer', dokumentJahr: 2023, kind: 'prefill', vorhandenAktuell: false },
      { eCode: 'E0200201', person: 'A', wert: '50000', pdfLabel: 'Bruttoarbeitslohn', dokumentJahr: 2023, kind: 'vorhanden', vorhandenAktuell: true },
      { eCode: 'E1400101', person: 'A', wert: '1200', pdfLabel: 'Spenden', dokumentJahr: 2023, kind: 'frage', vorhandenAktuell: false },
    ],
  },
};

const rep = auditCase(data);

console.log('\n1. Stabiles Stammdatum (Steuer-ID), aktuell fehlend → Prefill (confirm_value)\n');
{
  const f = rep.findings.find((x) => x.basis.ref === 'vorjahr:E0100081');
  assert('confirm_value-Finding für E0100081', f?.kind === 'confirm_value', f);
  assert('Frage nennt den Vorjahreswert', !!f && /12 345 678 901/.test(f.frage ?? ''), f?.frage);
  assert('erwartet boolean + eCode', f?.erwartet.typ === 'boolean' && f?.erwartet.eCode === 'E0100081', f?.erwartet);
}

console.log('\n2. Betrag (Spenden), aktuell fehlend → Rückfrage (open_question), Wert NICHT übernommen\n');
{
  const f = rep.findings.find((x) => x.basis.ref === 'vorjahr-betrag:E1400101');
  assert('open_question-Finding für E1400101', f?.kind === 'open_question', f);
  assert('severity optional (kein Blocker)', f?.severity === 'optional', f);
}

console.log('\n3. Kein Doppel-Befund: im aktuellen Jahr bereits vorhandenes Feld wird übersprungen\n');
{
  const leak = rep.findings.filter((x) => x.basis.ref.includes('E0200201'));
  assert('kein Vorjahres-Finding für E0200201 (vorhanden)', leak.length === 0, leak);
}

console.log('\n4. Kein Blocker aus dem Vorjahres-Kontext\n');
{
  const vjFindings = rep.findings.filter((x) => x.basis.ref.startsWith('vorjahr'));
  assert('≥2 Vorjahres-Findings erzeugt', vjFindings.length >= 2, vjFindings.map((f) => f.basis.ref));
  assert('keiner davon ist blocker', vjFindings.every((f) => f.severity !== 'blocker'), vjFindings.map((f) => f.severity));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
