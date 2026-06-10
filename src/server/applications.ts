/**
 * Application-Instances REST-Layer.
 *
 * Persistenz: JSON-Dateien unter `applications/<appId>/<caseId>.json`. Bewusst
 * kein Postgres/Redis — kompatibel zu CLAUDE.md MVP-Regel ("JSON-Persistenz im
 * MVP"). Wenn später Postgres-Tax-Case-Container live geschaltet werden, kann
 * derselbe Contract gegen die gitchain-Registry backen.
 *
 * Phase 4a: CRUD (create, list, get).
 * Phase 4b: trigger-Endpoints (upload/seal/export) — werden später ergänzt.
 */
import { Router } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listApplications, getApplication } from '../core/registry.ts';

export interface CaseDocument {
  /** Workflow-Run-ID, der dieses Dokument extrahiert hat. */
  runId: string;
  /** Originaldateiname wie hochgeladen. */
  filename: string;
  /** Workspace-relativer Pfad im inbox-Ordner. */
  inboxPath: string;
  /** SHA256-Hex des Dateiinhalts (Audit / Re-Run-Detection). */
  sha256: string;
  size: number;
  uploadedAt: string;
  /** Erkannte ELSTER-Anlagen aus dem Run (kopiert vom Klassifizierer). */
  anlagen?: string[];
  /** Anzahl extrahierter eCodes (kopiert nach Run-Ende). */
  fieldsExtracted?: number;
  /**
   * Pro-Dokument-Qualitätsverteilung der eCode-Felder im canonical_layer
   * (Trust-Stufen high/medium/suspicious/low). Wird beim Run-Abschluss
   * berechnet und in den Manifest geschrieben. Optional, weil ältere
   * Manifests den Wert nicht haben — UI rendert dann keine Chip-Zeile.
   */
  trustBreakdown?: { high: number; medium: number; suspicious: number; low: number };
  mimeType?: string;
  /**
   * Round-1 Vorschau (beleg-indikation Stage). Wird ~1-3s nach Upload
   * geschrieben, parallel zur OCR. Enthält erkannte Anlagen, Belegtyp
   * und die wichtigsten direkt aus dem Bild gelesenen Werte. Bleibt im
   * Manifest erhalten, damit die Belege-Tabelle sie auch nach Reload
   * zeigt.
   */
  indikation?: {
    anlagen: string[];
    belegtyp: string | null;
    wichtige_werte: Array<{ label: string; value: string }>;
    /** Steuerjahr des Belegs (z.B. 2024). null für Stammdaten / Belege
     *  ohne klares Jahr. Vom UI für Mismatch-Warnung gegen case.veranlagungsjahr
     *  genutzt; vom geplanten cross-doc-reasoner für die finale Zuordnung. */
    steuerjahr?: number | null;
    ms: number;
    at: string;
  };
}

export interface ApplicationInstance {
  caseId: string;
  appId: string;
  displayName: string;
  mandantId: string;
  veranlagungsjahr?: number;
  status: 'in_bearbeitung' | 'review' | 'versiegelt' | 'eingereicht' | 'archiviert';
  createdAt: string;
  updatedAt: string;
  /** Run-IDs des extraction-Workflows, jüngste zuletzt. */
  runs: string[];
  /** Per-Case Override des Extraction-Workflows (z.B. 'elster-v6-vision').
   *  Wird beim ersten Upload persistiert (siehe upload-bulk Handler) damit
   *  spätere master-Refreshes denselben Workflow-runs/-Pfad aggregieren.
   *  Ohne diesen Wert würde der refresh-Handler auf den App-Default
   *  zurückfallen (typisch elster-v5_2-rag) und Artefakte aus dem v6-
   *  Verzeichnis nicht finden → 0 Felder aggregiert. */
  extractionWorkflow?: string;
  /** Per-Dokument-Metadaten — befüllt von /upload + /upload-bulk. */
  documents?: CaseDocument[];
  /** Pfad zum Workspace-Verzeichnis (uploads, artifacts). Relativ zum Server-Cwd. */
  workspacePath: string;
  sealedAt?: string;
  sealCommitSha?: string;
  exportedAt?: string;
  einreichungsId?: string;
  /** Vorjahres- oder Onboarding-Kontext für engführende Extraktion. */
  context?: CaseContext;
}

/**
 * Per-Case Kontext aus Vorjahres-Erklärung ODER 5-Fragen-Onboarding-Wizard.
 * Engführt die Pipeline:
 *   • felderNarrow + phase3LlmFill: nur expected_ecodes_by_anlage
 *   • phase6BmfRechner: nutzt veranlagungsart für Splittingtarif
 *   • UI: schlägt daueranschnitte zur Übernahme vor
 *
 * Quelle ist entweder ein dediziertes Vorjahres-Upload (source='vorjahr',
 * Output von vorjahres-kontext-extract-Workflow) oder das Onboarding-Wizard-
 * Formular (source='onboarding'). Beide Pfade liefern dieselbe Shape, damit
 * downstream-Code identisch funktioniert.
 */
export interface CaseContext {
  source: 'vorjahr' | 'onboarding' | 'progressive';
  /** ISO-Timestamp wann gesetzt. */
  setAt: string;
  /** Jahr aus dem die Vorjahres-Erkl stammt (nur source='vorjahr'). */
  vorjahr?: number;
  /** Anlagen die in 2024 erwartet werden. felderNarrow + Klassifizierung
   *  begrenzen sich darauf. */
  expected_anlagen: string[];
  /** Pro Anlage die eCodes die im Vorjahr belegt waren bzw. via Onboarding
   *  abgeleitet sind. phase3LlmFill engführt sein Schema darauf. */
  expected_ecodes_by_anlage?: Record<string, string[]>;
  /** Veranlagungsart — direkt an BMF-Rechner für Tarif-Wahl. */
  veranlagungsart?: 'zusammenveranlagung' | 'einzelveranlagung' | 'ledig';
  /** Anzahl Kinder (für Kinderfreibetrag-Aktivierung). */
  anzahl_kinder?: number;
  /** Vorschlagswerte aus Vorjahr/Onboarding die der User in 2024 bestätigen
   *  kann (Pendlerpauschale, Werbungskosten, etc.). Werden im UI als
   *  „Übernahme?"-Karten gerendert. */
  daueranschnitte?: Array<{
    eCode: string;
    label: string;
    wert: number | string;
    einheit?: string;
    quelle: string;
    /** Status — vom User in der UI gesetzt. */
    status?: 'vorgeschlagen' | 'uebernommen' | 'geaendert' | 'verworfen';
  }>;
  /** Belege die für 2024 erwartet werden aber noch nicht da sind. */
  missing_belege_erwartet?: string[];
  /** Falls source='vorjahr': Pfad zur extrahierten Vorjahres-JSON im Case-Workspace. */
  vorjahresKontextPfad?: string;
  /** Person-A (Hauptperson / Ehemann). Wird von v5_4-Mappern als hartes Seed
   *  für Person-A/B-Disambig genutzt (statt fragiler first-seen-IdNr-Heuristik). */
  person_a?: { idnr?: string; familienname?: string; vorname?: string };
  /** Person-B (nur bei Zusammenveranlagung gesetzt). */
  person_b?: { idnr?: string; familienname?: string; vorname?: string };
  /** Flache eCode-Map aus dem ESE-Mapper (Python-Solver Welle 0-5) auf der
   *  Vorjahres-Erklärung. 31 Locks @ conf 1.0 für Stricker 2023. Wird von
   *  v5_4-Mappern als Δ-Check-Basis genutzt (z.B. "Brutto 2024 > 2023"). */
  vorjahr_ecodes?: Record<string, string | number>;
}

export interface CreateInstanceBody {
  mandant_id: string;
  displayName: string;
  veranlagungsjahr?: number;
}

/** ISO-konformer kebab-case-Slug — eindeutige caseId-Komponente. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function makeCaseId(displayName: string, veranlagungsjahr?: number): string {
  const slug = slugify(displayName) || 'fall';
  // Veranlagungsjahr nur anhängen, wenn nicht schon im Slug enthalten — vermeidet
  // doppelte Jahres-Suffixe ("mustermann-2024-2024-…").
  const jahr = veranlagungsjahr ? String(veranlagungsjahr) : '';
  const slugHasJahr = jahr && slug.includes(jahr);
  const t = Date.now().toString(36);
  return slugHasJahr ? `${slug}-${t}` : `${slug}${jahr ? `-${jahr}` : ''}-${t}`;
}

export interface ApplicationsRouterOptions {
  /** Root-Verzeichnis für persistente Instanzen (z.B. <cwd>/applications-data). */
  dir: string;
}

/** Pfad zur Instanz-Datei für (appId, caseId). */
export function instanceFilePath(rootDir: string, appId: string, caseId: string): string {
  return path.join(rootDir, appId, `${caseId}.json`);
}

/** Liest eine Instanz oder null bei nicht-existent. */
export async function loadInstanceFile(
  rootDir: string,
  appId: string,
  caseId: string,
): Promise<ApplicationInstance | null> {
  try {
    const raw = await fs.readFile(instanceFilePath(rootDir, appId, caseId), 'utf-8');
    return JSON.parse(raw) as ApplicationInstance;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Schreibt eine Instanz (legt das Verzeichnis bei Bedarf an). */
export async function saveInstanceFile(
  rootDir: string,
  inst: ApplicationInstance,
): Promise<void> {
  const dir = path.join(rootDir, inst.appId);
  await fs.mkdir(dir, { recursive: true });
  inst.updatedAt = new Date().toISOString();
  await fs.writeFile(
    instanceFilePath(rootDir, inst.appId, inst.caseId),
    JSON.stringify(inst, null, 2),
    'utf-8',
  );
}

export function createApplicationsRouter(opts: ApplicationsRouterOptions): Router {
  const router = Router();
  const ROOT = opts.dir;

  async function instancesDir(appId: string): Promise<string> {
    const p = path.join(ROOT, appId);
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  async function loadInstance(appId: string, caseId: string): Promise<ApplicationInstance | null> {
    return loadInstanceFile(ROOT, appId, caseId);
  }

  async function saveInstance(inst: ApplicationInstance): Promise<void> {
    return saveInstanceFile(ROOT, inst);
  }

  // ── GET /api/applications/:appId/instances ─────────────────────────────
  router.get('/:appId/instances', async (req, res) => {
    const appId = req.params.appId;
    if (!getApplication(appId)) {
      return res.status(404).json({ error: `application not found: ${appId}` });
    }
    const dir = await instancesDir(appId);
    let files: string[];
    try { files = await fs.readdir(dir); } catch { files = []; }
    const items: ApplicationInstance[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        items.push(JSON.parse(raw) as ApplicationInstance);
      } catch {
        // skip corrupted file; reported elsewhere
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  });

  // ── GET /api/applications/:appId/instances/:caseId ─────────────────────
  router.get('/:appId/instances/:caseId', async (req, res) => {
    const { appId, caseId } = req.params;
    if (!getApplication(appId)) {
      return res.status(404).json({ error: `application not found: ${appId}` });
    }
    const inst = await loadInstance(appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    res.json(inst);
  });

  // ── DELETE /api/applications/:appId/instances/:caseId ──────────────────
  // Verhalten je nach Lifecycle:
  //   in_bearbeitung   → komplett löschen (JSON + Workspace inkl. Inbox)
  //   versiegelt       → nur archivieren (Status `archiviert`, readonly).
  //                       Wir behalten master.json + Anchor + Run-Artefakte —
  //                       die sind das Audit-Resultat des Falls.
  //   eingereicht      → analog versiegelt, nur archivieren.
  // Force-Flag `?force=1` kann auch versiegelte Fälle löschen (Aufräum-Hilfe).
  router.delete('/:appId/instances/:caseId', async (req, res) => {
    const { appId, caseId } = req.params;
    if (!getApplication(appId)) {
      return res.status(404).json({ error: `application not found: ${appId}` });
    }
    const inst = await loadInstance(appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force && inst.status !== 'in_bearbeitung') {
      // Archivieren (Status-Übergang, kein Löschen)
      inst.status = 'archiviert' as ApplicationInstance['status'];
      await saveInstance(inst);
      return res.json({ archived: true, caseId, prevStatus: inst.status });
    }
    // Echt löschen: Instance-JSON + Workspace-Dir (relativ zur cwd)
    try {
      await fs.rm(instanceFilePath(ROOT, appId, caseId), { force: true });
    } catch { /* tolerant */ }
    const wsAbs = path.isAbsolute(inst.workspacePath)
      ? inst.workspacePath
      : path.join(process.cwd(), inst.workspacePath);
    try {
      await fs.rm(wsAbs, { recursive: true, force: true });
    } catch { /* tolerant */ }
    return res.json({ deleted: true, caseId, workspaceRemoved: wsAbs });
  });

  // ── POST /api/applications/:appId/instances ────────────────────────────
  router.post('/:appId/instances', async (req, res) => {
    const appId = req.params.appId;
    const app = getApplication(appId);
    if (!app) return res.status(404).json({ error: `application not found: ${appId}` });

    const body = (req.body ?? {}) as CreateInstanceBody;
    if (app.mandantRequired && (!body.mandant_id || typeof body.mandant_id !== 'string')) {
      return res.status(400).json({ error: 'mandant_id (string) required' });
    }
    if (!body.displayName || typeof body.displayName !== 'string') {
      return res.status(400).json({ error: 'displayName (string) required' });
    }

    const caseId = makeCaseId(body.displayName, body.veranlagungsjahr);
    const now = new Date().toISOString();
    const workspacePath = path.join('applications', appId, caseId);
    const inst: ApplicationInstance = {
      caseId,
      appId,
      displayName: body.displayName,
      mandantId: body.mandant_id ?? '',
      veranlagungsjahr: body.veranlagungsjahr,
      status: 'in_bearbeitung',
      createdAt: now,
      updatedAt: now,
      runs: [],
      workspacePath,
    };
    // Workspace-Verzeichnis bereits anlegen, damit Upload-Trigger später nichts
    // mehr zu prüfen hat.
    await fs.mkdir(path.join(process.cwd(), workspacePath, 'inbox'), { recursive: true });
    await fs.mkdir(path.join(process.cwd(), workspacePath, 'runs'), { recursive: true });
    await saveInstance(inst);
    res.status(201).json(inst);
  });

  return router;
}

/** Listet alle registrierten Anwendungen (verwendet vom landing UI). */
export function listAllApplicationsForApi() {
  return listApplications();
}
