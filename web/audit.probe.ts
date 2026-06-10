/**
 * audit.probe — verifiziert auditCase() (deterministisch, lokal) und optional
 * das Auditor-Phrasing gegen das lokale Gemma (nur mit PHRASE=1, on H200V).
 *
 *   npx tsx web/audit.probe.ts            # nur deterministisch
 *   PHRASE=1 npx tsx web/audit.probe.ts   # + Gemma-Phrasing (braucht :11434)
 */
import { auditCase, type CaseData } from './audit.ts';
import { phraseFindings, auditorConfig } from './auditor.ts';

const fixture: CaseData = {
  veranlagungsart: 'zusammen',
  warnings: ['Solidaritätszuschlag: Freigrenze 2024 prüfen — möglicher Grenzfall.'],
  calcs: [{ person: 'Haushalt', konflikte: 0 }],
  fields: [
    { eCode: 'E1900701', label: 'Höhe der Kapitalerträge', wert: '36', person: 'A', anlage: 'KAP', method: 'ocr', prov: {} },
    { eCode: 'E1904701', label: 'Kapitalertragsteuer', wert: '8,80', person: 'A', anlage: 'KAP', method: 'ocr', prov: {} },
    { eCode: 'E1901402', label: 'Sparer-Pauschbetrag', wert: '0', person: 'A', anlage: 'KAP', method: 'ocr' },
    { eCode: 'E1900701', label: 'Höhe der Kapitalerträge', wert: '50', person: 'B', anlage: 'KAP', method: 'ocr', prov: {} },
  ],
  belege: [
    {
      source: '/up/whatsapp_a.jpg', belegTyp: 'Steuerbescheinigung_Bank', person: 'A', status: 'mapped', felder: 5, method: 'ocr',
      felderListe: [
        { eCode: 'E1900701', wert: '36', prov: {} },
        { eCode: 'E1904701', wert: '8,80', prov: {} },
        { eCode: 'E1904901', label: 'Solidaritätszuschlag', wert: '0,48' },
      ],
    },
    { source: '/up/whatsapp_b_blur.jpg', belegTyp: 'Steuerbescheinigung_Bank', person: 'B', status: 'deferred-ocr', felder: 0, method: 'ocr', felderListe: [] },
  ],
  household: { personA: { vorname: 'Rainer', nachname: 'Stricker' }, personB: { idnr: '54129386608' } },
};

const rep = auditCase(fixture);
console.log('=== auditCase (deterministisch) ===');
console.log('score:', JSON.stringify(rep.score));
for (const f of rep.findings)
  console.log(`  [${f.severity}] ${f.kind} · ${f.basis.quelle}:${f.basis.ref}  erwartet=${f.erwartet.typ}\n      ${f.fakt.slice(0, 130)}…`);

if (process.env.PHRASE === '1') {
  console.log(`\n=== Auditor-Phrasing via ${JSON.stringify(auditorConfig())} ===`);
  const phrased = await phraseFindings(rep.findings);
  for (const f of phrased) console.log(`  [${f.severity}] ${f.frage}\n      → ${f.begruendung}`);
}
