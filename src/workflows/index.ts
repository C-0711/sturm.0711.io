import { registerWorkflow } from '../core/registry.ts';
import { helloOcrWorkflow } from './hello-ocr/index.ts';
import { buildOcrShootoutWorkflow } from './ocr-shootout/index.ts';
import { buildElsterQualityDemoWorkflow } from './elster-quality-demo/index.ts';
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
import {
  buildElsterV3WorkflowWithSchema,
  buildElsterV4Workflow,
  buildElsterV5Workflow,
  buildElsterV51Workflow,
  buildElsterV52Workflow,
  buildElsterV52RagWorkflow,
  buildElsterV52RagEnsembleWorkflow,
  buildElsterV4StrickerWorkflow,
} from '../verticals/elster-v3/index.ts';
import { registerElsterV3MultiStages, buildElsterV3MultiWorkflowWithSchema } from '../verticals/elster-v3/multi.ts';
import { registerPentacamKcStages, buildPentacamKcWorkflow } from './pentacam-kc/index.ts';
import { registerMyopiaStages, buildMyopiaWorkflow } from './myopia-progression/index.ts';
import { registerSealStages, buildSteuerfallSealWorkflow } from './steuerfall-seal/index.ts';

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
  registerWorkflow(buildElsterV4Workflow());
  registerWorkflow(buildElsterV5Workflow());
  registerWorkflow(buildElsterV51Workflow());
  registerWorkflow(buildElsterV52Workflow());
  registerWorkflow(buildElsterV52RagWorkflow());
  registerWorkflow(buildElsterV52RagEnsembleWorkflow());
  registerWorkflow(buildElsterV4StrickerWorkflow());
  registerElsterV3MultiStages();
  registerWorkflow(buildElsterV3MultiWorkflowWithSchema());
  registerWorkflow(buildOcrShootoutWorkflow());
  registerPentacamKcStages();
  registerWorkflow(buildPentacamKcWorkflow());
  registerMyopiaStages();
  registerWorkflow(buildMyopiaWorkflow());
  // Quality-Trias showcase — uses the new quality/* stages.
  registerWorkflow(buildElsterQualityDemoWorkflow());
  // Steuerfall-Versiegelung: HMAC-Snapshot + Merkle + Anchor.
  registerSealStages();
  registerWorkflow(buildSteuerfallSealWorkflow());
}

export { helloOcrWorkflow };
