/**
 * Schema-Builder — internes Modell.
 *
 * Bildet eine Tree-with-IDs-Struktur ab, die per `toJsonSchema` in den
 * `JsonSchema`-Typ aus `lib/mistral-ocr` übersetzt wird. Genau dasselbe Modell
 * versorgt sowohl `documentAnnotation` als auch `bboxAnnotation` (zwei
 * Mount-Points, eine Komponente).
 *
 * IDs sind stabil — sie überleben Umbenennungen und Reorder, was Drag-&-Drop
 * und Undo/Redo trivial macht.
 */

export interface BuilderField {
  /** Stable ID; survives renames. */
  id: string;
  /** Field name in the emitted JSON. JS-identifier rules. */
  name: string;
  description?: string;
  required: boolean;
  /** STURM-extended kind space — maps to JSON-Schema primitives at emit time. */
  kind: BuilderKind;
  config: BuilderConfig;
  /** Children for `object`, or item-children for `array<object>`. */
  children?: BuilderField[];
  /** OCR-aware coercion binding for the post-processor. */
  ocrBinding?: OcrBinding;
}

export type BuilderKind =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'checkbox'         // emits boolean; post-processor coerces ☑/☐
  | 'currency_eur'     // emits number; post-processor parses German "1.234,56"
  | 'iban'             // emits string; format hint
  | 'date_iso'
  | 'enum'
  | 'object'
  | 'array';

export type BuilderConfig =
  | { kind: 'text'; minLength?: number; maxLength?: number; pattern?: string }
  | { kind: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { kind: 'boolean' }
  | { kind: 'checkbox' }
  | { kind: 'currency_eur' }
  | { kind: 'iban' }
  | { kind: 'date_iso' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'object' }
  | { kind: 'array'; itemKind: Exclude<BuilderKind, 'array'> };

/**
 * OCR-aware binding: tells the post-processor how to coerce / validate the
 * model's output for this field. Independent of JSON Schema — the schema only
 * tells Mistral what shape to produce; this turns "1.234,56" into 1234.56.
 */
export type OcrBinding =
  | { type: 'checkbox'; truthySymbols?: string[]; falsySymbols?: string[] }
  | { type: 'amount'; locale: 'de-DE' | 'en-US'; currency: 'EUR' | 'USD' }
  | { type: 'iban'; country?: string }
  | { type: 'tax_id'; country: 'DE' }
  | { type: 'elster_anlage'; expected?: string };
