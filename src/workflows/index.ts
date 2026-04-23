import { registerWorkflow } from '../core/registry.ts';
import { helloOcrWorkflow } from './hello-ocr/index.ts';
import { registerElsterStages, buildElsterWorkflowWithSchema } from './elster/index.ts';

export function registerAllWorkflows(): void {
  registerWorkflow(helloOcrWorkflow);
  registerElsterStages();
  registerWorkflow(buildElsterWorkflowWithSchema());
}

export { helloOcrWorkflow };
