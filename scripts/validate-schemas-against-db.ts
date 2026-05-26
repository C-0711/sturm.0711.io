/**
 * validate-schemas-against-db.ts  —  CI-Gate für die field-mapper Beleg-Schemas
 *
 * Verifiziert, dass jeder FieldMapping in src/workflows/elster/lib/field-mapper/schemas.ts
 * mit dem Postgres-Catalog (`elster.*` Schema) konsistent ist:
 *
 *   (a) E-Code existiert in elster.feld
 *   (b) anlage stimmt mit elster.anlage.name überein
 *   (c) kontextSubpath ist ein Suffix von elster.kontext.pfad (nach /<anlage>/-Strip)
 *   (d) valueType ist mit elster.format_typ.kanonisch verträglich
 *
 * Exit-Codes:
 *   0  alles sauber
 *   1  ≥1 FAIL (E-Code fehlt, anlage/kontext mismatch)
 *   2  WARN-only (valueType-Divergenz — nicht blockierend)
 *
 * Ausführen:
 *   tsx scripts/validate-schemas-against-db.ts
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog \
 *     tsx scripts/validate-schemas-against-db.ts
 *
 * --json  emittiert structured output für CI-Parser.
 * --strict  behandelt WARN als FAIL (Exit 1 statt 2).
 */
import pg from 'pg';
import { ALL_SCHEMAS } from '../src/workflows/elster/lib/field-mapper/schemas.ts';
import type { FieldMapping, ValueType } from '../src/workflows/elster/lib/field-mapper/types.ts';

const { Pool } = pg;

const DEFAULT_PG_URL =
  'postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog';

const JSON_MODE = process.argv.includes('--json');
const STRICT_MODE = process.argv.includes('--strict');

// ─── TS ValueType ↔ catalog format_typ.kanonisch Mapping ────────────────
// Permissiv gehalten: einige TS-Typen mappen auf mehrere kanonisch-Strings,
// weil load_01_xsd_types.py die XSD-Datums-/Jahres-/Monats-Typen alle als
// 'date' klassifiziert. WARN statt FAIL, falls Mismatch — möglicherweise
// intentionale Re-Typing (z.B. int_euro für ein Decimal-Feld mit
// kaufmännischer Rundung).
const TS_TO_KANONISCH: Record<ValueType, ReadonlyArray<string>> = {
  string: ['string'],
  int_euro: ['int_euro', 'int_nn_euro', 'decimal_eur_cent'], // int_euro darf decimal-Felder konsumieren (Rundung); int_nn_euro = non-negative
  decimal_eur_cent: ['decimal_eur_cent'],
  idnr: ['idnr', 'string'],
  date_TTMMJJJJ: ['date'],
  year_JJJJ: ['date', 'date_partial', 'int_euro', 'string'],
  month_MM: ['date', 'date_partial', 'int_euro', 'string'],
  enum: ['enum'],
  bool_ja1: ['bool_ja1'],
};

interface CatalogHit {
  feld_id: number;
  name: string;
  anlage: string;
  kontext_pfad: string | null;
  format_kanonisch: string | null;
  format_regex: string | null;
  format_max_length: number | null;
  drucktext: string | null;
  vordruckzeile: string | null;
}

interface Issue {
  severity: 'FAIL' | 'WARN';
  belegTyp: string;
  pdfLabel: string;
  eCode: string;
  category:
    | 'missing-ecode'
    | 'anlage-mismatch'
    | 'kontext-mismatch'
    | 'valuetype-mismatch';
  detail: string;
  candidates?: CatalogHit[];
}

async function loadCatalogHits(
  pool: pg.Pool,
  eCode: string,
): Promise<CatalogHit[]> {
  const { rows } = await pool.query<CatalogHit>(
    `SELECT f.feld_id,
            f.name,
            a.name           AS anlage,
            k.pfad           AS kontext_pfad,
            ft.kanonisch     AS format_kanonisch,
            ft.regex         AS format_regex,
            ft.max_laenge    AS format_max_length,
            f.drucktext,
            f.vordruckzeile
       FROM elster.feld f
       JOIN elster.anlage a       USING (anlage_id)
  LEFT JOIN elster.kontext k       ON k.kontext_id = f.kontext_id
  LEFT JOIN elster.format_typ ft   ON ft.format_id = f.format_id
      WHERE f.name = $1`,
    [eCode],
  );
  return rows;
}

function checkField(
  belegTyp: string,
  field: FieldMapping,
  hits: CatalogHit[],
): Issue[] {
  const issues: Issue[] = [];

  // ── (a) missing-ecode ──────────────────────────────────────────────────
  if (hits.length === 0) {
    issues.push({
      severity: 'FAIL',
      belegTyp,
      pdfLabel: field.pdfLabel,
      eCode: field.eCode,
      category: 'missing-ecode',
      detail: `E-Code ${field.eCode} ist NICHT im Catalog (elster.feld) vorhanden.`,
    });
    return issues;
  }

  // ── (b) anlage-mismatch ────────────────────────────────────────────────
  const inAnlage = hits.filter((h) => h.anlage === field.anlage);
  if (inAnlage.length === 0) {
    const present = [...new Set(hits.map((h) => h.anlage))].sort();
    issues.push({
      severity: 'FAIL',
      belegTyp,
      pdfLabel: field.pdfLabel,
      eCode: field.eCode,
      category: 'anlage-mismatch',
      detail: `Schema sagt anlage=${field.anlage}, Catalog hat ${field.eCode} in: [${present.join(', ')}]`,
      candidates: hits,
    });
    return issues; // wenn anlage falsch ist, keine weiteren Checks sinnvoll
  }

  // ── (c) kontextSubpath check ───────────────────────────────────────────
  // Catalog hat pfad wie '/N/ArbL/LStB_1_5_Sum'. Schema-subpath ist
  // 'ArbL/LStB_1_5_Sum'. Erwartet ist Suffix-Match.
  let matchedInKontext: CatalogHit | undefined;
  if (field.kontextSubpath) {
    const expectedSuffix = '/' + field.kontextSubpath;
    matchedInKontext = inAnlage.find(
      (h) =>
        h.kontext_pfad === `/${field.anlage}/${field.kontextSubpath}` ||
        (h.kontext_pfad ?? '').endsWith(expectedSuffix),
    );
    if (!matchedInKontext) {
      const pfade = inAnlage.map((h) => h.kontext_pfad ?? '∅');
      issues.push({
        severity: 'FAIL',
        belegTyp,
        pdfLabel: field.pdfLabel,
        eCode: field.eCode,
        category: 'kontext-mismatch',
        detail: `Schema: kontextSubpath=${field.kontextSubpath}; Catalog-Pfade für ${field.eCode}/Anlage ${field.anlage}: [${pfade.join(' | ')}]`,
        candidates: inAnlage,
      });
      return issues;
    }
  } else {
    matchedInKontext = inAnlage[0]; // nimm ersten Treffer
  }

  // ── (d) valueType vs kanonisch ─────────────────────────────────────────
  if (matchedInKontext?.format_kanonisch) {
    const expected = TS_TO_KANONISCH[field.valueType];
    if (!expected.includes(matchedInKontext.format_kanonisch)) {
      issues.push({
        severity: 'WARN', // möglicherweise intentional (z.B. int_euro auf decimal-Feld via Rundung)
        belegTyp,
        pdfLabel: field.pdfLabel,
        eCode: field.eCode,
        category: 'valuetype-mismatch',
        detail: `Schema: valueType=${field.valueType} (erlaubt [${expected.join(', ')}]); Catalog: kanonisch=${matchedInKontext.format_kanonisch}`,
        candidates: [matchedInKontext],
      });
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const url = process.env.ELSTER_CATALOG_PG_URL ?? DEFAULT_PG_URL;
  if (!JSON_MODE) {
    console.log('');
    console.log('═'.repeat(78));
    console.log('  validate-schemas-against-db');
    console.log(`  DB: ${url}`);
    console.log('═'.repeat(78));
  }

  const pool = new Pool({ connectionString: url, max: 4 });

  // smoke test: kommt die DB hoch und hat sie das elster-Schema?
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM elster.feld`,
    );
    if (!JSON_MODE) {
      console.log(`  Catalog hat ${rows[0].count} feld-Einträge`);
    }
  } catch (err) {
    console.error('FATAL: Catalog-DB unreachable oder elster.feld fehlt.');
    console.error(err);
    process.exit(3);
  }

  const issues: Issue[] = [];
  let totalChecked = 0;
  let totalAgree = 0;

  for (const [belegTypKey, schema] of Object.entries(ALL_SCHEMAS)) {
    for (const field of schema.felder) {
      totalChecked++;
      const hits = await loadCatalogHits(pool, field.eCode);
      const fieldIssues = checkField(belegTypKey, field, hits);
      if (fieldIssues.length === 0) {
        totalAgree++;
      } else {
        issues.push(...fieldIssues);
      }
    }
  }

  await pool.end();

  const fails = issues.filter((i) => i.severity === 'FAIL');
  const warns = issues.filter((i) => i.severity === 'WARN');

  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        {
          totalChecked,
          totalAgree,
          fails: fails.length,
          warns: warns.length,
          issues,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('');
    console.log('═'.repeat(78));
    console.log(`  Ergebnis: ${totalChecked} FieldMappings geprüft`);
    console.log('═'.repeat(78));
    console.log(`    ✓ ${totalAgree.toString().padStart(4)} clean`);
    console.log(`    ✗ ${fails.length.toString().padStart(4)} failures`);
    console.log(`    ⚠ ${warns.length.toString().padStart(4)} warnings`);
    console.log('');

    if (issues.length > 0) {
      const byCategory = new Map<string, Issue[]>();
      for (const issue of issues) {
        const arr = byCategory.get(issue.category) ?? [];
        arr.push(issue);
        byCategory.set(issue.category, arr);
      }
      for (const cat of [
        'missing-ecode',
        'anlage-mismatch',
        'kontext-mismatch',
        'valuetype-mismatch',
      ]) {
        const list = byCategory.get(cat);
        if (!list) continue;
        console.log(`──── ${cat} (${list.length}) ${'─'.repeat(60 - cat.length)}`);
        for (const i of list) {
          const flag = i.severity === 'FAIL' ? '✗' : '⚠';
          console.log(`  ${flag} [${i.belegTyp}] ${i.pdfLabel}`);
          console.log(`      → ${i.eCode}`);
          console.log(`      ${i.detail}`);
          if (i.candidates && i.candidates.length > 0 && i.candidates.length <= 4) {
            for (const c of i.candidates) {
              console.log(
                `      catalog: anlage=${c.anlage} pfad=${c.kontext_pfad ?? '∅'} kanonisch=${c.format_kanonisch ?? '∅'} drucktext=${JSON.stringify((c.drucktext ?? '').slice(0, 50))}`,
              );
            }
          }
        }
        console.log('');
      }
    } else {
      console.log('  Alle Schema-Einträge stimmen mit dem Catalog überein.');
      console.log('');
    }
  }

  if (fails.length > 0) {
    process.exit(1);
  }
  if (warns.length > 0 && STRICT_MODE) {
    process.exit(1);
  }
  if (warns.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Validator crashed:', err);
  process.exit(3);
});
