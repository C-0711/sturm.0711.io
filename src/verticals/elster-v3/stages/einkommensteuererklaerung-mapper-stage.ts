/**
 * elster-v3/einkommensteuererklaerung-mapper — Stage für die deterministische
 * eCode-Extraktion aus einer kompletten Einkommensteuererklärung (PDF mit
 * Anlagen ESt1A, N, KAP, Vorsorgeaufwand, etc.).
 *
 * Architektur (siehe tools/elster-inverse-solver/README.md):
 *   Welle 0   parse_ocr (Date-Preservation, Reference-Mask)
 *   Welle 1   Ratio Math (Soli 5.5%, KiSt 8/9%, SV 9.3/7.3/1.5/1.3%, Sum, Diff)
 *   Welle 1.5 Math→Real-eCode-Transfer
 *   Welle 2   Spatial Zoning per (Anlage, Person)
 *   Welle 3   Label-Adjacency mit Zone-Filter + kontextPath /A//B Disambig
 *   Welle 4   embeddinggemma Cascade-Fallback
 *   Welle 5   Lane 1 BMF Verifier (§32a EStG)
 *
 * Implementierung: Python-Solver in tools/elster-inverse-solver/ wird per
 * Subprocess aufgerufen. Output ist eCode → Wert (mit Person-Suffix __A/__B
 * für duplizierbare Felder wie KAP-Person-A vs KAP-Person-B).
 *
 * Auf Stricker-2023-Testfall: 56 von 63 Felder gelockt (89% Coverage),
 * 17 Convergence-Locks @ confidence 1.0, Lane 1 verifiziert Erstattung 308,98 €.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../../core/stage.ts';

// Container-Quellen (single source of truth):
//   atoms.json         → 0711:elster:bmf:jahresdok-2024:v2 (2287 eCodes)
//   paragraph_estg.json → §-Lookup für Statutory-Constants
// Beide liegen im Repo unter src/verticals/elster-v3/data/ (eingechecktes
// Container-Snapshot, von loadCatalog() in elster-catalog.ts gelesen).
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ATOMS_PATH = resolve(__dirname, '../data/atoms.json');
const DEFAULT_PARAGRAPHS_PATH = resolve(__dirname, '../data/paragraph_estg.json');

export interface ESEMapperInput {
  /** Legacy: roher OCR-Volltext einer Einkommensteuererklärung. */
  ocrText?: string;
  /** v5_4: strukturierte Block-Liste von gemma-vision-ocr-zoning. Wenn
   *  vorhanden + ocrText leer, wird intern ein strukturierter Text mit
   *  Block-Headern ("=== Anlage_N (Person A) ===") generiert und an den
   *  Solver gegeben. Vorteil: Solver-Spatial-Zoning bekommt explizite
   *  Anlage-Person-Marker statt heuristisch suchen zu müssen. */
  erkannte_dokumente?: Array<{
    dokumenten_typ: string;
    gehoert_zu_person?: string;
    ocr_zeilen?: Array<{ zeilen_nr: number; text: string }>;
  }>;
  /** Veranlagungszeitraum (für statutory constants + Lane 1 call). */
  steuerjahr?: number;
}

export interface ESEMapperConfig {
  /** Pfad zum Python-Solver (tools/elster-inverse-solver/inverse_solver.py). */
  solverPath?: string;
  /** Python-Interpreter. Default: 'python3'. */
  pythonBin?: string;
  /** Welle 5 Lane 1 Verifier aufrufen? Default: true (braucht Lane 1 :12010). */
  runLane1Verifier?: boolean;
  /** Welle 4 embeddinggemma Cascade aufrufen? Default: false (braucht Ollama :11434). */
  runCascadeFallback?: boolean;
  /** Timeout für Solver-Subprocess in Sekunden. Default: 60. */
  timeoutSec?: number;
}

export interface ESELock {
  ecode: string;
  drucktext: string;
  value: string | number;
  lineNo: number;
  anlage: string | null;
  confidence: number;
  wave: number;
  lockedBy: string[];
}

export interface ESEMapperOutput {
  /** eCode (mit optional __A/__B Suffix) → Lock. */
  locks: Record<string, ESELock>;
  /** Pure ecode→value map (ohne Person-Suffix) für Lane 1. */
  ecodes: Record<string, string | number>;
  /** Anzahl Locks gesamt. */
  lockCount: number;
  /** Davon mit confidence == 1.0 (math + label converged). */
  convergenceCount: number;
  /** Lane 1 Berechnung (wenn runLane1Verifier=true). */
  lane1Result?: {
    zve: number;
    einkommensteuer: number;
    solidaritaetszuschlag: number;
    erstattung_oder_nachzahlung: number;
    bmf_konform: boolean;
  };
  ms: number;
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export const einkommensteuererklaerungMapperStage = defineStage<
  ESEMapperInput,
  ESEMapperOutput,
  ESEMapperConfig
>({
  id: 'elster-v3/einkommensteuererklaerung-mapper',
  name: 'Einkommensteuererklärungs-Mapper (5-Welle Constraint-Propagation)',
  description:
    'Deterministische eCode-Extraktion aus einer kompletten Einkommensteuererklärung ' +
    'via Ratio Math (statutory §§-Constraints) + Spatial Zoning + Label-Adjacency + ' +
    'embeddinggemma-Cascade + Lane 1 BMF §32a-Verifier. ' +
    'Backend: tools/elster-inverse-solver/inverse_solver.py (Python).',
  hints: {
    inputs: 'ocrText: voller OCR-Text einer Einkommensteuererklärung-PDF, optional steuerjahr (default 2023)',
    outputs: 'locks: {[ecode__person]: ESELock}, ecodes flach, lockCount, convergenceCount, lane1Result, ms',
    configExample:
      '{"solverPath":"tools/elster-inverse-solver/inverse_solver.py","runLane1Verifier":true,"runCascadeFallback":false,"timeoutSec":60}',
    inputPorts: [
      { name: 'ocrText', type: 'string', description: 'OCR-Volltext der Erklärung' },
    ],
    outputPorts: [
      { name: 'locks', type: 'locks', description: 'eCode → Lock-Objekt' },
      { name: 'ecodes', type: 'ecodes', description: 'Flache eCode → value Map' },
      { name: 'lockCount', type: 'number' },
      { name: 'convergenceCount', type: 'number' },
      { name: 'lane1Result', type: 'lane1Result', description: 'BMF-Berechnung optional' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    // Input-Auflösung: ocrText (legacy) bevorzugt; sonst aus erkannte_dokumente
    // (v5_4) ein strukturierter Text mit Block-Headern bauen.
    let ocrText: string = input?.ocrText ?? '';
    if (!ocrText && (input?.erkannte_dokumente?.length ?? 0) > 0) {
      ocrText = erkannteDokumenteToStructuredText(input!.erkannte_dokumente!);
      ctx.emit('ese_mapper_text_from_zoning', {
        blockCount: input!.erkannte_dokumente!.length,
        chars: ocrText.length,
      });
    }
    if (!ocrText) {
      ctx.logger.warn('einkommensteuererklaerung-mapper: leerer OCR-Text + keine erkannte_dokumente');
      return { locks: {}, ecodes: {}, lockCount: 0, convergenceCount: 0, ms: 0 };
    }
    // Re-bind input für rest des Codes (ocrText jetzt garantiert non-empty).
    input = { ...(input ?? {}), ocrText };

    const solverPath =
      ctx.config?.solverPath ??
      process.env.ELSTER_SOLVER_PATH ??
      'tools/elster-inverse-solver/inverse_solver.py';
    const pythonBin = ctx.config?.pythonBin ?? 'python3';
    const timeoutSec = ctx.config?.timeoutSec ?? 60;

    if (!existsSync(solverPath)) {
      ctx.logger.error(`Solver not found at ${solverPath}`);
      throw new Error(
        `elster-inverse-solver not found at ${solverPath}. ` +
          `Set ELSTER_SOLVER_PATH env var or config.solverPath.`,
      );
    }

    // Write OCR to temp file, run Python solver, read JSON output.
    // Wenn erkannte_dokumente vorhanden ist: schreibe das Vision-Zoning auch
    // als JSON-Datei und gib --zoning an den Solver. Der nutzt dann die per-
    // Block (anlage, person)-Information DIREKT statt sie aus dem flachen Text
    // per Regex zurückzuparsen. Wirkung: math-locks pro Block isoliert →
    // keine PV/AV-Verwechslung mehr (selbe Zahl in mehreren Blöcken sicher
    // disambiguiert).
    const workDir = mkdtempSync(join(tmpdir(), 'elster-solver-'));
    const ocrFile = join(workDir, 'input.ocr.txt');
    const outFile = join(workDir, 'solver_result.json');
    const zoningFile = join(workDir, 'zoning.json');
    writeFileSync(ocrFile, ocrText);
    // Zoning-JSON nur schreiben wenn explizit aktiviert. Defaults FALSE weil
    // die globale line_no-Synchronisation zwischen ocrText und zoning_map
    // noch nicht fertig kalibriert ist (block-lokale zeilen_nr kollidieren
    // beim Lookup). Solver fällt zurück auf Regex-Parse-Pfad → liefert volle
    // Welle-1-Math-Locks (RV/KV/PV/AV).
    const hasZoning = (ctx.config as { enableZoningHandoff?: boolean })?.enableZoningHandoff === true
      && (input?.erkannte_dokumente?.length ?? 0) > 0;
    if (hasZoning) {
      writeFileSync(zoningFile, JSON.stringify(input!.erkannte_dokumente, null, 2));
      ctx.emit('ese_mapper_zoning_handed_to_solver', {
        blockCount: input!.erkannte_dokumente!.length,
        zoningFile,
      });
    }

    try {
      const atomsPath = process.env.ELSTER_ATOMS_PATH ?? DEFAULT_ATOMS_PATH;
      const paragraphsPath = process.env.ELSTER_PARAGRAPHS_PATH ?? DEFAULT_PARAGRAPHS_PATH;
      if (!existsSync(atomsPath)) {
        throw new Error(
          `atoms.json not found at ${atomsPath}. Container 0711:elster:bmf:jahresdok-2024:v2 ` +
            `muss als Snapshot unter src/verticals/elster-v3/data/atoms.json deployed sein.`,
        );
      }
      const args = [
        solverPath,
        '--ocr', ocrFile,
        '--output', outFile,
        '--atoms', atomsPath,
        '--paragraphs', paragraphsPath,
        '--steuerjahr', String(input.steuerjahr ?? 2023),
      ];
      if (hasZoning) args.push('--zoning', zoningFile);
      if (ctx.config?.runLane1Verifier !== false) args.push('--lane1-verify');
      if (ctx.config?.runCascadeFallback === true) args.push('--cascade-fallback');

      await runSubprocess(pythonBin, args, timeoutSec * 1000, ctx);

      const result = JSON.parse(readFileSync(outFile, 'utf-8'));
      const locks: Record<string, ESELock> = {};
      const ecodes: Record<string, string | number> = {};
      let convergenceCount = 0;

      for (const [key, lock] of Object.entries(result.locks ?? {})) {
        if (key.startsWith('PSEUDO_')) continue;
        const l = lock as ESELock;
        locks[key] = l;
        const baseEcode = l.ecode;
        if (!(baseEcode in ecodes)) ecodes[baseEcode] = l.value;
        if (l.confidence === 1.0) convergenceCount++;
      }

      const ms = Date.now() - t0;
      ctx.emit('ese_mapper_completed', {
        lockCount: Object.keys(locks).length,
        convergenceCount,
        lane1: !!result.lane1_result_summary,
        ms,
      });

      return {
        locks,
        ecodes,
        lockCount: Object.keys(locks).length,
        convergenceCount,
        lane1Result: result.lane1_result_summary,
        ms,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
});

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Konvertiert die Block-Liste von gemma-vision-ocr-zoning in einen
 * strukturierten OCR-Text mit expliziten Block-Markern. Der Python-Solver
 * kann seine Spatial-Zoning-Logik (Welle 2) damit präzise auf die echten
 * Anlagen-Person-Zonen anwenden, statt sie heuristisch aus dem flachen
 * OCR-Text zu suchen.
 *
 * Output-Format (Block-Header + Zeilen mit [NNN] Präfix):
 *   === HAUPTVORDRUCK_ESTA1 (Person A) ===
 *   [001] Steuernummer 02/171/51864
 *   [002] ...
 *
 *   === ANLAGE_N (Person A) ===
 *   [047] 5. Bruttoarbeitslohn 63.559,90 €
 *   ...
 */
function erkannteDokumenteToStructuredText(
  blocks: NonNullable<ESEMapperInput['erkannte_dokumente']>,
): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const person = b.gehoert_zu_person ?? 'Unbekannt';
    const header = `=== ${b.dokumenten_typ.toUpperCase()} (Person ${person}) ===`;
    parts.push(header);
    for (const z of b.ocr_zeilen ?? []) {
      const tag = `[${String(z.zeilen_nr).padStart(3, '0')}]`;
      parts.push(`${tag} ${z.text}`);
    }
    parts.push(''); // Leerzeile zwischen Blöcken für Spatial-Zoning-Trennung
  }
  return parts.join('\n');
}

function runSubprocess(
  bin: string,
  args: string[],
  timeoutMs: number,
  ctx: { logger: { info: (m: string) => void; error: (m: string) => void } },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // OLLAMA_URL für welle4_cascade.py: env-default, fallback auf
    // host.docker.internal für Container-Deployments (sturm-mandanten:
    // localhost im Container ist NICHT Ollama; Host-Bridge nötig).
    const childEnv = {
      ...process.env,
      OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434/api/embed',
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`solver timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      ctx.logger.info(`solver: ${chunk.toString().trim()}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`solver exit ${code}: ${stderr}`));
    });
  });
}
