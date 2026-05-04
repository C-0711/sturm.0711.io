import { registerWorkflow } from '../core/registry.ts';
import { helloOcrWorkflow } from './hello-ocr/index.ts';
import { registerElsterStages, buildElsterWorkflowWithSchema } from './elster/index.ts';
import {
  registerSteuerbelegeStages,
  buildSteuerbelegeWorkflow,
  buildBelegeBundleWorkflow,
} from './steuerbelege/index.ts';

export function registerAllWorkflows(): void {
  registerWorkflow(helloOcrWorkflow);
  registerElsterStages();
  registerWorkflow(buildElsterWorkflowWithSchema());
  registerSteuerbelegeStages();
  registerWorkflow(buildSteuerbelegeWorkflow());
  registerWorkflow(buildBelegeBundleWorkflow());
}

export { helloOcrWorkflow };
