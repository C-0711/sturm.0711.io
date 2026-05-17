/**
 * Tests for elster-v5/phase1-regex — speziell für den vordruckzeile-Anker
 * der die "WISO-456-Platzhalter"-False-Positives blockt.
 *
 * Reproduziert den Stricker-Bug: page-5 "48 Bezeichnung 456" matched über
 * REGEX_3F jeden Bezeichnung-eCode jeder Anlage (≠ vordruckzeile=48) →
 * 17 false positives → pv_beitraege=456 statt 1243 → fake Nachzahlung.
 *
 * Run: tsx src/verticals/elster-v3/stages/phase1-regex.test.ts
 */
import { phase1RegexStage, leadingLabelNumber } from './phase1-regex.ts';
import type { Phase1RegexConfig } from './phase1-regex.ts';
import type { AnlagenFeld, AnlagenFelderListe } from '../../../lib/elster-catalog.ts';
import type {
  ArtifactStore,
  StageContext,
  StageLogger,
  StageResult,
  StageId,
} from '../../../core/types.ts';
import { NullToolContainer } from '../../../core/tools/null-container.ts';

let pass = 0, fail = 0;
function assert(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function memCtx<TC>(config: TC): StageContext<TC> {
  const writes: Record<string, unknown> = {};
  const store: ArtifactStore = {
    write: async (p, d) => { writes[p] = d; },
    writeBuffer: async (p, b) => { writes[p] = b; },
    read: async (p) => writes[p] as never,
    readBuffer: async (p) => writes[p] as Buffer,
    exists: async (p) => p in writes,
    absolutePath: (p) => p,
  };
  const logger: StageLogger = { debug() {}, info() {}, warn() {}, error() {} };
  return {
    runId: 'r', workflowId: 'w', stageId: 's',
    config, logger, artifacts: store,
    emit: () => {}, signal: new AbortController().signal,
    results: {} as Readonly<Record<StageId, StageResult>>,
    tools: new NullToolContainer(),
  };
}

function feld(partial: Partial<AnlagenFeld> & Pick<AnlagenFeld, 'eCode' | 'drucktext' | 'vordruckzeile'>): AnlagenFeld {
  return {
    bezeichnung: partial.drucktext,
    datentyp: 'currency',
    formatRegex: '^(?=.{1,12}$)(?!0\\d)\\d{1,12}$',
    pflicht: true,
    einkunftsart: null,
    ...partial,
  } as AnlagenFeld;
}

function perAnlage(anlage: string, felder: AnlagenFeld[]): Record<string, AnlagenFelderListe> {
  return { [anlage]: { anlage: anlage as never, felder } };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Helper-Test: leadingLabelNumber
// ───────────────────────────────────────────────────────────────────────────

console.log('\n[leadingLabelNumber]');
eq('plain "13 Arbeitnehmer …"', leadingLabelNumber('13 Arbeitnehmerbeiträge zu …'), '13');
eq('whitespace prefix', leadingLabelNumber('  48 Bezeichnung 456'), '48');
eq('dot-suffix "13."', leadingLabelNumber('13. Arbeitnehmer'), '13');
eq('table cell "| 5 | …"', leadingLabelNumber('| 5 | Lohnsteuer | 1.234 |'), '5');
eq('no leading number', leadingLabelNumber('Arbeitnehmer 1.243'), null);
eq('empty', leadingLabelNumber(''), null);
eq('multi-digit-then-text', leadingLabelNumber('123x ohne whitespace'), null);

// ───────────────────────────────────────────────────────────────────────────
// 2. Stricker bug: WISO "48 Bezeichnung 456" darf NICHT auf E2001505
//    (Pflegeversicherung, vordruckzeile=13) matchen, wenn die echte Zeile
//    "13 Arbeitnehmerbeiträge … 1.243" auch vorhanden ist.
// ───────────────────────────────────────────────────────────────────────────

async function runStage(text: string, anlage: string, felder: AnlagenFeld[], cfg: Phase1RegexConfig = {}) {
  const ctx = memCtx(cfg);
  return await phase1RegexStage.run(
    { text, per_anlage: perAnlage(anlage, felder) },
    ctx,
  );
}

console.log('\n[Stricker WISO-Platzhalter: E2001505 picks real line]');
{
  const ocrText = [
    '13 Arbeitnehmerbeiträge zu sozialen Pflegeversicherungen laut Nr. 26 der Lohnsteuerbescheinigung 1.243',
    '',
    '## Einzelangaben',
    '',
    '48 Bezeichnung 456',
    '48 Betrag 456',
  ].join('\n');

  const e2001505 = feld({
    eCode: 'E2001505',
    drucktext: 'Arbeitnehmerbeiträge zu sozialen Pflegeversicherungen',
    vordruckzeile: '13',
    datentyp: 'currency',
  });

  const out = await runStage(ocrText, 'VOR', [e2001505]);
  const hit = out.per_anlage.VOR.regex_hits['E2001505'];
  assert('E2001505 hit exists', !!hit, out);
  eq('  value picks the 1.243 line (NOT 456)', hit?.value, '1.243');
  eq('  origin REGEX_100% (anchored 4-Faktor)', hit?.origin, 'REGEX_100%');
  eq('  zeile_anchored=true', hit?.zeile_anchored, true);
  assert('  evidence_line contains Pflegeversicherungen',
    !!hit?.evidence_line.includes('Pflegeversicherungen'), hit?.evidence_line);
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Negativfall: ein Bezeichnung-eCode (vordruckzeile=48) auf dem gleichen
//    Text matched die 456 — aber das ist ein erwarteter Treffer. Wir prüfen
//    nur, dass zeile_anchored korrekt gesetzt wird.
// ───────────────────────────────────────────────────────────────────────────

console.log('\n[Bezeichnung-eCode mit vordruckzeile=48 matched korrekt]');
{
  const ocrText = '48 Bezeichnung 456\n48 Betrag 456';
  const bezeichnung48 = feld({
    eCode: 'E_TEST_48',
    drucktext: 'Bezeichnung',
    vordruckzeile: '48',
    datentyp: 'currency',
  });
  const out = await runStage(ocrText, 'VOR', [bezeichnung48], { minDrucktextLength: 5, minDrucktextLength3F: 5 });
  const hit = out.per_anlage.VOR.regex_hits['E_TEST_48'];
  assert('hit exists', !!hit, out);
  eq('  value = 456', hit?.value, '456');
  eq('  zeile_anchored=true (führendes Token = "48")', hit?.zeile_anchored, true);
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Negativfall: Bezeichnung-eCode mit vordruckzeile=23 (NICHT 48) auf
//    "48 Bezeichnung 456" → wenn 3-Faktor angesprungen wird, zeile_anchored=false.
// ───────────────────────────────────────────────────────────────────────────

console.log('\n[Bezeichnung-eCode vordruckzeile=23 auf "48 Bezeichnung 456"]');
{
  // Wir konstruieren einen Text ohne Zeile "23 Bezeichnung …", damit Pass A
  // fehlschlägt und Pass B (3F) anspringt.
  const ocrText = '48 Bezeichnung 456\n48 Betrag 456';
  const bezeichnung23 = feld({
    eCode: 'E_TEST_23',
    drucktext: 'Bezeichnung',
    vordruckzeile: '23',
    datentyp: 'currency',
  });
  const out = await runStage(ocrText, 'KIND', [bezeichnung23], {
    minDrucktextLength: 5,
    minDrucktextLength3F: 5,
    threeFaktorFallback: true,
  });
  const hit = out.per_anlage.KIND.regex_hits['E_TEST_23'];
  if (hit) {
    eq('  origin REGEX_3F (Fallback)', hit.origin, 'REGEX_3F');
    eq('  zeile_anchored=false (führende "48" ≠ vordruckzeile "23")',
      hit.zeile_anchored, false);
  } else {
    // 3-Faktor wird nicht gezündet wenn drucktext < minLen3F. Wir haben die
    // Schranke auf 5 gesetzt, "Bezeichnung" hat 11 → sollte zünden.
    assert('  hit exists for 3F fallback', false, { regex_hits: out.per_anlage.KIND.regex_hits });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Cross-Anlage repeat detection: gleicher (value, drucktext) in ≥3
//    eCodes über ≥2 Anlagen → repeat_suspicious=true.
// ───────────────────────────────────────────────────────────────────────────

console.log('\n[Cross-Anlage repeat-Pattern: 456/Bezeichnung über mehrere Anlagen]');
{
  const ocrText = '48 Bezeichnung 456';
  const e1 = feld({ eCode: 'E_BEZ_A', drucktext: 'Bezeichnung', vordruckzeile: '48' });
  const e2 = feld({ eCode: 'E_BEZ_B', drucktext: 'Bezeichnung', vordruckzeile: '48' });
  const e3 = feld({ eCode: 'E_BEZ_C', drucktext: 'Bezeichnung', vordruckzeile: '48' });
  const ctx = memCtx<Phase1RegexConfig>({
    minDrucktextLength: 5,
    minDrucktextLength3F: 5,
    repeatedValueSuspicionThreshold: 3,
  });
  const out = await phase1RegexStage.run({
    text: ocrText,
    per_anlage: {
      VOR: { anlage: 'VOR' as never, felder: [e1] },
      KIND: { anlage: 'KIND' as never, felder: [e2] },
      SO: { anlage: 'SO' as never, felder: [e3] },
    },
  }, ctx);
  const hA = out.per_anlage.VOR.regex_hits['E_BEZ_A'];
  const hB = out.per_anlage.KIND.regex_hits['E_BEZ_B'];
  const hC = out.per_anlage.SO.regex_hits['E_BEZ_C'];
  assert('VOR hit exists', !!hA);
  assert('KIND hit exists', !!hB);
  assert('SO hit exists', !!hC);
  eq('VOR repeat_suspicious=true', hA?.repeat_suspicious, true);
  eq('KIND repeat_suspicious=true', hB?.repeat_suspicious, true);
  eq('SO repeat_suspicious=true', hC?.repeat_suspicious, true);
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Backwards compat: vordruckzeileAnchor=false → erste-Match-Semantik bleibt.
// ───────────────────────────────────────────────────────────────────────────

console.log('\n[Backwards-compat: vordruckzeileAnchor=false]');
{
  // Two candidate lines, neither anchored for the field. With anchor=true
  // we'd take the first; with anchor=false same. Just verify it doesn't crash.
  const ocrText = '99 Bezeichnung 456\n48 Bezeichnung 456';
  const bez = feld({
    eCode: 'E_TEST_X',
    drucktext: 'Bezeichnung',
    vordruckzeile: '7', // matches neither line
  });
  const out = await runStage(ocrText, 'VOR', [bez], {
    minDrucktextLength: 5,
    minDrucktextLength3F: 5,
    vordruckzeileAnchor: false,
  });
  const hit = out.per_anlage.VOR.regex_hits['E_TEST_X'];
  assert('hit exists', !!hit);
  eq('  zeile_anchored=false (mismatch)', hit?.zeile_anchored, false);
}

// ───────────────────────────────────────────────────────────────────────────
// Summary
// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
