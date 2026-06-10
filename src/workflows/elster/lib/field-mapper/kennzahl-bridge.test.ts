/**
 * kennzahl-bridge Tests — E-Code → Sachbereich.Kennzahl (gegen live Catalog).
 *
 * Ausführen:
 *   ELSTER_CATALOG_PG_URL=... npx tsx src/workflows/elster/lib/field-mapper/kennzahl-bridge.test.ts
 */
import pg from 'pg';
import { annotateWithKennzahl, formatKennzahl } from './kennzahl-bridge.ts';
import type { MappedField, Person } from './types.ts';

const { Pool } = pg;
let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

function mk(eCode: string, anlage: string, person: Person, wert = '1'): MappedField {
  return { eCode, anlage, wert, rawValue: wert, person, pdfLabel: eCode, valueType: 'int_euro', method: 'schema', confidence: 1 };
}

async function main(): Promise<void> {
  const url = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog';
  const pool = new Pool({ connectionString: url, max: 4 });

  console.log('\n1. Shared E-Code: Person A vs B → unterschiedlicher Sachbereich\n');
  {
    const r = await annotateWithKennzahl([
      mk('E0200201', 'N', 'A', '69292'),
      mk('E0200201', 'N', 'B', '30000'),
    ], { pool, vz: 2024 });
    const a = r.enriched[0].kennzahl;
    const b = r.enriched[1].kennzahl;
    assert('Person A → Sachbereich 47, Kz 110', a?.sachbereich === '47' && a?.kennzahl === '110', a);
    assert('Person B → Sachbereich 48, Kz 110', b?.sachbereich === '48' && b?.kennzahl === '110', b);
    assert('lfd_nr A=1, B=2', a?.lfdNr === 1 && b?.lfdNr === 2, [a?.lfdNr, b?.lfdNr]);
  }

  console.log('\n2. KAP Kapitalerträge E1900701 → SB 54, Kz 210\n');
  {
    const r = await annotateWithKennzahl([mk('E1900701', 'KAP', 'A')], { pool, vz: 2024 });
    const kz = r.enriched[0].kennzahl;
    assert('E1900701 → SB 54 Kz 210', kz?.sachbereich === '54' && kz?.kennzahl === '210', kz);
    assert('formatKennzahl = "54.210"', formatKennzahl(kz) === '54.210', formatKennzahl(kz));
  }

  console.log('\n3. VOR-Feld E2001203 (AN-Beiträge KV) auflösbar\n');
  {
    const r = await annotateWithKennzahl([mk('E2001203', 'VOR', 'A')], { pool, vz: 2024 });
    const kz = r.enriched[0].kennzahl;
    assert('E2001203 hat Kennzahl', kz !== undefined, kz);
    assert('Anlage VOR', kz?.anlage === 'VOR', kz);
  }

  console.log('\n4. Coverage über realistisches Feld-Set\n');
  {
    const fields = [
      mk('E0200201', 'N', 'A'), mk('E0200301', 'N', 'A'), mk('E0200401', 'N', 'A'),
      mk('E0200501', 'N', 'A'), mk('E2001203', 'VOR', 'A'), mk('E2001505', 'VOR', 'A'),
      mk('E1900701', 'KAP', 'A'), mk('E1901402', 'KAP', 'A'),
    ];
    const r = await annotateWithKennzahl(fields, { pool, vz: 2024 });
    console.log(`  Coverage: ${(r.coverage * 100).toFixed(0)}% (${fields.length - r.unresolved.length}/${fields.length})`);
    for (const f of r.enriched) {
      console.log(`    ${f.eCode} [${f.anlage}] P${f.person} → ${formatKennzahl(f.kennzahl)}`);
    }
    assert('Coverage ≥ 0.75 auf Kern-Feldern', r.coverage >= 0.75, r.coverage);
  }

  console.log('\n5. Unbekannter E-Code → unresolved, kein Crash\n');
  {
    const r = await annotateWithKennzahl([mk('E9999999', 'N', 'A')], { pool, vz: 2024 });
    assert('E9999999 in unresolved', r.unresolved.some((u) => u.eCode === 'E9999999'), r.unresolved);
    assert('Feld bleibt erhalten (ohne kennzahl)', r.enriched.length === 1 && r.enriched[0].kennzahl === undefined);
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(2); });
