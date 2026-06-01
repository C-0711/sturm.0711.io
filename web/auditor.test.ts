/**
 * auditor — Default-Pfad ist DETERMINISTISCH und NETZFREI (kein LLM, keine RAG).
 * Beweis: jeder fetch wirft; phraseFindings/interpretAnswer müssen trotzdem
 * vollständige Ergebnisse liefern.
 *
 * Ausführen:  npx tsx web/auditor.test.ts
 */
// WICHTIG: vor dem Import setzen — jeder Netzaufruf ist ein Testfehler.
(globalThis as unknown as { fetch: unknown }).fetch = async () => {
  throw new Error('NETZAUFRUF — der Auditor muss im Default deterministisch (LLM-frei) sein');
};

import { phraseFindings, interpretAnswer, auditorConfig } from './auditor.ts';
import type { AuditFinding } from './audit.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
const mk = (over: Partial<AuditFinding>): AuditFinding => ({
  id: 'x', kind: 'open_question', severity: 'empfohlen',
  fakt: 'Verifizierter Befund (Regel): Testsachverhalt.',
  basis: { quelle: 'rule', ref: 'r' }, erwartet: { typ: 'text' }, state: 'offen', ...over,
});

console.log('\n0. Default: LLM-Polish AUS\n');
assert('auditorConfig.llmPolish === false', auditorConfig().llmPolish === false, auditorConfig());

console.log('\n1. phraseFindings — deterministisch, netzfrei, kuratierte Frage bleibt\n');
{
  const findings = [
    mk({ kind: 'confirm_value', erwartet: { typ: 'boolean', eCode: 'E1900701' }, fakt: 'Verifizierter Befund (Provenienz): Wert E1900701 = 319 nicht lokalisiert.' }),
    mk({ kind: 'missing_beleg', erwartet: { typ: 'upload', belegTyp: 'VaSt_LStB' } }),
    mk({ kind: 'confirm_value', frage: 'Pendlerpauschale übernehmen? Vorjahreswert: 17.', erwartet: { typ: 'boolean' } }),
  ];
  const r = await phraseFindings(findings);
  assert('jede Frage gesetzt (>5 Zeichen)', r.every((f) => !!f.frage && f.frage.length > 5), r.map((f) => f.frage));
  assert('jede Begründung gesetzt', r.every((f) => !!f.begruendung), r.map((f) => f.begruendung));
  assert('kuratierte Frage 1:1 erhalten', r[2].frage === 'Pendlerpauschale übernehmen? Vorjahreswert: 17.', r[2].frage);
  assert('missing_beleg nennt den Belegtyp', /VaSt_LStB/.test(r[1].frage ?? ''), r[1].frage);
  assert('Begründung = Sachverhalt ohne Präfix', r[0].begruendung === 'Wert E1900701 = 319 nicht lokalisiert.', r[0].begruendung);
}

console.log('\n2. interpretAnswer — deterministisch (ja/nein/Wert), netzfrei\n');
{
  assert('„Ja, stimmt" → erledigt', (await interpretAnswer(mk({ erwartet: { typ: 'boolean' } }), 'Ja, stimmt')).status === 'erledigt');
  assert('„nein" → offen', (await interpretAnswer(mk({ erwartet: { typ: 'boolean' } }), 'nein')).status === 'offen');
  const v = await interpretAnswer(mk({ kind: 'open_question', erwartet: { typ: 'value', eCode: 'E1' } }), 'Das waren 1.234 Euro');
  assert('Wert extrahiert (1.234)', v.status === 'erledigt' && /1\.234/.test(v.wert ?? ''), v);
  assert('leere Antwort → offen', (await interpretAnswer(mk({}), '')).status === 'offen');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
