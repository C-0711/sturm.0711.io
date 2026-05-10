/**
 * Aggregator for all standard verticals. The main STURM repo's
 * src/workflows/index.ts calls registerAllVerticals() to wire every
 * vertical's NEW stages at engine startup. Existing prod stages (e.g.
 * elster/klassifizierung registered by src/workflows/elster/) are NOT
 * re-registered here — they remain owned by the legacy registrar.
 *
 * Each vertical is one Standard (ELSTER, ETIM, eCl@ss, GoBD, …). See
 * _vertical-contract.md for the recipe.
 */
import { registerElsterStages, ELSTER_VERTICAL_META } from './elster/index.ts';
import { registerElsterV3Stages, ELSTER_V3_VERTICAL_META } from './elster-v3/index.ts';

/** Registers stages for every active vertical. */
export function registerAllVerticals(): void {
  registerElsterStages();    // funnel, validator, embed-cascade, entity-resolve, deterministic-rules
  registerElsterV3Stages();  // layer1-extract, layer2-resolve
  // Future:
  // registerEtimStages();
  // registerEclassStages();
  // registerGobdStages();
}

/** Public listing of every vertical's metadata, for the workspace API */
export const VERTICAL_META = [
  ELSTER_VERTICAL_META,
  ELSTER_V3_VERTICAL_META,
  // Future: ETIM_VERTICAL_META, ECLASS_VERTICAL_META, …
] as const;
