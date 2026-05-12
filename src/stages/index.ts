import { registerStage } from '../core/registry.ts';
import { mistralOcrStage } from './mistral-ocr.ts';
import { textStatsStage } from './text-stats.ts';
import { compareFanoutStage } from './compare-fanout.ts';
import { compareMergeStage } from './compare-merge.ts';
import { evalKpiStage } from './eval-kpi.ts';
import { pdfTextLayerStage } from './pdf-text-layer.ts';
import { lightonOcrStage } from './lighton-ocr.ts';
import { paddleOcrVlStage } from './paddleocr-vl.ts';

export function registerAllStages(): void {
  registerStage(mistralOcrStage);
  registerStage(textStatsStage);
  registerStage(compareFanoutStage);
  registerStage(compareMergeStage);
  registerStage(evalKpiStage);
  registerStage(pdfTextLayerStage);
  registerStage(lightonOcrStage);
  registerStage(paddleOcrVlStage);
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
};
