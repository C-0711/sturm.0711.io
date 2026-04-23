import { registerWorkflow } from '../core/registry.ts';
import { helloOcrWorkflow } from './hello-ocr/index.ts';

export function registerAllWorkflows(): void {
  registerWorkflow(helloOcrWorkflow);
  // Elster folgt in Phase 2 — Port aus legacy/elster-mvp/
}

export { helloOcrWorkflow };
