/**
 * Orchestrator-Werkzeugkatalog.
 *
 * Definiert die ~10 Tools, die der Gemma-4 Steuerassistent ueber Tool-Use
 * aufrufen kann. Jeder Eintrag tragt:
 *   - `name`         — deutscher Tool-Bezeichner (LLM ruft per Name auf)
 *   - `description`  — kurze deutsche Beschreibung fuer den LLM
 *   - `inputSchema`  — JSON-Schema (OpenAI-tool-Schema-kompatibel)
 *   - `handler`      — async Funktion, die das tatsaechliche Tool ausfuehrt
 *
 * Handler arbeiten ueber `OrchestratorHandlerCtx` direkt mit den File-
 * basierten Application-Stores + dem `ToolContainer` der Anwendung — kein
 * zusaetzlicher interner HTTP-Hop.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ApplicationInstance,
  loadInstanceFile,
  saveInstanceFile,
  instanceFilePath,
} from './applications.ts';
import { readManifest, computeTrustBreakdown } from './inbox.ts';
import { getApplication } from '../core/registry.ts';
import { getToolContainer } from '../core/tools/tool-container.ts';
import type { RagIndexHandle } from '../core/tools/handles.ts';

/** Pro Tool-Aufruf bereitgestellter Kontext (Pfade, AppId, RootCwd). */
export interface OrchestratorHandlerCtx {
  appId: string;
  applicationsDir: string;
  runsDir: string;
  rootCwd: string;
  /** Aktuell selektierter Fall — kann vom LLM ueberschrieben werden. */
  caseIdHint?: string;
}

/** Ergebnis-Shape: alles strukturierte JSON, das der LLM als
 *  `role: tool` Message zurueckbekommt. */
export type OrchestratorToolResult = Record<string, unknown> | { error: string };

export interface OrchestratorTool {
  name: string;
  description: string;
  /** OpenAI-tool-input-schema (`type: 'object'`, properties, required). */
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: OrchestratorHandlerCtx) => Promise<OrchestratorToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function resolveCaseId(args: Record<string, unknown>, ctx: OrchestratorHandlerCtx): string | null {
  const fromArgs = typeof args.caseId === 'string' && args.caseId.length > 0 ? args.caseId : null;
  return fromArgs ?? ctx.caseIdHint ?? null;
}

async function readJsonSafe<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function listInstances(ctx: OrchestratorHandlerCtx): Promise<ApplicationInstance[]> {
  const dir = path.join(ctx.applicationsDir, ctx.appId);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const items: ApplicationInstance[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const inst = await readJsonSafe<ApplicationInstance>(path.join(dir, f));
    if (inst) items.push(inst);
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

/** Laedt die "rich" canonical_layer-Map aus dem letzten extraction-Run.
 *  Priorisiert phase6BmfRechner, dann phase5Merge, dann phase7Validator. */
async function loadLatestCanonicalLayer(
  inst: ApplicationInstance,
  ctx: OrchestratorHandlerCtx,
): Promise<{ runId: string | null; layer: Record<string, unknown> | null; source: string | null }> {
  if (inst.runs.length === 0) return { runId: null, layer: null, source: null };
  const app = getApplication(ctx.appId);
  const extractionId = app?.workflows.extraction;
  if (!extractionId) return { runId: null, layer: null, source: null };
  const lastRunId = inst.runs[inst.runs.length - 1];
  const runDir = path.join(ctx.runsDir, extractionId, lastRunId);
  const bmfOut = await readJsonSafe<{ canonical_layer?: Record<string, unknown> }>(
    path.join(runDir, 'phase6BmfRechner', 'output.json'),
  );
  if (bmfOut?.canonical_layer && Object.keys(bmfOut.canonical_layer).length > 0) {
    return { runId: lastRunId, layer: bmfOut.canonical_layer, source: 'phase6BmfRechner' };
  }
  const mergeOut = await readJsonSafe<{ canonical_layer?: Record<string, unknown> }>(
    path.join(runDir, 'phase5Merge', 'output.json'),
  );
  if (mergeOut?.canonical_layer && Object.keys(mergeOut.canonical_layer).length > 0) {
    return { runId: lastRunId, layer: mergeOut.canonical_layer, source: 'phase5Merge' };
  }
  const validatorOut = await readJsonSafe<{ canonicalLayer?: { codes?: Record<string, unknown> } }>(
    path.join(runDir, 'phase7Validator', 'output.json'),
  );
  if (validatorOut?.canonicalLayer?.codes) {
    return { runId: lastRunId, layer: validatorOut.canonicalLayer.codes, source: 'phase7Validator-flat' };
  }
  return { runId: lastRunId, layer: null, source: null };
}

async function loadBmfResult(
  inst: ApplicationInstance,
  ctx: OrchestratorHandlerCtx,
): Promise<{ runId: string | null; bmf: Record<string, unknown> | null }> {
  if (inst.runs.length === 0) return { runId: null, bmf: null };
  const app = getApplication(ctx.appId);
  const extractionId = app?.workflows.extraction;
  if (!extractionId) return { runId: null, bmf: null };
  const lastRunId = inst.runs[inst.runs.length - 1];
  const runDir = path.join(ctx.runsDir, extractionId, lastRunId);
  const bmfOut = await readJsonSafe<Record<string, unknown>>(
    path.join(runDir, 'phase6BmfRechner', 'output.json'),
  );
  return { runId: lastRunId, bmf: bmfOut };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool-Katalog
// ─────────────────────────────────────────────────────────────────────────

export const ORCHESTRATOR_TOOLS: OrchestratorTool[] = [
  {
    name: 'liste_faelle',
    description:
      'Liste aller offenen Steuerfaelle (Anwendung steuerfall-est). Liefert caseId, ' +
      'displayName, status, veranlagungsjahr, sealedAt und die Anzahl Dokumente.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const items = await listInstances(ctx);
      return {
        count: items.length,
        faelle: items.map((i) => ({
          caseId: i.caseId,
          displayName: i.displayName,
          mandantId: i.mandantId,
          veranlagungsjahr: i.veranlagungsjahr ?? null,
          status: i.status,
          documents: i.documents?.length ?? 0,
          runs: i.runs.length,
          sealedAt: i.sealedAt ?? null,
          exportedAt: i.exportedAt ?? null,
          updatedAt: i.updatedAt,
        })),
      };
    },
  },

  {
    name: 'fall_status',
    description:
      'Status eines Falls: Lifecycle-Stage, Anzahl Runs, Anzahl Dokumente, ' +
      'sealedAt/exportedAt, einreichungsId. Pflichtargument caseId.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string', description: 'caseId aus liste_faelle' } },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      return {
        caseId: inst.caseId,
        displayName: inst.displayName,
        mandantId: inst.mandantId,
        veranlagungsjahr: inst.veranlagungsjahr ?? null,
        status: inst.status,
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
        runsCount: inst.runs.length,
        documentsCount: inst.documents?.length ?? 0,
        sealedAt: inst.sealedAt ?? null,
        exportedAt: inst.exportedAt ?? null,
        sealCommitSha: inst.sealCommitSha ?? null,
        einreichungsId: inst.einreichungsId ?? null,
      };
    },
  },

  {
    name: 'fall_dokumente',
    description:
      'Liefert die Dokumente eines Falls aus der Inbox samt trustBreakdown ' +
      '(high/medium/suspicious/low) und erkannten Anlagen pro Dokument.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string' } },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      let manifest;
      try {
        manifest = await readManifest(ctx.rootCwd, inst);
      } catch (e) {
        return { error: `Inbox-Manifest nicht lesbar: ${(e as Error).message}` };
      }
      return {
        caseId,
        count: manifest.documents.length,
        documents: manifest.documents.map((d) => ({
          filename: d.filename,
          uploadedAt: d.uploadedAt,
          size: d.size,
          mimeType: d.mimeType ?? null,
          sha256: d.sha256.slice(0, 12),
          anlagen: d.anlagen ?? [],
          fieldsExtracted: d.fieldsExtracted ?? null,
          trustBreakdown: d.trustBreakdown ?? null,
          runId: d.runId,
        })),
      };
    },
  },

  {
    name: 'auswertung',
    description:
      'BMF-Auswertung des letzten Extraction-Runs: zu versteuerndes Einkommen ' +
      '(zvE), tarifliche ESt, Solidaritaetszuschlag, festzusetzende Steuer, ' +
      'Erstattung/Nachzahlung. Zahlen in EUR.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string' } },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      const { runId, bmf } = await loadBmfResult(inst, ctx);
      if (!bmf) {
        return { caseId, runId: null, message: 'Keine BMF-Auswertung verfuegbar (kein Run abgeschlossen).' };
      }
      const b = bmf as {
        zu_versteuerndes_einkommen?: number;
        tarifliche_est?: number;
        festzusetzende_steuer?: number;
        soli?: number;
        erstattung?: number;
        nachzahlung?: number;
        eingabewerte?: Record<string, unknown>;
        formel_trace?: unknown;
      };
      const erstattung = typeof b.erstattung === 'number' ? b.erstattung : null;
      const nachzahlung = typeof b.nachzahlung === 'number' ? b.nachzahlung : null;
      return {
        caseId,
        runId,
        zvE_eur: b.zu_versteuerndes_einkommen ?? null,
        tarifliche_est_eur: b.tarifliche_est ?? null,
        festzusetzende_steuer_eur: b.festzusetzende_steuer ?? null,
        soli_eur: b.soli ?? null,
        erstattung_eur: erstattung,
        nachzahlung_eur: nachzahlung,
        saldo_eur: erstattung ?? (nachzahlung != null ? -nachzahlung : null),
        eingabewerte_count: b.eingabewerte ? Object.keys(b.eingabewerte).length : 0,
      };
    },
  },

  {
    name: 'verdaechtige_felder',
    description:
      'Felder mit trust=suspicious aus dem letzten Run. Liefert eCode, Wert, ' +
      'normalized, Anlage, Origin und Vermerk warum verdaechtig.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string' } },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      const { runId, layer, source } = await loadLatestCanonicalLayer(inst, ctx);
      if (!layer) {
        return { caseId, runId, count: 0, felder: [], message: 'Keine canonical_layer-Daten.' };
      }
      const felder: Array<Record<string, unknown>> = [];
      for (const [eCode, v] of Object.entries(layer)) {
        const f = v as { trust?: string; value?: unknown; normalized?: unknown; anlage?: string; origin?: string; drucktext?: string };
        if (f?.trust === 'suspicious') {
          felder.push({
            eCode,
            value: f.value ?? null,
            normalized: f.normalized ?? null,
            anlage: f.anlage ?? null,
            origin: f.origin ?? null,
            drucktext: f.drucktext ?? null,
          });
        }
      }
      return { caseId, runId, source, count: felder.length, felder };
    },
  },

  {
    name: 'pflicht_luecken',
    description:
      'Pflichtfelder im erkannten Anlagen-Set, die im letzten Run NICHT extrahiert ' +
      'wurden. Liefert eCode, Anlage, Drucktext, Vordruckzeile.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string' } },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      const app = getApplication(ctx.appId);
      const extractionId = app?.workflows.extraction;
      if (!extractionId || inst.runs.length === 0) {
        return { caseId, count: 0, missing: [], message: 'Kein Run vorhanden.' };
      }
      const lastRunId = inst.runs[inst.runs.length - 1];
      const runDir = path.join(ctx.runsDir, extractionId, lastRunId);
      const klassOut = await readJsonSafe<{ erkannte_anlagen?: string[] }>(
        path.join(runDir, 'klassifizierung', 'output.json'),
      );
      const { layer } = await loadLatestCanonicalLayer(inst, ctx);
      const covered = new Set<string>();
      if (layer) {
        for (const [code, cv] of Object.entries(layer)) {
          const c = cv as { value?: string; normalized?: string | null };
          if ((typeof c?.value === 'string' && c.value.trim().length > 0)
              || (typeof c?.normalized === 'string' && c.normalized.trim().length > 0)) {
            covered.add(code);
          }
        }
      }
      const anlagen = klassOut?.erkannte_anlagen ?? [];
      const missing: Array<Record<string, unknown>> = [];
      try {
        const { felderFuerAnlage } = await import('../lib/elster-catalog.ts');
        for (const anlage of anlagen) {
          const liste = await felderFuerAnlage(anlage as never);
          for (const feld of liste.felder) {
            if (!feld.pflicht) continue;
            if (!covered.has(feld.eCode)) {
              missing.push({
                eCode: feld.eCode,
                anlage,
                drucktext: feld.drucktext,
                vordruckzeile: feld.vordruckzeile,
              });
            }
          }
        }
      } catch (e) {
        return { caseId, error: `Katalog-Lookup fehlgeschlagen: ${(e as Error).message}` };
      }
      return { caseId, runId: lastRunId, anlagen, count: missing.length, missing };
    },
  },

  {
    name: 'tool_health',
    description:
      'Status der gebundenen Werkzeuge (LLM, MCP, RAG, Gitchain, Catalog) der Anwendung. ' +
      'Pro Werkzeug: name, kind, alive (bool), latencyMs, lastError.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const container = getToolContainer(ctx.appId);
      if (!container) {
        return { error: 'Tool-Container nicht initialisiert (STURM_TOOLS_BOOT=skip?).' };
      }
      const health = await container.healthAll();
      const tools = Object.entries(health).map(([name, h]) => ({
        name,
        kind: h.kind,
        alive: h.alive,
        configured: h.configured,
        latencyMs: h.latencyMs ?? null,
        lastError: h.lastError ?? null,
      }));
      const aliveCount = tools.filter((t) => t.alive).length;
      return { appId: ctx.appId, total: tools.length, alive: aliveCount, tools };
    },
  },

  {
    name: 'fall_versiegeln',
    description:
      'Markiert den Fall als versiegelt (status=versiegelt). Vor Aufruf MUSS ' +
      'pflicht_luecken + verdaechtige_felder geprueft worden sein. Setzt sealedAt; ' +
      'der eigentliche steuerfall-seal Workflow muss separat via UI gestartet werden, ' +
      'wenn dieses Werkzeug ohne Lane-1-MCP-Zugriff laeuft.',
    inputSchema: {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        bestaetigt: { type: 'boolean', description: 'true wenn Pflicht-Luecken/verdaechtige Felder akzeptiert.' },
      },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      if (inst.status === 'versiegelt' || inst.status === 'eingereicht') {
        return { caseId, status: inst.status, sealedAt: inst.sealedAt, message: 'Fall ist bereits versiegelt.' };
      }
      if (inst.runs.length === 0) {
        return { error: 'Vor dem Versiegeln muss mindestens ein Dokument extrahiert worden sein.' };
      }
      if (args.bestaetigt !== true) {
        return {
          caseId,
          status: inst.status,
          hinweis:
            'Versiegelung benoetigt Bestaetigung. Pruefe vorher pflicht_luecken und ' +
            'verdaechtige_felder. Erneut mit bestaetigt=true aufrufen, um zu versiegeln.',
        };
      }
      inst.status = 'versiegelt';
      inst.sealedAt = new Date().toISOString();
      await saveInstanceFile(ctx.applicationsDir, inst);
      return {
        caseId,
        status: inst.status,
        sealedAt: inst.sealedAt,
        message:
          'Fall in der Instance-Datei als versiegelt markiert. Vollstaendige seal-Pipeline ' +
          '(HMAC-Signatur + Gitchain-Anker) erfolgt ueber die UI /steuerfall.html.',
        instancePath: instanceFilePath(ctx.applicationsDir, ctx.appId, caseId),
      };
    },
  },

  {
    name: 'fall_exportieren',
    description:
      'Materialisiert die ERiC-XML aus dem versiegelten master.json im Workspace ' +
      'und markiert den Fall als eingereicht. Setzt voraus, dass der Fall versiegelt ist.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string' } },
      required: ['caseId'],
    },
    handler: async (args, ctx) => {
      const caseId = resolveCaseId(args, ctx);
      if (!caseId) return { error: 'caseId fehlt' };
      const inst = await loadInstanceFile(ctx.applicationsDir, ctx.appId, caseId);
      if (!inst) return { error: `Fall nicht gefunden: ${caseId}` };
      if (inst.status !== 'versiegelt' && inst.status !== 'eingereicht') {
        return { error: `Fall ist nicht versiegelt (status=${inst.status}). Erst versiegeln.` };
      }
      const masterPath = path.join(
        path.isAbsolute(inst.workspacePath) ? inst.workspacePath : path.join(ctx.rootCwd, inst.workspacePath),
        'seal',
        'master.json',
      );
      const master = await readJsonSafe<{ eric_xml?: string; merkle?: { root?: string } }>(masterPath);
      if (!master) {
        return {
          error: 'Versiegeltes master.json nicht gefunden. UI-basierte Versiegelung notwendig.',
          masterPath,
        };
      }
      const xml = master.eric_xml ?? '';
      if (!xml) return { error: 'master.json enthaelt keinen eric_xml (BMF-Phase pruefen).' };
      const merkleRoot = master.merkle?.root;
      const ericXmlAbs = path.join(
        ctx.rootCwd,
        inst.workspacePath,
        `eric_${merkleRoot ? merkleRoot.slice(0, 12) : 'unsealed'}.xml`,
      );
      try {
        await fs.writeFile(ericXmlAbs, xml, 'utf-8');
      } catch (e) {
        return { error: `Konnte ERiC-XML nicht schreiben: ${(e as Error).message}` };
      }
      inst.status = 'eingereicht';
      inst.exportedAt = new Date().toISOString();
      inst.einreichungsId = `local-${merkleRoot?.slice(0, 12) ?? Date.now().toString(36)}`;
      await saveInstanceFile(ctx.applicationsDir, inst);
      return {
        caseId,
        status: inst.status,
        exportedAt: inst.exportedAt,
        einreichungsId: inst.einreichungsId,
        ericXmlPath: path.relative(ctx.rootCwd, ericXmlAbs),
        ericXmlSize: xml.length,
        download: `/api/applications/${ctx.appId}/instances/${caseId}/download/eric.xml`,
        hinweis:
          'ERiC-XML lokal abgelegt. Tatsaechliche ELSTER-Uebermittlung erfolgt ' +
          'ausserhalb von sturm (ERiC-Client + Schnittstellen-Credentials).',
      };
    },
  },

  {
    name: 'paragraph_lookup',
    description:
      'Sucht §EStG-Paragraph nach Volltext oder Stichwort. Liefert maximal 5 Treffer mit ' +
      'KontextPath-Prefix + Drucktext. Nutzt den kuratierten paragraph_estg.json-Katalog.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Volltext-Suche oder §-Nummer' } },
      required: ['query'],
    },
    handler: async (args, _ctx) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { error: 'query fehlt' };
      let mapping: Record<string, string> = {};
      try {
        const { loadParagraphEstg } = await import('../lib/elster-catalog.ts');
        const file = await loadParagraphEstg();
        mapping = file.mapping ?? {};
      } catch (e) {
        return { error: `paragraph_estg.json nicht lesbar: ${(e as Error).message}` };
      }
      const needle = query.toLowerCase();
      const matches: Array<{ prefix: string; paragraph: string; score: number }> = [];
      for (const [prefix, paragraph] of Object.entries(mapping)) {
        const prefLow = prefix.toLowerCase();
        const paraLow = paragraph.toLowerCase();
        let score = 0;
        if (prefLow === needle) score = 100;
        else if (prefLow.includes(needle)) score = 60;
        if (paraLow.includes(needle)) score = Math.max(score, 50);
        if (score > 0) matches.push({ prefix, paragraph, score });
      }
      matches.sort((a, b) => b.score - a.score);
      // Optional: wenn RAG-Index verfuegbar, zusaetzliche Treffer reichern.
      let ragHits: Array<{ id: string; score: number }> = [];
      try {
        const container = getToolContainer('steuerfall-est');
        if (container && container.has('elster-rag')) {
          const rag = container.get<RagIndexHandle>('elster-rag');
          const hits = await rag.retrieveCascade(query, { topK: 3 });
          ragHits = hits.map((h) => ({ id: h.id, score: h.score }));
        }
      } catch {
        // RAG ist optional — schluck den Fehler.
      }
      return {
        query,
        count: matches.length,
        treffer: matches.slice(0, 5),
        ragHits,
      };
    },
  },
];

/** Liefert OpenAI-tool-Schema-Array fuer vLLM `tools: [...]`. */
export function toOpenAiToolsSchema(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return ORCHESTRATOR_TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** Index by name fuer den Loop. */
export const TOOLS_BY_NAME: ReadonlyMap<string, OrchestratorTool> = new Map(
  ORCHESTRATOR_TOOLS.map((t) => [t.name, t]),
);
