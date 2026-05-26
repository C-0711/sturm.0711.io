/**
 * pre-validate Tests — Lane-1-Gate gegen den echten Postgres-Catalog.
 *
 * Geht GEGEN die live DB (kein Mock — Policy [[no-mock-policy]]).
 *
 * Ausführen:
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog \
 *     npx tsx src/workflows/elster/lib/field-mapper/pre-validate.test.ts
 */
import pg from 'pg';
import { preValidate } from './pre-validate.ts';
import type { MappedField } from './types.ts';

const { Pool } = pg;

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

function mkField(over: Partial<MappedField>): MappedField {
  return {
    eCode: over.eCode ?? 'E0100081',
    anlage: over.anlage ?? 'ESt1A',
    kontextSubpath: over.kontextSubpath,
    wert: over.wert ?? '',
    rawValue: over.rawValue ?? over.wert ?? '',
    person: over.person ?? 'A',
    pdfLabel: over.pdfLabel ?? 'Identifikationsnummer',
    valueType: over.valueType ?? 'idnr',
    method: 'schema',
    confidence: 1,
  };
}

async function main(): Promise<void> {
  const url =
    process.env.ELSTER_CATALOG_PG_URL ??
    'postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog';
  const pool = new Pool({ connectionString: url, max: 4 });

  console.log('\n1. Saubere Felder → keine Issues\n');
  {
    const r = await preValidate(
      [
        mkField({ eCode: 'E0100081', wert: '57438590613', rawValue: '57 438 590 613' }),
        mkField({ eCode: 'E0200201', anlage: 'N', wert: '69292', rawValue: '69.291,80 €', valueType: 'int_euro' }),
      ],
      { pool, vz: 2024 },
    );
    assert('keine Issues', r.issues.length === 0, JSON.stringify(r.issues, null, 2));
    assert('ready=true', r.ready);
  }

  console.log('\n2. IdNr nur 10-stellig → pattern-mismatch ODER length-too-short\n');
  {
    const r = await preValidate(
      [mkField({ eCode: 'E0100081', wert: '1234567890', rawValue: '1234567890' })],
      { pool, vz: 2024 },
    );
    assert('≥1 error', r.errorCount >= 1, r);
    const codes = r.issues.map((i) => i.category);
    assert(
      'Kategorie pattern-mismatch oder length-too-short',
      codes.includes('pattern-mismatch') || codes.includes('length-too-short'),
      codes,
    );
    assert('ready=false', !r.ready);
  }

  console.log('\n3. Religion-Code falsch → enum-violation\n');
  {
    const r = await preValidate(
      [mkField({
        eCode: 'E0100402',
        anlage: 'ESt1A',
        wert: 'EV', // alte 2-Letter-Schreibweise — nicht in der ELSTER-Enum
        rawValue: 'Evangelisch',
        valueType: 'enum',
        pdfLabel: 'Religion',
      })],
      { pool, vz: 2024 },
    );
    const issues = r.byCategory['enum-violation'];
    assert('enum-violation gemeldet', issues.length === 1, issues);
    assert(
      'expectedEnumValues enthält "02"',
      (issues[0]?.expectedEnumValues ?? []).includes('02'),
      issues[0]?.expectedEnumValues,
    );
  }

  console.log('\n4. Religion-Code richtig (02) → ok\n');
  {
    const r = await preValidate(
      [mkField({
        eCode: 'E0100402',
        anlage: 'ESt1A',
        wert: '02',
        rawValue: 'Evangelisch',
        valueType: 'enum',
        pdfLabel: 'Religion',
      })],
      { pool, vz: 2024 },
    );
    assert('keine Issues', r.issues.length === 0, r.issues);
  }

  console.log('\n5. Decimal mit zu vielen Vorkomma-Stellen → decimal-overflow\n');
  {
    // E0200201 (Bruttoarbeitslohn) hat max_vorkomma=12 im Catalog.
    // 13-stelliger Wert muss als overflow gemeldet werden.
    const r = await preValidate(
      [mkField({
        eCode: 'E0200201',
        anlage: 'N',
        kontextSubpath: 'ArbL/LStB_1_5_Sum',
        wert: '1234567890123',
        rawValue: '1.234.567.890.123,00',
        valueType: 'int_euro',
        pdfLabel: 'Bruttoarbeitslohn',
      })],
      { pool, vz: 2024 },
    );
    const issues = r.byCategory['decimal-overflow'];
    assert('decimal-overflow gemeldet', issues.length === 1, issues);
  }

  console.log('\n6. Unknown E-Code → unknown-ecode\n');
  {
    const r = await preValidate(
      [mkField({ eCode: 'E9999999', anlage: 'N', wert: 'x' })],
      { pool, vz: 2024 },
    );
    assert('unknown-ecode gemeldet', r.byCategory['unknown-ecode'].length === 1, r.issues);
  }

  console.log('\n7. IBAN mit Spaces → KEIN error (XML-Gen strippt auto)\n');
  {
    const r = await preValidate(
      [mkField({
        eCode: 'E0102102',
        anlage: 'ESt1A',
        kontextSubpath: 'Allg/BV',
        wert: 'DE93 5775 1310 0003 0156 58',
        rawValue: 'DE93 5775 1310 0003 0156 58',
        valueType: 'string',
        pdfLabel: 'IBAN',
      })],
      { pool, vz: 2024 },
    );
    assert('keine pattern-mismatch (auto-strip)',
      r.byCategory['pattern-mismatch'].length === 0, r.byCategory['pattern-mismatch']);
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
