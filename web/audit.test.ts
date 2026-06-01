/**
 * audit — Vorjahres-Kontext verhält sich richtig (deterministisch, DB-/LLM-frei):
 *   • eine Vorjahres-Erklärung mit vielen Feldern erzeugt KEINE Flut von
 *     Auditor-Befunden (kein Befund pro Feld) — sonst hängt die LLM-Prüfung;
 *   • die kuratierte Soll-Liste übernimmt wiederkehrende Angaben (Pendler-
 *     pauschale, Stammdaten) MIT dem echten Vorjahreswert als Übernahme-Frage.
 *
 * Ausführen:  npx tsx web/audit.test.ts
 */
import { auditCase, type CaseData } from './audit.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

console.log('\n1. FLOOD-GUARD: viele Vorjahres-Felder → KEINE Befundflut (kein Befund pro Feld)\n');
{
  const viele: CaseData = {
    fields: [{ eCode: 'E0200201', wert: '69292', person: 'A', anlage: 'N' }],
    belege: [{ belegTyp: 'Einkommensteuererklaerung', person: 'A', status: 'mapped', felder: 30, method: 'ocr', vorjahr: true, dokumentJahr: 2023 }],
    warnings: [], calcs: [{ person: 'A+B' }], veranlagungsart: 'einzeln',
    vorjahr: {
      jahr: 2023,
      felder: Array.from({ length: 30 }, (_, i) => ({
        eCode: `E07${String(i).padStart(5, '0')}`, person: 'A' as const, wert: String(100 + i),
        pdfLabel: `Vorjahr-Feld ${i}`, dokumentJahr: 2023, kind: 'prefill' as const, vorhandenAktuell: false,
      })),
    },
  };
  const r = auditCase(viele);
  const vjPerField = r.findings.filter((x) => /^vorjahr(-betrag)?:/.test(x.basis.ref));
  assert('KEINE per-Feld-Vorjahres-Befunde (war der Flood-Bug)', vjPerField.length === 0, vjPerField.map((f) => f.basis.ref));
  assert('Gesamt-Befunde bleiben klein (≤ 5), nicht ~30', r.findings.length <= 5, r.findings.length);
  assert('die Vorjahres-Erklärung selbst löst keinen Provenienz-Befund aus (vorjahr-Beleg übersprungen)',
    !r.findings.some((f) => f.basis.quelle === 'provenance'), r.findings.filter((f) => f.basis.quelle === 'provenance').length);
}

console.log('\n2. Kuratierte Übernahme: Pendlerpauschale fehlt 2024, liegt aber im Vorjahr → Frage MIT Wert\n');
{
  const fall: CaseData = {
    // Anlage-N-Feld ⇒ Profil „Arbeitnehmer" ⇒ Soll-Item „pendler" wird erwartet.
    fields: [{ eCode: 'E0200201', wert: '69292', person: 'A', anlage: 'N' }],
    belege: [], warnings: [], calcs: [{ person: 'A+B' }], veranlagungsart: 'einzeln',
    vorjahr: {
      jahr: 2023,
      felder: [
        { eCode: 'E0203504', person: 'A', wert: '17', pdfLabel: 'einfache Entfernung in km', dokumentJahr: 2023, kind: 'prefill', vorhandenAktuell: false },
      ],
    },
  };
  const r = auditCase(fall);
  const pendler = r.findings.find((x) => x.basis.ref === 'soll:pendler');
  assert('Soll-Befund „pendler" vorhanden', !!pendler, r.findings.map((f) => f.basis.ref));
  assert('Frage nennt den echten Vorjahreswert (17)', !!pendler && /17/.test(pendler.frage ?? ''), pendler?.frage);
  assert('als confirm_value (Übernahme bestätigen)', pendler?.kind === 'confirm_value', pendler?.kind);
}

console.log('\n3. Ohne Vorjahres-Daten bleibt das Audit unverändert lauffähig\n');
{
  const r = auditCase({ fields: [{ eCode: 'E0200201', wert: '69292', person: 'A', anlage: 'N' }], belege: [], warnings: [], calcs: [{ person: 'A+B' }], veranlagungsart: 'einzeln' });
  assert('auditCase liefert einen Report', Array.isArray(r.findings) && typeof r.score.total === 'number', r.score);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
