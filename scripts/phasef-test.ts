import { PROJECTION_RULES, applyProjections } from '../src/verticals/elster/lib/deterministic-rules.ts';
import type { CanonicalLayer } from '../src/lib/canonical-layer.ts';

const subdocs: Array<{doc_class: string; id: string; title: string; nested: any}> = [
  {
    doc_class: 'mitteilung_kapitalertraege',
    id: 'subdoc-2',
    title: 'Sparkasse Westerwald-Sieg',
    nested: {
      person: { steuer_id: '85236749007', vorname: 'Rainer', nachname: 'Stricker' },
      ehepartner: { steuer_id: '54129386608', vorname: 'Ute', nachname: 'Stricker' },
      freigestellte_kapitalertraege: [
        { geldinstitut: 'Sparkasse Westerwald-Sieg', betrag_eur: 5.00, meldejahr: 2024 }
      ],
      summen: { summe_freigestellt_eur: 5.00, anzahl_geldinstitute: 1 }
    }
  },
  {
    doc_class: 'mitteilung_kapitalertraege',
    id: 'subdoc-3',
    title: 'Volksbank Gebhardshain eG',
    nested: {
      person: { steuer_id: '85236749007', vorname: 'Rainer', nachname: 'Stricker' },
      ehepartner: { steuer_id: '54129386608', vorname: 'Maria Ute', nachname: 'Stricker' },
      freigestellte_kapitalertraege: [
        { geldinstitut: 'Volksbank Gebhardshain eG', betrag_eur: 319.00, meldejahr: 2024 }
      ],
      summen: { summe_freigestellt_eur: 319.00, anzahl_geldinstitute: 1 }
    }
  },
  {
    doc_class: 'religionszugehoerigkeit',
    id: 'subdoc-0',
    title: 'Religion Rainer (evangelisch)',
    nested: {
      personen: [{ rolle: 'hauptperson', steuer_id: '85236749007', konfession: 'evangelisch' }]
    }
  },
  {
    doc_class: 'religionszugehoerigkeit',
    id: 'subdoc-4',
    title: 'Religion Ute (katholisch)',
    nested: {
      personen: [{ rolle: 'hauptperson', steuer_id: '54129386608', konfession: 'römisch-katholisch' }]
    }
  },
  {
    doc_class: 'steuerbescheinigung_kapitalertraege',
    id: 'synthetic-bank-statement',
    title: 'Synthetic Steuerbescheinigung Beispielbank 2024',
    nested: {
      glaeubiger: { rolle: 'hauptperson', name: 'Rainer Stricker', steuer_id: '85236749007' },
      ausstellende_stelle: { name: 'Beispielbank AG' },
      veranlagungszeitraum: '2024',
      kapitalertraege: {
        hoehe_kapitalertraege_inland_eur: 1234.56,
        hoehe_kapitalertraege_ausland_eur: 89.10,
        in_anspruch_genommener_sparer_pauschbetrag_eur: 1000.00
      },
      abgezogene_steuern: {
        kapitalertragsteuer_eur: 234.56,
        solidaritaetszuschlag_eur: 12.90,
        kirchensteuer_eur: 21.11
      }
    }
  }
];

console.log('=== Phase F Projection Rule Test ===');
console.log(`PROJECTION_RULES total: ${PROJECTION_RULES.length}`);

// Aggregate "all sub-docs of a Stricker Vast bundle"
const aggregateLayer: CanonicalLayer = { codes: {}, citations: {}, sources: [], traces: [] } as any;

for (const sd of subdocs) {
  console.log(`\n--- ${sd.id}: ${sd.title} (doc_class=${sd.doc_class}) ---`);
  const layer: CanonicalLayer = { codes: {}, citations: {}, sources: [], traces: [] } as any;
  const result = applyProjections(sd.nested, layer, sd.doc_class);
  if (Object.keys(layer.codes).length > 0) {
    console.log('Codes emitted:');
    for (const [code, val] of Object.entries(layer.codes)) {
      console.log(`  ${code} = ${JSON.stringify(val)}`);
    }
  } else {
    console.log('  (no codes emitted)');
  }
  console.log(`Applied ${result.appliedRules.length} rules.`);

  // accumulate sums for E1901401 (sparer-pauschbetrag should be summed across docs)
  for (const [code, val] of Object.entries(layer.codes)) {
    const cur = aggregateLayer.codes[code];
    if (typeof val === 'number' && typeof cur === 'number') {
      aggregateLayer.codes[code] = cur + val;
    } else {
      aggregateLayer.codes[code] = val;
    }
  }
}

console.log(`\n=== Bundle aggregate (Stricker VaSt) ===`);
for (const [code, val] of Object.entries(aggregateLayer.codes)) {
  console.log(`  ${code} = ${JSON.stringify(val)}`);
}

// Sanity assertions
const expect = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) process.exitCode = 1;
};

console.log('\n=== Assertions ===');
expect(aggregateLayer.codes['E1901401'] === 324, `E1901401 (Sparer-Pauschbetrag aggregate) = 5+319 = 324`);
expect(aggregateLayer.codes['E1900601'] !== undefined, `E1900601 (Kirchensteuer-Flag) emitted`);
