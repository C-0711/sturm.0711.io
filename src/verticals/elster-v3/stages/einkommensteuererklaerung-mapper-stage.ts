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
import { join } from 'node:path';
import { defineStage } from '../../../core/stage.ts';

export interface ESEMapperInput {
  /** Roher OCR-Volltext einer Einkommensteuererklärung (alle Anlagen). */
  ocrText: string;
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
    if (!input?.ocrText) {
      ctx.logger.warn('einkommensteuererklaerung-mapper: leerer OCR-Text');
      return { locks: {}, ecodes: {}, lockCount: 0, convergenceCount: 0, ms: 0 };
    }

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

    // Write OCR to temp file, run Python solver, read JSON output
    const workDir = mkdtempSync(join(tmpdir(), 'elster-solver-'));
    const ocrFile = join(workDir, 'input.ocr.txt');
    const outFile = join(workDir, 'solver_result.json');
    writeFileSync(ocrFile, input.ocrText);

    try {
      const args = [
        solverPath,
        '--ocr', ocrFile,
        '--output', outFile,
        '--steuerjahr', String(input.steuerjahr ?? 2023),
      ];
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

function runSubprocess(
  bin: string,
  args: string[],
  timeoutMs: number,
  ctx: { logger: { info: (m: string) => void; error: (m: string) => void } },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
