import { registerWorkflow } from '../core/registry.ts';
import { helloOcrWorkflow } from './hello-ocr/index.ts';
import {
  registerElsterStages as registerLegacyElsterStages,
  buildElsterWorkflowWithSchema,
} from './elster/index.ts';
import {
  registerSteuerbelegeStages,
  buildSteuerbelegeWorkflow,
  buildBelegeBundleWorkflow,
} from './steuerbelege/index.ts';
import { registerAllVerticals } from '../verticals/index.ts';
import { buildElsterV2WorkflowWithSchema } from '../verticals/elster/index.ts';
import { buildElsterV3WorkflowWithSchema } from '../verticals/elster-v3/index.ts';
import { registerElsterV3MultiStages, buildElsterV3MultiWorkflowWithSchema } from '../verticals/elster-v3/multi.ts';

export function registerAllWorkflows(): void {
  registerWorkflow(helloOcrWorkflow);
  registerLegacyElsterStages();
  registerWorkflow(buildElsterWorkflowWithSchema());
  registerSteuerbelegeStages();
  registerWorkflow(buildSteuerbelegeWorkflow());
  registerWorkflow(buildBelegeBundleWorkflow());
  registerAllVerticals();
  registerWorkflow(buildElsterV2WorkflowWithSchema());
  registerWorkflow(buildElsterV3WorkflowWithSchema());
  registerElsterV3MultiStages();
  registerWorkflow(buildElsterV3MultiWorkflowWithSchema());
}

export { helloOcrWorkflow };
