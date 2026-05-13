/**
 * elster-v5.2/bmf-rechner-compute — Lane-1 BMF Steuerberechnung.
 *
 * Input:  canonical_layer (deklarierte eCodes aus phase5-merge)
 * Output: erweiterter canonical_layer mit BERECHNETEN eCodes
 *         (zvE, Einkommensteuer, Soli, Grenzsteuersatz, …)
 *
 * Pipeline-Position: hinter phase5-merge, vor ERiC-XML-Emit.
 *
 * Implementierung über die Lane-1-MCP (`berechne_vollstaendige_steuer_v2`):
 * der MCP-Server nimmt eCodes nativ als `elster_felder` und liefert die
 * komplette Steuerberechnung inkl. Formel-Trace + §-Bezug zurück. Damit
 * brauchen wir keinen TS-Formel-Executor und keine canonical_field↔eCode-
 * Hand-Map — der MCP hat das intern.
 *
 * Graceful Degradation: MCP-Down → kpi_warning + leere computed_values,
 * canonical_layer bleibt unverändert. Pipeline schlägt nicht fehl.
 */
import { defineStage } from '../../../core/stage.ts';
import { BmfMcpClient, canonicalLayerToElsterFelder, type BmfSteuerErgebnis } from '../../../lib/bmf-mcp-client.ts';
import type { CanonicalValue } from './phase5-merge.ts';

/** Map: MCP-Output-Key → ELSTER eCode + Drucktext + Anlage.
 *  Konservative Auswahl der wichtigsten BMF-Ausgabewerte. Erweitern wenn
 *  weitere MCP-Felder relevant werden. */
const MCP_OUTPUT_TO_ECODE: Record<string, { eCode: string; drucktext: string; anlage: string }> = {
  zve:                  { eCode: 'E0107101', drucktext: 'zu versteuerndes Einkommen',  anlage: 'ESt1A' },
  einkommensteuer:      { eCode: 'E0107201', drucktext: 'tarifliche Einkommensteuer',  anlage: 'ESt1A' },
  solidaritaetszuschlag:{ eCode: 'E0107501', drucktext: 'Solidaritätszuschlag',         anlage: 'ESt1A' },
  gesamtsteuer:         { eCode: 'E0107301', drucktext: 'festzusetzende Steuer',        anlage: 'ESt1A' },
};

export interface BmfRechnerComputeInput {
  /** canonical_layer aus phase5-merge: eCode → CanonicalValue (deklariert). */
  canonical_layer: Record<string, CanonicalValue>;
}

export interface BmfRechnerComputeOutput {
  /** Erweiterter canonical_layer: deklariert + berechnet. */
  canonical_layer: Record<string, CanonicalValue>;
  /** Nur die berechneten Werte (für UI-Sektionierung). */
  computed_layer: Record<string, CanonicalValue>;
  /** MCP-Originalantwort als Audit-Artefakt. */
  mcp_raw?: BmfSteuerErgebnis;
  stats: {
    declared_in: number;
    computed_out: number;
    fall_id: string | null;
    ms: number;
    error?: string;
  };
}

export interface BmfRechnerComputeConfig {
  /** MCP-URL. Default: process.env.BMF_MCP_URL oder http://localhost:12010/mcp */
  mcpUrl?: string;
  /** Veranlagungsjahr. Default: aktuelles Jahr − 1 (Steuererklärung läuft ein Jahr nach). */
  veranlagungsjahr?: number;
  /** Per-Call Timeout. Default 15s. */
  timeoutMs?: number;
  /** Bei MCP-Fehler: hart failen statt graceful-skip. Default false. */
  failHard?: boolean;
}

function formatCurrencyAsCents(n: number): string {
  return String(Math.round(n * 100));
}

export const bmfRechnerComputeStage = defineStage<
  BmfRechnerComputeInput,
  BmfRechnerComputeOutput,
  BmfRechnerComputeConfig
>({
  id: 'elster-v5_2/bmf-rechner-compute',
  name: 'Phase 6 — Lane-1 BMF Steuerberechnung',
  description:
    'Schickt den canonical_layer (deklarierte eCodes) an die Lane-1 BMF-MCP ' +
    '(`berechne_vollstaendige_steuer_v2`). MCP berechnet zvE, ESt, Soli, ' +
    'Gesamtsteuer mit Formel-Trace + §EStG-Bezug. Berechnete Werte werden ' +
    'als CanonicalValue mit origin=BMF_RECHNER in den Layer gemerged. ' +
    'Graceful Degradation bei MCP-Down.',
  hints: {
    inputs: 'canonical_layer (eCode→CanonicalValue von phase5-merge)',
    outputs: 'canonical_layer (erweitert), computed_layer, mcp_raw, stats',
    configExample: '{"veranlagungsjahr":2024}',
    inputPorts: [{ name: 'canonical_layer', type: 'json' }],
    outputPorts: [
      { name: 'canonical_layer', type: 'json' },
      { name: 'computed_layer', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const veranlagungsjahr = cfg.veranlagungsjahr ?? new Date().getFullYear() - 1;
    const failHard = cfg.failHard ?? false;
    const declared = input.canonical_layer ?? {};
    const declaredCount = Object.keys(declared).length;

    const result: BmfRechnerComputeOutput = {
      canonical_layer: { ...declared },
      computed_layer: {},
      stats: { declared_in: declaredCount, computed_out: 0, fall_id: null, ms: 0 },
    };

    if (declaredCount === 0) {
      ctx.emit('bmf_rechner_skip', { reason: 'empty canonical_layer' });
      result.stats.ms = Date.now() - t0;
      return result;
    }

    const elsterFelder = canonicalLayerToElsterFelder(declared);
    ctx.emit('bmf_rechner_start', {
      veranlagungsjahr,
      input_ecodes: Object.keys(elsterFelder),
      mcp_url: cfg.mcpUrl ?? process.env.BMF_MCP_URL ?? 'http://localhost:12010/mcp',
    });

    const client = new BmfMcpClient({ url: cfg.mcpUrl, timeoutMs: cfg.timeoutMs });

    let mcpResponse: BmfSteuerErgebnis;
    try {
      mcpResponse = await client.berechneVollstaendigeSteuerV2(
        { erklaerungsjahr: veranlagungsjahr, elster_felder: elsterFelder },
        ctx.signal,
      );
    } catch (err) {
      const msg = (err as Error).message;
      ctx.logger.warn('BMF-MCP unreachable / failed — graceful skip', { error: msg });
      ctx.emit('kpi_warning', { stage: 'bmf-rechner-compute', reason: 'mcp-unreachable', error: msg });
      result.stats.error = msg;
      result.stats.ms = Date.now() - t0;
      if (failHard) throw err;
      return result;
    }

    if (!mcpResponse.erfolg) {
      const msg = `MCP returned erfolg=false: ${JSON.stringify(mcpResponse.fehler ?? {})}`;
      ctx.emit('kpi_warning', { stage: 'bmf-rechner-compute', reason: 'mcp-error', error: msg });
      result.stats.error = msg;
      result.stats.ms = Date.now() - t0;
      if (failHard) throw new Error(msg);
      return result;
    }

    result.mcp_raw = mcpResponse;
    result.stats.fall_id = mcpResponse.daten.fall_id;

    // Wichtigste MCP-Outputs in canonical-Layer überführen
    const det = mcpResponse.daten.berechnungsdetails?.steuer_berechnung ?? {};
    const inputs_used = Object.keys(elsterFelder).reduce((acc, e) => {
      acc[e] = e;
      return acc;
    }, {} as Record<string, string>);

    for (const [mcpKey, meta] of Object.entries(MCP_OUTPUT_TO_ECODE)) {
      const raw = mcpResponse.daten[mcpKey as keyof typeof mcpResponse.daten];
      if (typeof raw !== 'number') continue;
      const cv: CanonicalValue = {
        eCode: meta.eCode,
        value: String(raw),
        normalized: formatCurrencyAsCents(raw),
        origin: 'BMF_RECHNER',
        anlage: meta.anlage,
        drucktext: meta.drucktext,
        vordruckzeile: '',
        datentyp: 'currency',
        kontextPath: null,
        rechner_id: 'tarif_32a',
        formula_string: det.formel_verwendet,
        paragraph_estg: det.bmf_referenz,
        inputs_used,
      };
      result.computed_layer[meta.eCode] = cv;
      result.canonical_layer[meta.eCode] = cv;
      ctx.emit('bmf_rechner_compute', {
        eCode: meta.eCode,
        drucktext: meta.drucktext,
        value: raw,
        rechner_id: cv.rechner_id,
        zone: det.steuerzone,
      });
    }

    result.stats.computed_out = Object.keys(result.computed_layer).length;
    result.stats.ms = Date.now() - t0;

    await ctx.artifacts.write('bmf_rechner_response.json', mcpResponse);
    await ctx.artifacts.write('computed_layer.json', result.computed_layer);

    ctx.emit('bmf_rechner_done', {
      declared: declaredCount,
      computed: result.stats.computed_out,
      fall_id: result.stats.fall_id,
      ms: result.stats.ms,
    });

    return result;
  },
});
