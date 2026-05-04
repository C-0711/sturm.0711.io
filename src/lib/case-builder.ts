/**
 * Workspace consolidation: ALL data from ALL approved documents in ONE
 * structured JSON. No mapping logic, no buckets, no domain interpretation.
 *
 * Structure:
 *   - workspace: id/name/createdAt
 *   - documents[]: every approved doc with its raw classification + annotation
 *   - merged: every (key, value) tuple from across all docs, deduped
 *             by normalized value, with provenance (which doc, kpi or annotation)
 *
 * Pure projection. Currency/date values are normalized to canonical forms
 * (floats / ISO) so duplicates collapse cleanly.
 */

import type { DocumentMeta } from '../server/workspaces.ts';

export interface ConsolidatedJson {
  workspace?: { id: string; name: string; createdAt?: string };
  approvedCount: number;
  totalCount: number;
  generatedAt: string;
  documents: Array<{
    uuid: string;
    dateiname: string;
    mime: string;
    klassifikation?: {
      label?: string;
      summary?: string;
      confidence?: number;
      kpiCount: number;
      ms?: number;
      tokens?: number;
      /** Phase B controlled-vocabulary triple, resolved at classify-time. */
      templateId?: string;
      folderSlug?: string;
      displayName?: string;
    };
    template?: { id?: string; name?: string };
    extraktion?: {
      pages?: number;
      chars?: number;
      hasAnnotation: boolean;
    };
    approvedAt?: string;
    approved: boolean;
  }>;
  /** Every value collected across all documents. Deduplicated by (path, normalizedValue). */
  values: Array<{
    pfad: string;          // KPI key OR dotted annotation path
    wert: string;          // raw textual form (first occurrence)
    wertNormalisiert?: string | number; // normalized canonical form
    quelle: 'kpi' | 'annotation';
    herkunft?: string;     // KPI provenance (mistral / claude / manual / rescue)
    belege: Array<{        // every doc this (path, value) was seen in
      uuid: string;
      dateiname: string;
      /** Phase H: pointer auf die Quelle im OCR-Text (nur für quelle='kpi' wenn citation generiert). */
      citation?: {
        page?: number;
        charOffset: number;
        length: number;
        evidence: string;
        confidence: 'verbatim' | 'normalized' | 'partial';
        matchedText: string;
      } | null;
    }>;
  }>;
}

// ---------- value normalization (just format, no semantic) ----------

function normalizeValue(v: unknown): { canonical: string | number; display: string } {
  if (v == null) return { canonical: '', display: '' };
  const s = String(v).trim();
  if (!s) return { canonical: '', display: '' };

  // ISO date already canonical
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { canonical: s, display: s };
  // DE date → ISO canonical, keep display as-is
  const de = s.match(/^(\d{2})\.(\d{2})\.((?:19|20)\d{2})$/);
  if (de) return { canonical: `${de[3]}-${de[2]}-${de[1]}`, display: s };

  // Currency with cents: 69.291,80 € → 69291.80
  if (/^-?\d{1,3}(\.\d{3})*,\d{2}\s?(€|EUR)?$/i.test(s)) {
    const num = parseFloat(s.replace(/€|EUR|\s/gi, '').replace(/\./g, '').replace(',', '.'));
    return { canonical: Number.isFinite(num) ? num : s, display: s };
  }
  // Currency with explicit € on integer
  if (/^-?\d{1,6}\s?(€|EUR)$/i.test(s)) {
    const num = parseFloat(s.replace(/€|EUR|\s/gi, ''));
    return { canonical: Number.isFinite(num) ? num : s, display: s };
  }
  // Bare integer that looks numeric
  if (/^-?\d+$/.test(s)) {
    return { canonical: parseInt(s, 10), display: s };
  }
  // IBAN: strip whitespace
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s.replace(/\s/g, ''))) {
    return { canonical: s.replace(/\s/g, ''), display: s };
  }
  return { canonical: s, display: s };
}

// ---------- flatten annotation tree to dotted-path leaves ----------

function flatten(node: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flatten(v, path ? `${path}.${k}` : k, out);
    }
    return;
  }
  const s = typeof node === 'string' ? node.trim() : String(node);
  if (s) out.push({ path: path || '', value: s });
}

// ---------- main consolidator ----------

export function buildCase(approvedDocs: DocumentMeta[]): ConsolidatedJson {
  const generatedAt = new Date().toISOString();

  // Build a value map keyed by `${path}::${normalized}` so identical values
  // across multiple docs collapse into one entry with multiple belege.
  const valueMap = new Map<string, ConsolidatedJson['values'][number]>();

  function record(args: {
    pfad: string;
    wert: string;
    quelle: 'kpi' | 'annotation';
    herkunft?: string;
    doc: DocumentMeta;
    /** Phase H: optional citation für diesen spezifischen Wert in diesem Doc. */
    citation?: ConsolidatedJson['values'][number]['belege'][number]['citation'];
  }) {
    const norm = normalizeValue(args.wert);
    const dedupeKey = `${args.pfad}::${norm.canonical}`;
    const existing = valueMap.get(dedupeKey);
    if (existing) {
      // Add this doc to belege if not already there
      if (!existing.belege.some((b) => b.uuid === args.doc.uuid)) {
        existing.belege.push({
          uuid: args.doc.uuid,
          dateiname: args.doc.originalFilename,
          citation: args.citation,
        });
      }
      return;
    }
    valueMap.set(dedupeKey, {
      pfad: args.pfad,
      wert: norm.display,
      wertNormalisiert: norm.canonical !== norm.display ? norm.canonical : undefined,
      quelle: args.quelle,
      herkunft: args.herkunft,
      belege: [{
        uuid: args.doc.uuid,
        dateiname: args.doc.originalFilename,
        citation: args.citation,
      }],
    });
  }

  const documents: ConsolidatedJson['documents'] = [];

  for (const doc of approvedDocs) {
    documents.push({
      uuid: doc.uuid,
      dateiname: doc.originalFilename,
      mime: doc.mime,
      klassifikation: doc.classification ? {
        label: doc.classification.label,
        summary: doc.classification.summary,
        confidence: doc.classification.confidence,
        kpiCount: doc.classification.kpis?.length ?? 0,
        ms: doc.classification.ms,
        tokens: doc.classification.mistralUsage?.total_tokens,
        templateId: doc.classification.templateId,
        folderSlug: doc.classification.folderSlug,
        displayName: doc.classification.displayName,
      } : undefined,
      template: doc.template ? { id: doc.template.id, name: doc.template.name } : undefined,
      extraktion: doc.extraction ? {
        pages: doc.extraction.pages,
        chars: doc.extraction.chars,
        hasAnnotation: !!doc.extraction.annotation,
      } : undefined,
      approvedAt: doc.approvedAt,
      approved: !!doc.approvedAt,
    });

    // Pull every KPI
    for (const kpi of doc.classification?.kpis ?? []) {
      record({
        pfad: kpi.key,
        wert: kpi.value,
        quelle: 'kpi',
        herkunft: kpi.from ?? 'mistral',
        doc,
        citation: (kpi as { citation?: ConsolidatedJson['values'][number]['belege'][number]['citation'] }).citation,
      });
    }
    // Pull every annotation leaf
    if (doc.extraction?.annotation) {
      const leaves: Array<{ path: string; value: string }> = [];
      flatten(doc.extraction.annotation, '', leaves);
      for (const leaf of leaves) {
        record({ pfad: leaf.path, wert: leaf.value, quelle: 'annotation', doc });
      }
    }
  }

  // Sort values: by path alphabetically, then numeric values first within same path
  const values = [...valueMap.values()].sort((a, b) => {
    if (a.pfad !== b.pfad) return a.pfad.localeCompare(b.pfad);
    return String(a.wert).localeCompare(String(b.wert));
  });

  return {
    approvedCount: approvedDocs.length,
    totalCount: 0, // filled by caller (knows total)
    generatedAt,
    documents,
    values,
  };
}
