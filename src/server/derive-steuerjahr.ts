/**
 * Case-level Steuerjahr aggregation.
 *
 * Per-doc Priorisierung des Steuerjahres läuft im `klassifizierung`-Stage
 * ([src/workflows/elster/stages/klassifizierung.ts:detectSteuerjahr]). Der
 * Stage emittiert pro Beleg `steuerjahr` + `doc_type`. Diese Funktion
 * aggregiert über alle Runs eines Cases und gewichtet nach Beleg-Typ:
 *
 *   1. einkommensteuererklaerung (Hauptvordruck/ESt1A) — Leitbeleg,
 *      gewinnt unmittelbar. Das Jahr steht im Form-Header und ist die
 *      autoritative Veranlagungs-Jahreszahl des Falls.
 *   2. vast_bundle (Lohnsteuerbescheinigung) — Header-Jahr, stark; Modus
 *      über alle vast_bundle-Belege.
 *   3. einzelbeleg / unbekannter doc_type — Modus über alle übrigen Belege
 *      (Zinsbescheinigungen tragen oft das Transaktionsjahr, nicht das VZ).
 *
 * Wird leider nicht von einem Stage selbst geliefert weil case-level
 * Aggregation erst nach Multi-Doc-Upload existiert — Runs laufen einzeln.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TIER_ORDER = ['einkommensteuererklaerung', 'vast_bundle', 'other'] as const;

export async function deriveSteuerjahrFromRuns(
  runsDir: string,
  workflowId: string,
  runIds: string[] | undefined,
): Promise<number | undefined> {
  if (!runIds?.length) return undefined;
  const byTier: Record<string, Map<number, number>> = {
    einkommensteuererklaerung: new Map(),
    vast_bundle: new Map(),
    other: new Map(),
  };
  for (const rid of runIds) {
    try {
      const raw = await readFile(
        join(runsDir, workflowId, rid, 'klassifizierung', 'output.json'),
        'utf-8',
      );
      const out = JSON.parse(raw) as { steuerjahr?: unknown; doc_type?: unknown };
      const j = out.steuerjahr;
      if (typeof j !== 'number' || !Number.isFinite(j)) continue;
      const dt = typeof out.doc_type === 'string' ? out.doc_type : '';
      const tier =
        dt === 'einkommensteuererklaerung' || dt === 'vast_bundle' ? dt : 'other';
      byTier[tier].set(j, (byTier[tier].get(j) ?? 0) + 1);
    } catch { /* run ohne klassifizierung output — überspringen */ }
  }
  for (const tier of TIER_ORDER) {
    const counts = byTier[tier];
    if (counts.size === 0) continue;
    let best: number | undefined;
    let bestN = 0;
    for (const [j, n] of counts) if (n > bestN) { best = j; bestN = n; }
    if (best !== undefined) return best;
  }
  return undefined;
}
