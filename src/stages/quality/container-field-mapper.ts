/**
 * Container-Field-Mapper — decorates an extracted object with canonical
 * eCode metadata from the ELSTER container.
 *
 * For every leaf in the extraction, looks up the matching atom (by drucktext
 * fuzzy match + per-doc-class bridge) and attaches sibling metadata keys:
 *
 *   bruttoarbeitslohn: 69291.8
 *   _ecode_bruttoarbeitslohn: "E0200201"
 *   _meta_bruttoarbeitslohn: { drucktext, anlage, vordruckzeile, datentyp,
 *                              formatRegex, pflicht, anleitung }
 *
 * Downstream Span-Linker / Cross-Validator / Critic read these to drive
 * type-aware normalization, format-validation, and legal citation.
 */
import { defineStage } from '../../core/stage.ts';
import {
  resolveAllLeaves,
  type FieldResolution,
} from '../../lib/quality/container-field-resolver.ts';

export interface ContainerFieldMapperInput {
  extracted: unknown;
  /** Optional doc-class hint (e.g. "lohnsteuerbescheinigung") — drives bridge lookup. */
  dokumenttyp_id?: string;
  /** Optional Anlage filter (e.g. "N") — restricts candidates to one Anlage. */
  anlageHint?: string;
}

export interface FieldMetaSummary {
  ecode: string;
  drucktext: string;
  anlage: string;
  vordruckzeile: string;
  datentyp: string;
  formatRegex: string | null;
  pflicht: boolean;
  /** Where the atom was sourced from — for audit / citation. */
  anleitung: { document: string; section: string };
  /** How the resolver matched the leaf (bridge / drucktext / substring …) */
  matchMethod: string;
  matchConfidence: number;
}

export interface ContainerFieldMapperOutput {
  /** Original extraction + `_ecode_<leaf>` and `_meta_<leaf>` siblings. */
  extracted_with_codes: unknown;
  /** Flat map: dotted-leaf-path → meta summary (or null if unmapped). */
  field_meta: Record<string, FieldMetaSummary | null>;
  /** Count of leaves successfully mapped to atoms. */
  mapped_count: number;
  /** Count of leaves that could not be mapped — useful for catalog-gap reports. */
  unmapped_paths: string[];
  /** Coverage = mapped / total. */
  coverage: number;
  /** Echoed for downstream stages. */
  extracted: unknown;
  ms: number;
}

export interface ContainerFieldMapperConfig {
  dokumenttyp_id?: string;
  anlageHint?: string;
}

function lastSegment(path: string): string {
  const dot = path.lastIndexOf('.');
  const bracket = path.lastIndexOf('[');
  const cut = Math.max(dot, bracket);
  return cut >= 0 ? path.slice(cut + 1).replace(/[\]]/g, '') : path;
}

/** Walk the object tree and attach sibling _ecode_<key> / _meta_<key> entries. */
function decorate(node: unknown, prefix: string, resolutions: Record<string, FieldResolution | null>): unknown {
  if (node == null) return node;
  if (Array.isArray(node)) {
    return node.map((v, i) => decorate(v, prefix ? `${prefix}[${i}]` : `[${i}]`, resolutions));
  }
  if (typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.startsWith('_')) { out[k] = v; continue; }
      const childPath = prefix ? `${prefix}.${k}` : k;
      out[k] = decorate(v, childPath, resolutions);
      // Attach sibling meta keys at leaf level.
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        const r = resolutions[childPath];
        if (r) {
          out[`_ecode_${k}`] = r.atom.field_name;
          out[`_meta_${k}`] = {
            drucktext: r.atom.metadata.drucktext,
            anlage: r.atom.metadata.anlage,
            vordruckzeile: r.atom.metadata.vordruckzeile,
            datentyp: r.atom.metadata.datentyp,
            formatRegex: r.atom.metadata.formatRegex,
            pflicht: r.atom.metadata.pflicht,
            anleitung: {
              document: r.atom.citation_document,
              section: r.atom.citation_section,
            },
            matchMethod: r.matchMethod,
            matchConfidence: Number(r.confidence.toFixed(3)),
          };
        }
      }
    }
    return out;
  }
  return node;
}

export const containerFieldMapperStage = defineStage<ContainerFieldMapperInput, ContainerFieldMapperOutput, ContainerFieldMapperConfig>({
  id: 'quality/container-field-mapper',
  name: 'Container-Field-Mapper — eCode + Anleitung decoration',
  description:
    'Mappt jeden extrahierten Leaf-Wert auf seinen kanonischen eCode aus dem ' +
    'ELSTER-Container und hängt _ecode_<key> + _meta_<key> Geschwister-Einträge an ' +
    '(drucktext, anlage, vordruckzeile, datentyp, formatRegex, pflicht, BMF-Quelle). ' +
    'Downstream Span-Linker/Cross-Validator/Critic nutzen das für typ-aware Logik ' +
    'und Gesetzesverweise.',
  hints: {
    inputs: 'extracted (nested-json) · optional: dokumenttyp_id, anlageHint',
    outputs: 'extracted_with_codes (nested-json mit _ecode/_meta), field_meta (flat path→summary), mapped_count, unmapped_paths[], coverage, extracted (echoed)',
    configExample: '{"dokumenttyp_id": "lohnsteuerbescheinigung", "anlageHint": "N"}',
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'extracted', type: 'nested-json' },
      { name: 'dokumenttyp_id', type: 'string', description: 'Bridge-lookup key' },
    ],
    outputPorts: [
      { name: 'extracted_with_codes', type: 'nested-json' },
      { name: 'field_meta', type: 'json' },
      { name: 'coverage', type: 'number' },
      { name: 'extracted', type: 'nested-json', description: 'Echoed for downstream' },
    ],
  },

  async run(input, ctx) {
    if (!input?.extracted) throw new Error('container-field-mapper: input.extracted fehlt');
    const t0 = Date.now();
    const cfg = ctx.config ?? ({} as ContainerFieldMapperConfig);
    const dokumenttyp_id = input.dokumenttyp_id ?? cfg.dokumenttyp_id;
    const anlageHint = input.anlageHint ?? cfg.anlageHint;

    const resolutions = await resolveAllLeaves(input.extracted, { dokumenttyp_id, anlageHint });
    const decorated = decorate(input.extracted, '', resolutions);

    const fieldMeta: Record<string, FieldMetaSummary | null> = {};
    const unmapped: string[] = [];
    let mapped = 0;
    for (const [path, r] of Object.entries(resolutions)) {
      if (r) {
        mapped += 1;
        fieldMeta[path] = {
          ecode: r.atom.field_name,
          drucktext: r.atom.metadata.drucktext,
          anlage: r.atom.metadata.anlage,
          vordruckzeile: r.atom.metadata.vordruckzeile,
          datentyp: r.atom.metadata.datentyp,
          formatRegex: r.atom.metadata.formatRegex,
          pflicht: r.atom.metadata.pflicht,
          anleitung: {
            document: r.atom.citation_document,
            section: r.atom.citation_section,
          },
          matchMethod: r.matchMethod,
          matchConfidence: Number(r.confidence.toFixed(3)),
        };
      } else {
        unmapped.push(path);
        fieldMeta[path] = null;
      }
    }
    const total = mapped + unmapped.length;
    const coverage = total === 0 ? 1 : mapped / total;

    const ms = Date.now() - t0;
    ctx.emit('container_field_mapper_done', { ms, mapped, unmapped: unmapped.length, coverage });

    return {
      extracted_with_codes: decorated,
      field_meta: fieldMeta,
      mapped_count: mapped,
      unmapped_paths: unmapped,
      coverage,
      extracted: input.extracted,
      ms,
    };
  },
});
