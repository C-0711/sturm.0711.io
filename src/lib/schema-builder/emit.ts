/**
 * Builder-Modell → JsonSchema (Mistral-strict-kompatibel).
 *
 * Das emittierte Schema ist `additionalProperties: false` und führt für jedes
 * Object alle benannten Felder als `required` (Mistral akzeptiert nur strict-
 * konforme JSON Schemas).
 */

import type { JsonSchema } from '../mistral-ocr/types.ts';
import type { BuilderConfig, BuilderField, BuilderKind } from './types.ts';

export interface EmittedSchema {
  name: string;
  description?: string;
  schema: JsonSchema;
}

export function toJsonSchema(
  rootName: string,
  rootFields: BuilderField[],
  options: { description?: string } = {},
): EmittedSchema {
  return {
    name: rootName,
    description: options.description,
    schema: objectSchema(rootFields),
  };
}

function objectSchema(fields: BuilderField[]): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((f) => [f.name, fieldToJsonSchema(f)])),
    required: fields.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  };
}

function fieldToJsonSchema(f: BuilderField): JsonSchema {
  switch (f.kind) {
    case 'text': {
      const cfg = f.config.kind === 'text' ? f.config : undefined;
      const out: JsonSchema = { type: 'string' };
      if (f.description) out.description = f.description;
      if (cfg?.minLength !== undefined) out.minLength = cfg.minLength;
      if (cfg?.maxLength !== undefined) out.maxLength = cfg.maxLength;
      if (cfg?.pattern) out.pattern = cfg.pattern;
      return out;
    }
    case 'number':
    case 'integer': {
      const cfg = f.config.kind === f.kind ? (f.config as { minimum?: number; maximum?: number }) : undefined;
      const out: JsonSchema = { type: f.kind };
      if (f.description) out.description = f.description;
      if (cfg?.minimum !== undefined) out.minimum = cfg.minimum;
      if (cfg?.maximum !== undefined) out.maximum = cfg.maximum;
      return out;
    }
    case 'boolean':
    case 'checkbox':
      // Both emit boolean. The post-processor uses ocrBinding to coerce ☑/☐ etc.
      return f.description ? { type: 'boolean', description: f.description } : { type: 'boolean' };
    case 'currency_eur':
      return {
        type: 'number',
        description: enrichDescription(
          f.description,
          'Decimal amount in EUR. Source format: German notation with comma decimal separator (e.g. "1.234,56").',
        ),
      };
    case 'iban':
      return {
        type: 'string',
        format: 'iban',
        description: enrichDescription(
          f.description,
          'IBAN. Strip spaces. Validate against country-specific length and mod-97 checksum.',
        ),
      };
    case 'date_iso':
      return f.description
        ? { type: 'string', format: 'date', description: f.description }
        : { type: 'string', format: 'date' };
    case 'enum':
      if (f.config.kind !== 'enum') throw new Error(`enum field ${f.id}: config.kind mismatch`);
      return f.description
        ? { type: 'string', enum: f.config.values, description: f.description }
        : { type: 'string', enum: f.config.values };
    case 'object':
      return {
        ...(f.description ? { description: f.description } : {}),
        ...objectSchema(f.children ?? []),
      };
    case 'array': {
      if (f.config.kind !== 'array') throw new Error(`array field ${f.id}: config.kind mismatch`);
      const itemKind = f.config.itemKind;
      const itemField = synthItemField(f, itemKind);
      const out: JsonSchema = { type: 'array', items: fieldToJsonSchema(itemField) };
      if (f.description) out.description = f.description;
      return out;
    }
  }
}

function synthItemField(parent: BuilderField, itemKind: Exclude<BuilderKind, 'array'>): BuilderField {
  return {
    id: `${parent.id}-item`,
    name: 'item',
    required: true,
    kind: itemKind,
    config: defaultConfigFor(itemKind),
    children: itemKind === 'object' ? parent.children : undefined,
  };
}

function defaultConfigFor(kind: Exclude<BuilderKind, 'array'>): BuilderConfig {
  switch (kind) {
    case 'enum':
      return { kind: 'enum', values: [] };
    default:
      return { kind } as BuilderConfig;
  }
}

function enrichDescription(user: string | undefined, suffix: string): string {
  return user ? `${user}\n\n${suffix}` : suffix;
}
