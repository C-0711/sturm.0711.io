/**
 * Backwards-compatibility shim.
 *
 * The ELSTER vertical lives at src/verticals/elster/. The main STURM repo's
 * src/workflows/index.ts historically imports `registerElsterStages` and
 * `buildElsterWorkflowWithSchema` from this path, so we re-export them here
 * unchanged. New code should import directly from `../../verticals/elster`.
 */
export {
  registerElsterStages,
  buildElsterWorkflowWithSchema,
  ELSTER_VERTICAL_META,
} from '../../verticals/elster/index.ts';
