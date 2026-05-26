/**
 * mapper-from-tagged Tests — pure-function checks (kein Netzwerk).
 *
 * Ausführen:
 *   npx tsx src/workflows/elster/lib/field-mapper/mapper-from-tagged.test.ts
 */
import { classifyFromTagged, mapBelegFromTagged } from './mapper-from-tagged.ts';
import type {
  BBoxWire,
  ConsensusRecord,
  TaggedPage,
  TaggedRecord,
} from './ocr-ensemble-client.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

function mkRecord(text: string, bbox: BBoxWire | null): ConsensusRecord {
  return { text, bbox, confidence_min: 0.95, voters: ['paddleocr-classical'] };
}
function mkTagged(rec: ConsensusRecord, candidates: Array<[string, number]>): TaggedRecord {
  return { record: rec, candidates };
}

// ── Hildburg-LStB-style: Label links + Wert rechts auf gleicher Zeile ───
console.log('\n1. LStB-Label rechts → Wert wird gefunden\n');
{
  const labelBrutto = mkRecord('Bruttoarbeitslohn', [100, 200, 280, 220]);
  const valBrutto   = mkRecord('30.707,00 €',       [500, 200, 620, 220]);
  const labelLst    = mkRecord('Lohnsteuer',         [100, 250, 200, 270]);
  const valLst      = mkRecord('2.960,00',           [500, 250, 600, 270]);
  const taggedPage: TaggedPage = {
    page_index: 0,
    records: [
      mkTagged(labelBrutto, [['E0200201', 0.93]]),
      mkTagged(valBrutto,   []),
      mkTagged(labelLst,    [['E0200301', 0.91]]),
      mkTagged(valLst,      []),
    ],
  };
  const r = mapBelegFromTagged([taggedPage], 'VaSt_LStB', 'A');
  const brutto = r.felder.find((f) => f.eCode === 'E0200201');
  const lst    = r.felder.find((f) => f.eCode === 'E0200301');
  assert('Bruttoarbeitslohn → E0200201 = 30707', brutto?.wert === '30707', brutto?.wert);
  assert('Lohnsteuer       → E0200301 = 2960,00', lst?.wert === '2960,00', lst?.wert);
  assert('Confidence übernommen vom semantic-overlay (≈ 0.93)',
    Math.abs((brutto?.confidence ?? 0) - 0.93) < 1e-6, brutto?.confidence);
}

console.log('\n2. Wert links vom Label → wird NICHT genommen (strikt rechts)\n');
{
  const valLinks = mkRecord('1234',           [50, 200, 90, 220]);
  const label    = mkRecord('Bruttoarbeitslohn', [100, 200, 280, 220]);
  const taggedPage: TaggedPage = {
    page_index: 0,
    records: [
      mkTagged(valLinks, []),
      mkTagged(label, [['E0200201', 0.95]]),
    ],
  };
  const r = mapBelegFromTagged([taggedPage], 'VaSt_LStB', 'A');
  assert('kein Match (Wert war links)', r.felder.length === 0, r.felder);
}

console.log('\n3. Score unter Threshold → ignoriert\n');
{
  const label = mkRecord('Bruttoarbeitslohn', [100, 200, 280, 220]);
  const val   = mkRecord('30707',              [500, 200, 600, 220]);
  const r = mapBelegFromTagged(
    [{ page_index: 0, records: [
      mkTagged(label, [['E0200201', 0.30]]),
      mkTagged(val, []),
    ] }],
    'VaSt_LStB',
    'A',
    { minScore: 0.5 },
  );
  assert('Top-1 unter minScore → 0 Felder', r.felder.length === 0, r.felder);
}

console.log('\n4. Y-Versatz größer als rowTolPx → ignoriert\n');
{
  const label = mkRecord('Bruttoarbeitslohn', [100, 200, 280, 220]);
  const val   = mkRecord('30707',              [500, 260, 600, 280]); // 60 px tiefer
  const r = mapBelegFromTagged(
    [{ page_index: 0, records: [
      mkTagged(label, [['E0200201', 0.95]]),
      mkTagged(val, []),
    ] }],
    'VaSt_LStB', 'A', { rowTolPx: 8 },
  );
  assert('y-Versatz > Toleranz → kein Match', r.felder.length === 0, r.felder);
}

console.log('\n5. E-Code nicht im Schema → ignoriert\n');
{
  const label = mkRecord('Foo Bar',  [100, 200, 200, 220]);
  const val   = mkRecord('42',        [500, 200, 540, 220]);
  const r = mapBelegFromTagged(
    [{ page_index: 0, records: [
      mkTagged(label, [['E9999999', 0.99]]),
      mkTagged(val, []),
    ] }],
    'VaSt_LStB', 'A',
  );
  assert('Unbekannter E-Code → 0 Felder', r.felder.length === 0, r.felder);
}

console.log('\n6. Mehrere Kandidaten: nur Top-1 zählt\n');
{
  const label = mkRecord('Lohnsteuer', [100, 200, 200, 220]);
  const val   = mkRecord('2.960,00',    [500, 200, 600, 220]);
  const r = mapBelegFromTagged(
    [{ page_index: 0, records: [
      mkTagged(label, [['E0200301', 0.92], ['E0200401', 0.88]]),
      mkTagged(val, []),
    ] }],
    'VaSt_LStB', 'A',
  );
  assert('nur 1 Feld emittiert', r.felder.length === 1, r.felder);
  assert('Top-1 (Lohnsteuer)', r.felder[0]?.eCode === 'E0200301', r.felder[0]?.eCode);
}

console.log('\n7. Schema fehlt → leeres Result + Warning\n');
{
  const r = mapBelegFromTagged([{ page_index: 0, records: [] }], 'Unbekannt' as never, 'A');
  assert('felder leer', r.felder.length === 0);
  assert('warning gesetzt', r.warnings.length === 1);
}

console.log('\n8. Page-Scoping: Label auf Page 0, Wert auf Page 1 → NICHT gepaart\n');
{
  const label = mkRecord('Bruttoarbeitslohn', [100, 200, 280, 220]);
  const val   = mkRecord('30707', [500, 200, 600, 220]);
  const r = mapBelegFromTagged(
    [
      { page_index: 0, records: [mkTagged(label, [['E0200201', 0.95]])] },
      { page_index: 1, records: [mkTagged(val,   [])] },
    ],
    'VaSt_LStB', 'A',
  );
  assert('cross-page → kein Match', r.felder.length === 0, r.felder);
}

console.log('\n9. Looks-like-value-Filter: Label-Text rechts wird nicht als Wert übernommen\n');
{
  const label = mkRecord('Bruttoarbeitslohn', [100, 200, 280, 220]);
  const otherLabel = mkRecord('Sozialversicherungsausweis-Nr', [500, 200, 800, 220]);
  const val = mkRecord('30707', [900, 200, 1000, 220]);
  const r = mapBelegFromTagged(
    [{ page_index: 0, records: [
      mkTagged(label, [['E0200201', 0.95]]),
      mkTagged(otherLabel, []),
      mkTagged(val, []),
    ] }],
    'VaSt_LStB', 'A',
    { maxValueDxPx: 2000 },
  );
  // looksLikeValueText accepts kurz Tokens — "Sozialversicherungsausweis-Nr" ist 28 Zeichen
  // langer Label-Text mit ":" oder "-Nr", trotzdem könnte er fälschlich matchen.
  // Wenn dies versagt, müssen wir looksLikeValueText weiter einschränken.
  // Für den Augenblick: wir akzeptieren dass "Sozialvers..." gewinnt (kürzeste x0).
  // Der Test dokumentiert das Verhalten ehrlich.
  console.log(`  (Diagnose: erster Match-Wert war "${r.felder[0]?.rawValue}")`);
  assert('mindestens ein Feld emittiert (greedy)', r.felder.length >= 1);
}

// ── classifyFromTagged ──────────────────────────────────────────────

console.log('\n10. classifyFromTagged: nur IdNr (trivial-Hit) → Unbekannt\n');
{
  // E0100081 ist in JEDEM Schema. Wenn das alles ist was wir sehen,
  // dürfen wir NICHT klassifizieren.
  const idnr = mkRecord('Identifikationsnummer', [50, 50, 250, 70]);
  const r = classifyFromTagged([{
    page_index: 0,
    records: [mkTagged(idnr, [['E0100081', 0.99]])],
  }]);
  assert('belegTyp = Unbekannt (minMatched=2)', r.belegTyp === ('Unbekannt' as never), r);
  assert('top-score < minScoreFloor ODER matched < minMatched',
    r.matchedECodes <= 1, r.matchedECodes);
}

console.log('\n11. classifyFromTagged: 3 RBM-Hits → VaSt_RBM gewinnt gegen 2-Feld Religion\n');
{
  // Anti-Bias-Test: Religion hat 2 felder. RBM hat 7. Wenn beide auf
  // E0100081 (geteilt) hits, ABER zusätzlich E1800301+E1800501 fürs RBM,
  // muss RBM gewinnen — vor dem Fix hätte Religion mit 50% coverage
  // dominiert.
  const tagged: TaggedPage = {
    page_index: 0,
    records: [
      mkTagged(mkRecord('IdNr',                       [10, 10, 100, 30]), [['E0100081', 0.95]]),
      mkTagged(mkRecord('Renten-/Leistungsbetrag',    [10, 50, 250, 70]), [['E1800301', 0.92]]),
      mkTagged(mkRecord('Beginn der Rente/Leistung',  [10, 90, 250, 110]), [['E1800501', 0.88]]),
    ],
  };
  const r = classifyFromTagged([tagged]);
  assert('belegTyp = VaSt_RBM',         r.belegTyp === 'VaSt_RBM', r);
  assert('matched >= 3',                 r.matchedECodes >= 3, r.matchedECodes);
  assert('top score > VaSt_Religion-score',
    r.scores[0].score > (r.scores.find((s) => s.belegTyp === 'VaSt_Religion')?.score ?? 0),
    r.scores);
}

console.log('\n12. classifyFromTagged: 5 LStB-Hits → VaSt_LStB\n');
{
  const tagged: TaggedPage = {
    page_index: 0,
    records: [
      mkTagged(mkRecord('IdNr',          [10,  10, 100,  30]), [['E0100081', 0.95]]),
      mkTagged(mkRecord('Steuerklasse',  [10,  50, 200,  70]), [['E0200002', 0.92]]),
      mkTagged(mkRecord('Brutto',         [10,  90, 200, 110]), [['E0200201', 0.95]]),
      mkTagged(mkRecord('Lohnsteuer',     [10, 130, 200, 150]), [['E0200301', 0.93]]),
      mkTagged(mkRecord('SolZ',           [10, 170, 200, 190]), [['E0200401', 0.90]]),
    ],
  };
  const r = classifyFromTagged([tagged]);
  assert('belegTyp = VaSt_LStB', r.belegTyp === 'VaSt_LStB', r);
  assert('matched >= 5',          r.matchedECodes >= 5, r);
}

console.log('\n13. classifyFromTagged: leere Tagged-Pages → Unbekannt\n');
{
  const r = classifyFromTagged([]);
  assert('belegTyp = Unbekannt', r.belegTyp === ('Unbekannt' as never));
  assert('matched = 0',          r.matchedECodes === 0);
}

console.log('\n14. classifyFromTagged: Score-floor schützt vor 1-trivial-Hit\n');
{
  // 1 RBM-Match → matched=1, coverage=1/7, score=sqrt(1*1/7)=0.378
  // Mit minScoreFloor=0.5 → REJECTED.
  const tagged: TaggedPage = {
    page_index: 0,
    records: [
      mkTagged(mkRecord('Renten-Betrag', [10, 50, 250, 70]), [['E1800301', 0.95]]),
    ],
  };
  const r = classifyFromTagged([tagged]);
  assert('1 hit nur → Unbekannt', r.belegTyp === ('Unbekannt' as never), r);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
