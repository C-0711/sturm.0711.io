import { registerStage } from '../core/registry.ts';
import { mistralOcrStage } from './mistral-ocr.ts';
import { textStatsStage } from './text-stats.ts';

export function registerAllStages(): void {
  registerStage(mistralOcrStage);
  registerStage(textStatsStage);
}

export { mistralOcrStage, textStatsStage };
