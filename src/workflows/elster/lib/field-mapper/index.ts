/**
 * field-mapper — Public API
 *
 * Hauptfunktionen:
 *   - mapBeleg(input)     — ein Beleg → MappedField[]
 *   - aggregate(results)  — N Belege → konsolidierte Felder mit Summen
 *   - detectBelegTyp(text) — Beleg-Typ allein aus dem Titel
 *
 * Typen: siehe types.ts. Schemas: schemas.ts (kuratiert pro Beleg-Typ).
 */
export { mapBeleg, aggregate, detectBelegTyp } from './mapper.ts';
export { extractLabelValues, getFirst, getAll } from './extractor.ts';
export { normalize } from './normalizer.ts';
export { ALL_SCHEMAS, getSchema } from './schemas.ts';
export type {
  BelegInput,
  BelegSchema,
  BelegTyp,
  FieldMapping,
  MappedField,
  MappingResult,
  Person,
  ValueType,
} from './types.ts';
