import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pdfTextLayerStage } from '../stages/pdf-text-layer.ts';
import type { ApplicationInstance, CaseDocument } from './applications.ts';
import { readManifest } from './inbox.ts';
import type { ArtifactStore, StageLogger } from '../core/types.ts';
import type { AggregateResult } from './aggregation.ts';
import type { BmfSteuerErgebnis } from '../lib/bmf-mcp-client.ts';

const noopLogger: StageLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const noopArtifacts: ArtifactStore = {
  async write() {},
  async writeBuffer() {},
  async read() { throw new Error('fast-path: artifacts.read unsupported'); },
  async readBuffer() { throw new Error('fast-path: artifacts.readBuffer unsupported'); },
  async exists() { return false; },
  absolutePath(p: string) { return p; },
};

export interface FastPdfFacts {
  docTypeHints: string[];
  yearHints: number[];
  preview: string;
  structuredFacts: Record<string, string | number | boolean | null>;
  factsPath: string;
}

export interface FastPdfAnalysisResult {
  ok: boolean;
  kind: 'native-pdf-analysis-v1';
  workspaceId: string;
  filename: string;
  sha256: string;
  mimeType: string | null;
  hasTextLayer: boolean;
  chars: number;
  pageCount: number;
  ms: number;
  analyzedAt: string;
  artifactDir: string;
  analysisPath: string;
  textPath: string;
  facts: FastPdfFacts;
}

export interface FastAuditResult {
  ok: boolean;
  kind: 'fast-audit-v1';
  mode: 'aggregate-direct';
  workspaceId: string;
  jahr: number;
  ms: number;
  masterPath: string | null;
  output: Record<string, unknown>;
  extractionWorkflowId: string;
}

export interface FastCaseFactsResult {
  ok: boolean;
  kind: 'fast-case-facts-v1';
  workspaceId: string;
  caseFactsPath: string;
  documentsWithFastPath: number;
  docTypeHints: string[];
  yearHints: number[];
  documents: Array<{
    runId: string;
    filename: string;
    sha256: string;
    hasTextLayer: boolean;
    chars: number;
    pageCount: number;
    docTypeHints: string[];
    yearHints: number[];
    preview: string;
    factsPath: string;
    structuredFacts: Record<string, string | number | boolean | null>;
  }>;
}

function workspaceAbs(rootCwd: string, inst: ApplicationInstance): string {
  return path.isAbsolute(inst.workspacePath)
    ? inst.workspacePath
    : path.join(rootCwd, inst.workspacePath);
}

function workspaceIdOf(inst: ApplicationInstance): string {
  return path.basename(inst.workspacePath);
}

const DOC_TYPE_HINTS: Array<{ id: string; re: RegExp }> = [
  { id: 'lohnsteuerbescheinigung', re: /lohnsteuerbescheinigung|bruttoarbeitslohn|steuerklasse/iu },
  { id: 'rentenbezugsmitteilung', re: /rentenbezugsmitteilung|rentenleistung|rentenanpassungsbetrag/iu },
  { id: 'kapitalertragsbescheinigung', re: /kapitalerträge|freistellungsauftrag|steuerbescheinigung/iu },
  { id: 'steuerbescheid_einkommen', re: /einkommensteuerbescheid|festgesetzt|zu versteuerndes einkommen/iu },
  { id: 'elster_einkommensteuererklaerung', re: /einkommensteuererklärung|hauptvordruck|mantelbogen|est\s*1a/iu },
  { id: 'haushaltsnahe_dienstleistungen', re: /haushaltsnahe dienstleistungen|handwerkerleistungen|§\s*35a/iu },
  { id: 'beitragsbescheinigung_kranken_p', re: /krankenversicherung|pflegeversicherung|basisabsicherung/iu },
  { id: 'zinsbescheinigung_wohndarlehen', re: /zinsbescheinigung|schuldzinsen|wohndarlehen/iu },
];

function normalizedPreview(text: string, maxLen = 280): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1)}…`;
}

function inferDocTypeHints(text: string): string[] {
  const out: string[] = [];
  for (const rule of DOC_TYPE_HINTS) {
    if (rule.re.test(text)) out.push(rule.id);
  }
  return out;
}


function parseGermanLooseNumber(raw: string): number | null {
  const s = raw.replace(/\s+/g, '').replace(/\./g, '').replace(',', '.').trim();
  if (!s || !/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractStructuredFacts(text: string, docTypeHints: string[]): Record<string, string | number | boolean | null> {
  const facts: Record<string, string | number | boolean | null> = {};

  const idNr = text.match(/Identifikationsnummer\s*:?\s*([0-9 ]{8,})/iu)?.[1]?.replace(/\s+/g, '') ?? null;
  if (idNr) facts.identifikationsnummer = idNr;

  const vz = text.match(/Veranlagungszeitraum\s*:?\s*((?:19|20)\d{2})/iu)?.[1];
  if (vz) facts.veranlagungszeitraum = Number(vz);

  const meldejahr = text.match(/Meldejahr\s*((?:19|20)\d{2})/iu)?.[1];
  if (meldejahr) facts.meldejahr = Number(meldejahr);

  if (docTypeHints.includes('kapitalertragsbescheinigung')) {
    const betrag = text.match(/Freigestellte Kapitalerträge[\s\S]{0,240}?Betrag\s+([0-9][0-9\.,]*)/iu)?.[1] ?? null;
    const eur = betrag ? parseGermanLooseNumber(betrag) : null;
    if (eur !== null) facts.freigestellte_kapitalertraege_eur = eur;
    facts.freistellungsauftrag = /freistellungsauftrag/iu.test(text);
  }

  return facts;
}

function inferYearHints(text: string): number[] {
  const prioritized = new Set<number>();
  const generic = new Set<number>();

  const explicitPatterns = [
    /veranlagungszeitraum\s*[:\-]?\s*((?:19|20)\d{2})/giu,
    /steuerjahr\s*[:\-]?\s*((?:19|20)\d{2})/giu,
    /einkommensteuer(?:erklärung|bescheid)?\s+(?:für|202?\s*|v(?:om)?\s*)?((?:19|20)\d{2})/giu,
    /bescheinigung\s+für\s+((?:19|20)\d{2})/giu,
  ];
  for (const re of explicitPatterns) {
    for (const m of text.matchAll(re)) {
      const y = Number(m[1]);
      if (y >= 1990 && y <= 2035) prioritized.add(y);
    }
  }
  if (prioritized.size > 0) return [...prioritized].sort((a, b) => a - b).slice(0, 4);

  for (const m of text.matchAll(/(?:19|20)\d{2}/g)) {
    const y = Number(m[0]);
    if (y >= 1990 && y <= 2035) generic.add(y);
  }
  return [...generic].sort((a, b) => a - b).slice(0, 6);
}

async function inferExtractionWorkflowId(
  rootCwd: string,
  inst: ApplicationInstance,
): Promise<string | null> {
  const runIds = (inst.runs ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (runIds.length === 0) return null;
  const runsRoot = path.join(rootCwd, 'runs');
  const workflowNames = await fs.readdir(runsRoot).catch(() => [] as string[]);
  const matches = new Set<string>();
  for (const workflowName of workflowNames) {
    for (const runId of runIds) {
      try {
        await fs.access(path.join(runsRoot, workflowName, runId));
        matches.add(workflowName);
      } catch {}
    }
  }
  if (matches.size === 1) return [...matches][0]!;
  return null;
}


export async function materializeFastCaseFacts(
  rootCwd: string,
  inst: ApplicationInstance,
): Promise<FastCaseFactsResult> {
  const manifest = await readManifest(rootCwd, inst);
  const workspaceId = workspaceIdOf(inst);
  const wsAbs = workspaceAbs(rootCwd, inst);
  const artifactDir = path.join(wsAbs, 'fast-path');
  await fs.mkdir(artifactDir, { recursive: true });
  const caseFactsPath = path.join(artifactDir, 'case-facts.json');

  const documents = (manifest.documents ?? [])
    .filter((doc): doc is typeof doc & { fastPath: NonNullable<typeof doc.fastPath> } => !!doc.fastPath)
    .map((doc) => ({
      runId: doc.runId,
      filename: doc.filename,
      sha256: doc.sha256,
      hasTextLayer: doc.fastPath.hasTextLayer,
      chars: doc.fastPath.chars,
      pageCount: doc.fastPath.pageCount,
      docTypeHints: doc.fastPath.docTypeHints,
      yearHints: doc.fastPath.yearHints,
      preview: doc.fastPath.preview,
      factsPath: doc.fastPath.factsPath,
      structuredFacts: doc.fastPath.structuredFacts ?? {},
    }));

  const docTypeHints = [...new Set(documents.flatMap((doc) => doc.docTypeHints))].sort();
  const yearHints = [...new Set(documents.flatMap((doc) => doc.yearHints))].sort((a, b) => a - b);

  const out: FastCaseFactsResult = {
    ok: true,
    kind: 'fast-case-facts-v1',
    workspaceId,
    caseFactsPath,
    documentsWithFastPath: documents.length,
    docTypeHints,
    yearHints,
    documents,
  };

  await fs.writeFile(caseFactsPath, JSON.stringify(out, null, 2), 'utf-8');
  return out;
}

async function computeAggregateAudit(
  rootCwd: string,
  inst: ApplicationInstance,
  extractionWorkflowId: string,
): Promise<Record<string, unknown>> {
  const { aggregateCase } = await import('./aggregation.ts');
  const { BmfMcpClient, canonicalLayerToElsterFelder } = await import('../lib/bmf-mcp-client.ts');

  const agg = await aggregateCase(inst, {
    runsDir: path.join(rootCwd, 'runs'),
    extractionWorkflowId,
  });

  let bmf: BmfSteuerErgebnis | { erfolg: false; reason: string; message: string; cause: unknown } | null = null;
  if (Object.keys(agg.merged_layer).length > 0) {
    try {
      const felder = canonicalLayerToElsterFelder(
        Object.fromEntries(
          Object.entries(agg.merged_layer).map(([k, v]) => [
            k,
            {
              value: v.value,
              normalized: v.normalized,
              normalizedNumber: (v as { normalizedNumber?: number }).normalizedNumber,
              datentyp: (v.datentyp as 'string' | 'date' | 'currency') ?? 'string',
              trust: (v as { trust?: 'high' | 'medium' | 'low' | 'suspicious' }).trust,
              origin: (v as { origin?: string }).origin,
            },
          ]),
        ),
      );
      const client = new BmfMcpClient({ timeoutMs: 15_000 });
      bmf = await client.berechneVollstaendigeSteuerV2({
        erklaerungsjahr: inst.veranlagungsjahr ?? new Date().getFullYear(),
        elster_felder: felder,
      });
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      const cause = e.cause instanceof Error ? e.cause.message : e.cause;
      bmf = {
        erfolg: false,
        reason: 'mcp-error',
        message: e.message,
        cause: cause ?? null,
      };
    }
  }

  return {
    ...agg,
    bmf,
    audit_source: 'aggregate-direct',
  } as Record<string, unknown>;
}

export async function analyzeFastPdfUpload(
  rootCwd: string,
  inst: ApplicationInstance,
  doc: CaseDocument,
): Promise<FastPdfAnalysisResult> {
  const wsAbs = workspaceAbs(rootCwd, inst);
  const sourcePath = path.join(wsAbs, doc.inboxPath);
  const artifactDir = path.join(wsAbs, 'fast-path', doc.sha256);
  await fs.mkdir(artifactDir, { recursive: true });

  const ctrl = new AbortController();
  const out = await pdfTextLayerStage.run(
    { filePath: sourcePath, filename: doc.filename },
    {
      runId: `fast-${Date.now().toString(36)}`,
      workflowId: 'fast-path',
      stageId: 'extract/pdf-text-layer',
      config: { layout: true },
      logger: noopLogger,
      artifacts: noopArtifacts,
      emit() {},
      signal: ctrl.signal,
      results: {},
      tools: {} as never,
    },
  );

  const textPath = path.join(artifactDir, 'text.txt');
  const analysisPath = path.join(artifactDir, 'analysis.json');
  const factsPath = path.join(artifactDir, 'facts.json');
  const analyzedAt = new Date().toISOString();
  const docTypeHints = inferDocTypeHints(out.text ?? '');
  const facts: FastPdfFacts = {
    docTypeHints,
    yearHints: inferYearHints(out.text ?? ''),
    preview: normalizedPreview(out.text ?? ''),
    structuredFacts: extractStructuredFacts(out.text ?? '', docTypeHints),
    factsPath,
  };
  const summary: FastPdfAnalysisResult = {
    ok: true,
    kind: 'native-pdf-analysis-v1',
    workspaceId: workspaceIdOf(inst),
    filename: doc.filename,
    sha256: doc.sha256,
    mimeType: doc.mimeType ?? null,
    hasTextLayer: out.hasTextLayer,
    chars: out.chars,
    pageCount: out.pages.length,
    ms: out.ms,
    analyzedAt,
    artifactDir,
    analysisPath,
    textPath,
    facts,
  };

  await fs.writeFile(textPath, out.text ?? '', 'utf-8');
  await fs.writeFile(factsPath, JSON.stringify({ ...facts, analyzedAt, filename: doc.filename, sha256: doc.sha256 }, null, 2), 'utf-8');
  await fs.writeFile(analysisPath, JSON.stringify({ ...summary, pages: out.pages }, null, 2), 'utf-8');
  return summary;
}

export async function runFastAudit(
  rootCwd: string,
  inst: ApplicationInstance,
): Promise<FastAuditResult> {
  const workspaceId = workspaceIdOf(inst);
  const jahr = inst.veranlagungsjahr ?? new Date().getFullYear();
  const extractionWorkflowId = inst.extractionWorkflow ?? await inferExtractionWorkflowId(rootCwd, inst);
  if (!extractionWorkflowId) {
    throw new Error('fast audit blocked: extractionWorkflow fehlt am Fall und konnte nicht aus Runs abgeleitet werden');
  }
  if (!inst.runs || inst.runs.length === 0) {
    throw new Error('fast audit blocked: keine vorhandenen Extraction-Runs am Fall');
  }

  const t0 = Date.now();
  const output = await computeAggregateAudit(rootCwd, inst, extractionWorkflowId);

  return {
    ok: true,
    kind: 'fast-audit-v1',
    mode: 'aggregate-direct',
    workspaceId,
    jahr,
    ms: Date.now() - t0,
    masterPath: null,
    output,
    extractionWorkflowId,
  };
}
