/**
 * /api/m/bescheid — Session-auth Endpoints für die Bescheid-Pipeline.
 *
 * v2: Drag&Drop-Upload integriert.
 *   - /bescheid/options  → Demo-Mandanten-Liste
 *   - /bescheid/run      → existing Polar+Lane-1 für gewählten Mandanten/Fall
 *   - /bescheid/upload   → NEW: PDFs hochladen, OCR + Klassifizierung parallel,
 *                          Meta-Files schreiben, dann bescheid-pipeline laufen lassen.
 */
import { Router, type Request, type Response } from 'express';
import express from 'express';
import multer from 'multer';
import { readdir, mkdir, copyFile, unlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireMandantenSession } from './m-auth.ts';
import { getWorkflow } from '../core/registry.ts';
import { runWorkflow } from '../core/runner.ts';
import { ocrDocumentFromFile } from '../lib/ocr.ts';
import { classifyDocument } from '../lib/classify.ts';
import { kpiToEcodeBridgeStage } from '../stages/kpi-to-ecode-bridge.ts';
import { runFastAudit } from './fast-path.ts';
import { loadInstanceFile } from './applications.ts';

export interface MandantenBescheidRouterOptions {
  workspacesDir: string;
  usersDir: string;
  profilesDir: string;
  runsDir: string;
  uploadsDir: string;
  /** ROOT-Verzeichnis für applications-data (für runFastAudit). */
  appsRoot: string;
  /** applicationsDir = appsRoot/applications-data. Für loadInstanceFile. */
  applicationsDir: string;
}

function workspaceSlugFuerFall(fallId: string): string {
  return `fall-${fallId.replace(/-/g, '').slice(0, 12)}`;
}

export function createMandantenBescheidRouter(opts: MandantenBescheidRouterOptions): Router {
  const router = Router();
  const jsonMiddleware = express.json({ limit: '64kb' });
  const upload = multer({ dest: opts.uploadsDir, limits: { fileSize: 25 * 1024 * 1024, files: 12 } });

  // KEIN session-auth — bescheid surface ist public, impliziter User.
  // requireMandantenSession bewusst entfernt: ein User reicht für /m/bescheid.

  /**
   * GET /api/m/bescheid/cases → alle audit-now-fähigen Cases (steuerfall-est Instanzen).
   * Liefert pro Case: caseId, displayName, year, runs_count, documents_count, audit_ready.
   */
  router.get('/bescheid/cases', jsonMiddleware, async (_req: Request, res: Response) => {
    const out: Array<{
      caseId: string; appId: string; displayName: string; veranlagungsjahr: number | null;
      runs_count: number; documents_count: number; updatedAt: string;
    }> = [];
    try {
      const appId = 'steuerfall-est';
      const dir = join(opts.applicationsDir, appId);
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const inst = JSON.parse(await readFile(join(dir, f), 'utf-8'));
          out.push({
            caseId: inst.caseId,
            appId: inst.appId ?? appId,
            displayName: inst.displayName ?? inst.caseId,
            veranlagungsjahr: inst.veranlagungsjahr ?? null,
            runs_count: (inst.runs ?? []).length,
            documents_count: (inst.documents ?? []).length,
            updatedAt: inst.updatedAt ?? '',
          });
        } catch { /* skip */ }
      }
    } catch { /* no dir */ }
    out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json({ cases: out });
  });

  /** GET /api/m/bescheid/options → Demo-Mandanten aus profiles/ */
  router.get('/bescheid/options', jsonMiddleware, async (_req: Request, res: Response) => {
    const demo: Array<{ mandant: string; label: string; year: number }> = [];
    try {
      const files = await readdir(opts.profilesDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const slug = f.replace(/\.json$/, '');
        try {
          const p = JSON.parse(await readFile(join(opts.profilesDir, f), 'utf-8'));
          demo.push({
            mandant: slug,
            label: `${p.stammdaten?.vorname ?? ''} ${p.stammdaten?.nachname ?? slug}`.trim(),
            year: p.veranlagungsjahr ?? 2024,
          });
        } catch { /* skip */ }
      }
    } catch { /* no profiles dir */ }
    res.json({ demo });
  });

  /**
   * POST /api/m/bescheid/run
   * Body: { mode: "demo"|"real", caseId?: string, mandant?: string, year?: number, appId?: string }
   *
   * mode=demo → läuft bescheid-pipeline workflow auf workspaces/<mandant>/.
   * mode=real → läuft runFastAudit (audit-now hot-path) auf der App-Instance.
   *             Default appId='steuerfall-est'. Erwartet existierende Runs.
   */
  router.post('/bescheid/run', jsonMiddleware, async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const mode = body.mode === 'demo' ? 'demo' : 'real';
    const year = Number.isFinite(body.year) ? Number(body.year) : 2024;

    if (mode === 'demo') {
      const mandant = String(body.mandant || '').trim();
      if (!mandant) return res.status(400).json({ error: 'missing_mandant_for_demo' });
      const result = await runBescheidPipeline(mandant, year, opts.runsDir);
      return res.json({ ...result, mode: 'demo' });
    }

    // real → audit-now via fast-path
    const caseId = String(body.caseId || '').trim();
    if (!caseId) return res.status(400).json({ error: 'missing_caseId_for_real' });
    const appId = String(body.appId || 'steuerfall-est');

    const inst = await loadInstanceFile(opts.applicationsDir, appId, caseId);
    if (!inst) return res.status(404).json({ ok: false, error: `case not found: ${caseId}`, mode: 'real' });

    try {
      const audit = await runFastAudit(opts.appsRoot, inst);
      return res.json(adaptAuditToBescheidResponse(audit, caseId, year));
    } catch (err) {
      const message = (err as Error).message || 'fast audit failed';
      const status = /blocked:|FATAL:/i.test(message) ? 409 : 500;
      return res.status(status).json({
        ok: false, mode: 'real', appId, caseId, error: message,
      });
    }
  });

  /**
   * POST /api/m/bescheid/upload (multipart, files[])
   *
   * Pro Datei parallel: Mistral-OCR + classifyDocument → meta/<uuid>.json.
   * Wenn `mandant` body-Param gesetzt: Profil-eCodes werden zusätzlich gemerged.
   * Workspace wird als `upload-<userId>-<ts>` angelegt, mounted unter
   * /app/workspaces, sodass bescheid-aggregate die meta/-Files findet.
   */
  router.post('/bescheid/upload', upload.array('files', 12),
    async (req: Request, res: Response) => {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'mistral_api_key_missing' });

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) return res.status(400).json({ error: 'no_files' });

      const year = Number.isFinite(Number(req.body?.year)) ? Number(req.body.year) : 2024;
      const profileMandant = String(req.body?.profile || '').trim() || null;

      const wsSlug = `upload-anon-${Date.now().toString(36)}`;
      const wsDir = join(opts.workspacesDir, wsSlug);
      const metaDir = join(wsDir, 'meta');
      const inboxDir = join(wsDir, 'inbox');
      await mkdir(metaDir, { recursive: true });
      await mkdir(inboxDir, { recursive: true });

      const tGlobal = Date.now();
      const perFile = await Promise.all(files.map(async (f) => {
        const t0 = Date.now();
        const uuid = randomUUID();
        const ext = (f.originalname.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '.pdf').toLowerCase();
        const inboxPath = join(inboxDir, `${uuid}${ext}`);
        // copyFile + unlink statt rename: uploads/ und workspaces/ sind verschiedene Bind-Mounts (EXDEV)
        await copyFile(f.path, inboxPath);
        await unlink(f.path).catch(() => {});

        // OCR
        let ocr: any = null;
        let ocrMs = 0;
        try {
          const r = await ocrDocumentFromFile({ filePath: inboxPath, apiKey, tableFormat: 'markdown' });
          ocr = r;
          ocrMs = r.ms;
        } catch (e) {
          return { uuid, filename: f.originalname, error: `ocr_failed: ${(e as Error).message}`, ms: Date.now() - t0 };
        }

        // Classify (uses OCR markdown → fast path)
        let cls: any = null;
        let clsMs = 0;
        try {
          const r = await classifyDocument({ markdown: ocr.markdown, apiKey });
          cls = r;
          clsMs = r.ms;
        } catch (e) {
          // classify-fail tolerieren — meta wird ohne classification geschrieben
          cls = { label: 'unknown', kpis: [], confidence: 0, summary: '', recommendedAnlagen: [], valueCount: 0 };
        }

        // KPI → eCode (Polar Tier-1, kpi-keys-level): embed each kpi.key
        // gegen 2287 atoms mit anlage-whitelist aus classifyDocument.recommendedAnlagen.
        let kpiMap: any = null;
        let kpiMapMs = 0;
        try {
          const tKM0 = Date.now();
          const out = await kpiToEcodeBridgeStage.run({
            kpis: (cls?.kpis ?? []).map((k: any) => ({
              key: String(k?.key ?? ''),
              value: k?.value ?? '',
              belegtyp: cls?.label,
              doc: f.originalname,
            })),
            defaultBelegtyp: cls?.label,
            allowedAnlagen: cls?.recommendedAnlagen ?? [],
            minScore: 0.50,
            topK: 10,
            ocrMarkdown: ocr?.markdown ?? '',
          }, {} as any);
          kpiMap = out;
          kpiMapMs = Date.now() - tKM0;
        } catch (e) {
          console.error('[kpi-to-ecode] FAIL for', f.originalname, ':', (e as Error).message);
          kpiMap = null;
        }

        // Meta schreiben
        const meta = {
          uuid,
          originalFilename: f.originalname,
          mime: f.mimetype || 'application/pdf',
          size: f.size,
          ingestedAt: new Date().toISOString(),
          currentPath: join('inbox', `${uuid}${ext}`),
          ocr: {
            markdown: ocr.markdown,
            pages: ocr.pages.map((p: any) => ({ index: p.index, chars: p.markdown.length })),
            charCount: ocr.charCount,
            ms: ocrMs,
          },
          classification: {
            label: cls.label,
            confidence: cls.confidence,
            summary: cls.summary,
            kpis: cls.kpis,
            recommendedAnlagen: cls.recommendedAnlagen,
            valueCount: cls.valueCount,
            ms: clsMs,
          },
          polarTier1: kpiMap ? {
            stats: kpiMap.stats,
            distinct_ecodes: Object.keys(kpiMap.canonical_layer ?? {}),
          } : null,
        };
        await writeFile(join(metaDir, `${uuid}.json`), JSON.stringify(meta, null, 2));
        return {
          uuid, filename: f.originalname,
          label: cls.label, kpis: cls.kpis.length,
          ocr_ms: ocrMs, classify_ms: clsMs, kpi_map_ms: kpiMapMs,
          ecodes_matched: kpiMap ? Object.keys(kpiMap.canonical_layer).length : 0,
          canonical_per_file: kpiMap?.canonical_layer ?? {},
          ms: Date.now() - t0,
        };
      }));

      // Profile in Workspace kopieren (Workaround weil /app/profiles :ro ist)
      if (profileMandant) {
        try {
          const src = await readFile(join(opts.profilesDir, `${profileMandant}.json`), 'utf-8');
          await writeFile(join(wsDir, 'profile.json'), src);
        } catch { /* skip */ }
      }

      // Merge per-file canonical_layers in einen workspace-level canonical-layer.json
      const merged: Record<string, any> = {};
      for (const f of perFile as any[]) {
        const ec = f?.canonical_per_file ?? {};
        for (const [k, v] of Object.entries<any>(ec)) {
          if (!merged[k]) {
            merged[k] = { ...v };
          } else {
            merged[k].values = [...(merged[k].values ?? []), ...(v.values ?? [])];
          }
        }
      }
      const totalEcodes = Object.keys(merged).length;
      if (totalEcodes > 0) {
        await writeFile(
          join(wsDir, 'canonical-layer.json'),
          JSON.stringify({
            mandant: wsSlug, veranlagungsjahr: year,
            generated_at: new Date().toISOString(),
            canonical_layer: merged,
            stats: { ecodes_total: totalEcodes, source: 'upload-polar-tier1' },
          }, null, 2),
        );
      }

      console.error('[upload] workspace=' + wsSlug + ' files=' + files.length
        + ' merged_ecodes=' + Object.keys(merged).length + ' profileMandant=' + (profileMandant ?? '—'));

      // Pre-Build extraction (KPIs pro Datei) — runBescheidPipeline baut coding/compute via runWorkflow
      const extraction = (perFile as any[]).map((f) => ({
        filename: f.filename,
        label: f.label,
        kpis_count: f.kpis,
        kpis: [], // wird gleich aus meta gefüllt
        ms: { ocr: f.ocr_ms, classify: f.classify_ms, kpi_map: f.kpi_map_ms },
      }));
      // Lade kpis aus den meta-files (parallel)
      await Promise.all(extraction.map(async (e, idx) => {
        try {
          const f = (perFile as any[])[idx];
          const metaPath = join(wsDir, 'meta', `${f.uuid}.json`);
          const d = JSON.parse(await readFile(metaPath, 'utf-8'));
          e.kpis = (d.classification?.kpis ?? []).map((k: any) => ({
            key: String(k?.key ?? ''),
            value: k?.value ?? '',
          }));
        } catch { /* skip */ }
      }));

      // Bescheid-Pipeline auf den frischen Workspace, profileMandant als input-Override
      const pipelineResult = await runBescheidPipeline(wsSlug, year, opts.runsDir, profileMandant);
      // Upload-Pfad: extraction NICHT aus runBescheidPipeline's report (cross-fall), sondern unsere frische
      (pipelineResult as any).report_extraction = extraction;
      console.error('[upload] lane1 sent ecodes=' + (pipelineResult.ecodes_sent ?? 0)
        + ' zve=' + (pipelineResult.zusammenfassung?.zve ?? 0)
        + ' est=' + (pipelineResult.zusammenfassung?.einkommensteuer ?? 0));
      const profileInjected = Boolean(profileMandant);

      const totalMs = Date.now() - tGlobal;
      res.json({
        ok: true,
        workspace: wsSlug,
        year,
        profileMandant,
        profileInjected,
        files: perFile,
        ms_total: totalMs,
        ms_ocr_classify: Math.max(...perFile.map(f => f.ms ?? 0), 0),
        ...pipelineResult,
      });
    });

  return router;
}

/**
 * Adapter: bringt FastAuditResult auf dieselbe Shape wie runBescheidPipeline.
 * Die UI bekommt einheitliche Felder (zusammenfassung, markdown, audit, etc).
 */
function adaptAuditToBescheidResponse(audit: any, caseId: string, year: number) {
  const out = audit?.output ?? {};
  const bmf = out.bmf ?? {};
  const daten = bmf.daten ?? {};
  const ml = out.merged_layer ?? {};
  const conflicts = out.conflicts ?? [];
  const perDoc = out.per_document ?? [];

  const eo = Number(daten.erstattung_oder_nachzahlung ?? 0);
  const zusammenfassung = bmf.erfolg ? {
    zve: Number(daten.zve ?? 0),
    einkommensteuer: Number(daten.einkommensteuer ?? 0),
    solidaritaetszuschlag: Number(daten.solidaritaetszuschlag ?? 0),
    gesamtsteuer: Number(daten.gesamtsteuer ?? 0),
    vorauszahlungen: Number(daten.steuervorauszahlungen ?? 0),
    erstattung_oder_nachzahlung: eo,
    label: eo < 0 ? 'Erstattung' : (eo > 0 ? 'Nachzahlung' : '—'),
    grenzsteuersatz: Number(daten.grenzsteuersatz ?? 0),
    durchschnittssteuersatz: Number(daten.durchschnittssteuersatz ?? 0),
    bmf_konform: Boolean(daten.bmf_konform),
    fall_id: String(daten.fall_id ?? caseId),
  } : null;

  const fmtEur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const md: string[] = [];
  md.push(`# Steuerbescheid-Vorschau ${year} — ${caseId}`);
  md.push(`*Pipeline: audit-now (aggregate-direct) · ${new Date().toISOString()}*`);
  md.push(`*Mode: aggregate-direct · Workspace: \`${audit.workspaceId}\` · extractionWorkflow: \`${audit.extractionWorkflowId}\`*`);
  if (zusammenfassung) {
    md.push(`\n## Ergebnis\n\n| Position | Betrag |\n|---|---:|`);
    md.push(`| zu versteuerndes Einkommen | **${fmtEur(zusammenfassung.zve)}** |`);
    md.push(`| Einkommensteuer §32a | **${fmtEur(zusammenfassung.einkommensteuer)}** |`);
    md.push(`| Solidaritätszuschlag | ${fmtEur(zusammenfassung.solidaritaetszuschlag)} |`);
    md.push(`| Gesamtsteuerschuld | ${fmtEur(zusammenfassung.gesamtsteuer)} |`);
    md.push(`| − Vorauszahlungen | ${fmtEur(zusammenfassung.vorauszahlungen)} |`);
    md.push(`| **${zusammenfassung.label}** | **${fmtEur(Math.abs(eo))}** |`);
    md.push(`| Grenzsteuersatz | ${(zusammenfassung.grenzsteuersatz*100).toFixed(2)} % |`);
    md.push(`| Ø-Steuersatz | ${(zusammenfassung.durchschnittssteuersatz*100).toFixed(2)} % |`);
  } else {
    md.push(`\n## Bescheid noch nicht berechnet\n`);
    md.push(`BMF-Lane-1 antwortete: ${JSON.stringify(bmf).slice(0,400)}`);
  }
  md.push(`\n## Aggregation\n`);
  md.push(`- Dokumente im Fall: **${perDoc.length}**`);
  md.push(`- eCodes im merged_layer: **${Object.keys(ml).length}**`);
  md.push(`- Konflikte (gleicher eCode, abweichende Werte): **${conflicts.length}**`);

  return {
    ok: true,
    mode: 'real',
    audit_source: 'aggregate-direct',
    runId: audit.workspaceId,
    ms: audit.ms,
    mandant: caseId,
    year,
    zusammenfassung,
    markdown: md.join('\n'),
    fehlende_belege: daten.fehlende_belege ?? [],
    audit: {
      polar_n: Object.keys(ml).length,
      mandanten_n: 0,
      profil_n: 0,
      union_n: Object.keys(ml).length,
      dropped: [],
      polar_source: 'aggregate-direct',
      profile_path: null,
      conflicts: conflicts.length,
      docs_count: perDoc.length,
    },
    lane1_ms: null,
    ecodes_sent: Object.keys(ml).length,
    // Tab-Daten für real-mode
    report_extraction: perDoc.map((d: any) => ({
      filename: d.filename ?? d.file ?? d.runId ?? '?',
      label: d.label ?? d.docType ?? '?',
      kpis_count: (d.kpis ?? d.classification?.kpis ?? []).length,
      kpis: (d.kpis ?? d.classification?.kpis ?? []),
    })),
    report_coding: ml,
    report_compute: daten?.berechnungsdetails ?? null,
    report_eingabewerte: daten?.berechnungsdetails?.eingabewerte ?? null,
    report_rechenschritte: daten?.berechnungsdetails?.rechenschritte ?? null,
  };
}

/**
 * Liest workspace meta/*.json und canonical-layer.json zusammen für die UI-Tabs:
 *   - extraction[]:  alle KPIs pro Beleg (was Mistral fand)
 *   - coding:        canonical_layer eCode → kpi-source-mapping
 */
async function buildReportFromWorkspace(workspacesDir: string, mandant: string) {
  const ws = join(workspacesDir, mandant);
  const extraction: Array<{
    filename: string; label?: string; kpis_count: number;
    kpis: Array<{ key: string; value: any }>;
    ms?: { ocr?: number; classify?: number };
  }> = [];
  let coding: Record<string, any> = {};

  try {
    const files = await readdir(join(ws, 'meta'));
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(join(ws, 'meta', f), 'utf-8'));
        const kpis = (d.classification?.kpis ?? []).map((k: any) => ({
          key: String(k?.key ?? ''),
          value: k?.value ?? '',
        }));
        extraction.push({
          filename: d.originalFilename ?? f,
          label: d.classification?.label,
          kpis_count: kpis.length,
          kpis,
          ms: { ocr: d.ocr?.ms, classify: d.classification?.ms },
        });
      } catch { /* skip */ }
    }
  } catch { /* no meta dir */ }

  try {
    const cl = JSON.parse(await readFile(join(ws, 'canonical-layer.json'), 'utf-8'));
    coding = cl.canonical_layer ?? {};
  } catch { /* no canonical-layer */ }

  return { extraction, coding };
}

async function runBescheidPipeline(mandant: string, year: number, runsDir: string, profileMandant?: string | null) {
  const def = getWorkflow('bescheid-pipeline');
  if (!def) return { ok: false, error: 'workflow_not_registered' };

  const t0 = Date.now();
  const outputs: Record<string, any> = {};
  const events: number[] = [];

  const run = runWorkflow(def, {
    runsDir,
    input: { mandant, year, profileMandant: profileMandant ?? undefined },
    abortSignal: new AbortController().signal,
    onEvent: (name, payload: any, stageId?: string) => {
      events.push(1);
      if (name === 'stage_done' && stageId && payload?.output) outputs[stageId] = payload.output;
    },
  });

  try {
    await run.result;
    const render = outputs.render ?? {};
    const aggregate = outputs.aggregate ?? {};
    const lane1 = outputs.lane1 ?? {};
    const report = await buildReportFromWorkspace(
      // workspacesDir aus closure-scope nicht verfügbar; aggregate.audit hat keinen
      // Pfad. Workspace-Root = /app/workspaces (Konvention).
      '/app/workspaces', mandant,
    );
    return {
      ok: true, runId: run.runId, ms: Date.now() - t0, mandant, year,
      zusammenfassung: render.zusammenfassung ?? null,
      markdown: render.markdown ?? '',
      fehlende_belege: render.fehlende_belege ?? [],
      audit: aggregate.audit ?? null,
      lane1_ms: lane1.ms ?? null,
      ecodes_sent: lane1.ecodes_sent ?? 0,
      // Report-Daten für UI Tab 1/2/3
      report_extraction: report.extraction,
      report_coding: report.coding,
      report_compute: lane1.daten?.berechnungsdetails ?? null,
      report_eingabewerte: lane1.daten?.berechnungsdetails?.eingabewerte ?? null,
      report_rechenschritte: lane1.daten?.berechnungsdetails?.rechenschritte ?? null,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, runId: run.runId };
  }
}
