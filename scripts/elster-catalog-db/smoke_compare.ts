#!/usr/bin/env tsx
/**
 * Vergleicht JSON-basierten Katalog mit Postgres-Variante.
 * Aufruf: ELSTER_CATALOG_PG_URL=postgresql:///elster_catalog tsx smoke_compare.ts
 *
 * Misst: pro Anlage Differenzen in fieldCount, Beispiel-E-Codes, und
 * stichprobenartiges Round-Trip-Mapping für 6 Stricker-Codes.
 */
import { listVZ, loadKatalog, loadFelder } from '../../src/workflows/elster/lib/anlagen-katalog.ts';

// Wichtig: 2 unabhängige Aufrufe, einmal JSON, einmal PG. Cache umgehen wir,
// indem wir USE_PG erst nach dem ersten Aufruf einschalten — dafür müssten
// wir Module neu laden. Einfacher: 2 separate Subprozesse via Bash. Hier
// machen wir einen klaren Single-Prozess-Lauf in einem Modus.
const mode = process.env.ELSTER_CATALOG_PG_URL ? 'PG' : 'JSON';
console.log(`[smoke] Modus: ${mode}`);

const TARGET = new Set([
  'E0100081', 'E0100082', 'E0200201', 'E0200301', 'E0201806', 'E2001203',
]);

async function main() {
  const vzs = await listVZ();
  console.log(`[smoke] verfügbare VZ: ${vzs.join(', ')}`);
  const vz = vzs[0];
  const katalog = await loadKatalog(vz);
  console.log(`[smoke] Anlagen (${vz}): ${katalog.anlagen.length}`);
  for (const a of katalog.anlagen.slice(0, 5)) {
    console.log(`   - ${a.name.padEnd(12)} fields=${a.fieldCount}`);
  }

  for (const anlage of ['ESt1A', 'N', 'VOR', 'KAP']) {
    const f = await loadFelder(anlage, vz);
    const total = f.felder.length;
    const ecodes = f.felder.filter((x) => /^E\d{7,8}$/.test(x.Name)).length;
    console.log(`[smoke] ${anlage.padEnd(7)} felder_gesamt=${total} ecodes=${ecodes}`);

    for (const fl of f.felder) {
      if (TARGET.has(fl.Name)) {
        console.log(
          `   ${fl.Name}: zeile=${fl.Vordruckzeile}  ` +
          `format=${(fl.Format || '').slice(0, 30)}  ` +
          `drucktext="${(fl.Drucktext || '').slice(0, 60)}"`
        );
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[smoke] FEHLER', e);
  process.exit(1);
});
