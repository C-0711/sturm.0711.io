import type { StageDefinition } from './types.ts';

/**
 * Helper mit TypeScript-Inferenz. Erlaubt:
 *   export const meineStage = defineStage<InType, OutType, ConfigType>({
 *     id: 'meine-stage',
 *     name: 'Meine Stage',
 *     async run(input, ctx) { … }
 *   })
 */
export function defineStage<TIn = unknown, TOut = unknown, TConfig = unknown>(
  def: StageDefinition<TIn, TOut, TConfig>
): StageDefinition<TIn, TOut, TConfig> {
  return def;
}
