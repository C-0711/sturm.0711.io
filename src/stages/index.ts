import { registerStage } from '../core/registry.ts';
import { mistralOcrStage } from './mistral-ocr.ts';
import { textStatsStage } from './text-stats.ts';
import { compareFanoutStage } from './compare-fanout.ts';
import { compareMergeStage } from './compare-merge.ts';
import { evalKpiStage } from './eval-kpi.ts';
import { pdfTextLayerStage } from './pdf-text-layer.ts';
import { lightonOcrStage } from './lighton-ocr.ts';
import { paddleOcrVlStage } from './paddleocr-vl.ts';
import { mistralSmallOcrStage } from './mistral-small-ocr.ts';
import { schemaGuardedLlmStage } from './quality/schema-guarded-llm.ts';
import { criticLlmStage } from './quality/critic-llm.ts';
import { spanLinkerStage } from './quality/span-linker.ts';
import { crossValidatorStage } from './quality/cross-validator.ts';
import { containerFieldMapperStage } from './quality/container-field-mapper.ts';
import { ocrConsensusMergeStage } from './ocr-consensus-merge.ts';
import { autoSourceSplitStage } from './auto-source-split.ts';

export function registerAllStages(): void {
  registerStage(mistralOcrStage);
  registerStage(textStatsStage);
  registerStage(compareFanoutStage);
  registerStage(compareMergeStage);
  registerStage(evalKpiStage);
  registerStage(pdfTextLayerStage);
  registerStage(lightonOcrStage);
  registerStage(paddleOcrVlStage);
  registerStage(mistralSmallOcrStage);
  // Quality-Trias — defensible-extraction node family
  registerStage(schemaGuardedLlmStage);
  registerStage(criticLlmStage);
  registerStage(spanLinkerStage);
  registerStage(crossValidatorStage);
  // Container-aware: decorates extraction with eCode + Anleitung metadata
  registerStage(containerFieldMapperStage);
  // OCR consensus merger — semantic line alignment + confidence-weighted vote
  registerStage(ocrConsensusMergeStage);
  // Auto-source-split — adaptive page-fanout based on dynamic prompt budget
  registerStage(autoSourceSplitStage);
}

export {
  mistralOcrStage,
  textStatsStage,
  compareFanoutStage,
  compareMergeStage,
  evalKpiStage,
  pdfTextLayerStage,
  lightonOcrStage,
  paddleOcrVlStage,
  mistralSmallOcrStage,
  schemaGuardedLlmStage,
  criticLlmStage,
  spanLinkerStage,
  crossValidatorStage,
  containerFieldMapperStage,
  ocrConsensusMergeStage,
  autoSourceSplitStage,
};
