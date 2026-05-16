/**
 * elster-v5_2-rag/felder-narrow — RAG-gestützte Engführung des Felder-Katalogs.
 *
 * Input:
 *   • felder_per_anlage  — vollständiger Anlage→AnlagenFelderListe-Katalog von
 *                          elster-v4/felder-katalog (alle Atome pro Anlage).
 *   • kandidatenECodes   — RAG-Treffer aus elster-v3/quantum-ground
 *                          (Embedding-Cascade + optional Pflicht-Scaffold).
 *
 * Output:
 *   felder_per_anlage — gleiche Struktur wie Input, aber pro Anlage nur noch:
 *     (a) alle Pflicht-Atome (immer beibehalten — Layer-1-Compliance), plus
 *     (b) Nicht-Pflicht-Atome, deren eCode in den RAG-Treffern auftaucht.
 *
 * Effekt: phase3-llm-fill bekommt ein erheblich kleineres Vokabular pro Anlage
 * (nur die für dieses Dokument relevanten Felder), was die Token-Kosten der
 * LLM-Calls senkt und die Treffer-Genauigkeit erhöht.
 *
 * Sicherheitsnetz: leere RAG-Treffer → unverändert durchreichen (fail-open).
 */
import { defineStage } from '../../../core/stage.ts';
import type { AnlagenFelderListe } from '../../../lib/elster-catalog.ts';
import type { RagIndexHandle } from '../../../core/tools/handles.ts';
import type { KandidatECode } from './quantum-ground.ts';

export interface FelderNarrowInput {
  felder_per_anlage: Record<string, AnlagenFelderListe>;
  kandidatenECodes: KandidatECode[];
}

export interface FelderNarrowConfig {
  /** Pflicht-Atome immer behalten, auch ohne RAG-Treffer. Default true. */
  pflichtAlwaysKeep?: boolean;
  /** Wenn RAG leer/null: Input unverändert durchreichen. Default true. */
  passthroughOnEmptyRag?: boolean;
  /** Minimum-Felder pro Anlage nach Narrow. Wenn weniger übrig sind,
   *  füllen wir aus dem Original-Katalog auf (geordnet wie geliefert,
   *  i.d.R. Pflicht zuerst, dann Vordruckzeile). Schützt vor RAG-Hunger
   *  + Katalogen ohne Pflicht-Flags (z.B. Anlage N hat 0 pflicht-Atome).
   *  Default 30. Auf 0 setzen, um die Aufstockung zu deaktivieren. */
  minPerAnlage?: number;
}

export interface FelderNarrowOutput {
  felder_per_anlage: Record<string, AnlagenFelderListe>;
  stats: {
    inputFelder: number;
    outputFelder: number;
    pflichtKept: number;
    ragKept: number;
    floorTopUp: number;
    droppedNonPflicht: number;
  };
  ms: number;
}

export const felderNarrowStage = defineStage<
  FelderNarrowInput,
  FelderNarrowOutput,
  FelderNarrowConfig
>({
  id: 'elster-v5_2-rag/felder-narrow',
  name: 'Felder-Narrow — RAG-gestützte Engführung pro Anlage',
  description:
    'Schneidet pro Anlage die vom Catalog gelieferte Felder-Liste auf die ' +
    'Vereinigung aus (a) allen Pflicht-Atomen und (b) den RAG-getroffenen ' +
    'eCodes zurück. Reduziert das Layer-1-Vokabular ohne Pflicht-Compliance ' +
    'zu verlieren. Fail-open: keine RAG-Treffer → unverändertes Passthrough.',
  hints: {
    inputs: 'felder_per_anlage (voll), kandidatenECodes[] (von quantum-ground)',
    outputs: 'felder_per_anlage (eingegrenzt, gleiche Struktur)',
    configExample: JSON.stringify({ pflichtAlwaysKeep: true, passthroughOnEmptyRag: true }, null, 2),
    inputPorts: [
      { name: 'felder_per_anlage', type: 'json' },
      { name: 'kandidatenECodes', type: 'candidates' },
    ],
    outputPorts: [{ name: 'felder_per_anlage', type: 'json' }],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const pflichtAlwaysKeep = cfg.pflichtAlwaysKeep ?? true;
    const passthroughOnEmptyRag = cfg.passthroughOnEmptyRag ?? true;
    const minPerAnlage = cfg.minPerAnlage ?? 30;
    // P7: tools-handle für Observability (RAG-Container-Identität ins SSE-Event).
    // Diese Stage selbst konsumiert die RAG-Treffer als Input (kandidatenECodes)
    // — kein direkter cascade-Call. Ein Handle-Lookup hier macht den
    // Tool-Roster-Status für den Run sichtbar (Designer/Audit), ohne die
    // Algorithmik zu ändern.
    const rag = ctx.tools.has('elster-rag')
      ? ctx.tools.get<RagIndexHandle>('elster-rag')
      : null;
    void rag;

    const fpa = input.felder_per_anlage ?? {};
    const kandidaten = Array.isArray(input.kandidatenECodes) ? input.kandidatenECodes : [];

    const inputFelder = Object.values(fpa).reduce((s, l) => s + (l.felder?.length ?? 0), 0);

    if (kandidaten.length === 0 && passthroughOnEmptyRag) {
      ctx.emit('felder_narrow_passthrough', { reason: 'empty-rag', inputFelder });
      return {
        felder_per_anlage: fpa,
        stats: {
          inputFelder,
          outputFelder: inputFelder,
          pflichtKept: 0,
          ragKept: 0,
          floorTopUp: 0,
          droppedNonPflicht: 0,
        },
        ms: Date.now() - t0,
      };
    }

    // RAG-Treffer in einen Lookup-Set (per eCode bzw. field_name).
    const ragSet = new Set<string>();
    for (const k of kandidaten) {
      if (k?.field_name) ragSet.add(k.field_name);
    }

    const narrowed: Record<string, AnlagenFelderListe> = {};
    let pflichtKept = 0;
    let ragKept = 0;
    let floorTopUp = 0;
    let droppedNonPflicht = 0;

    for (const [anlage, liste] of Object.entries(fpa)) {
      const origFelder = liste.felder ?? [];
      const kept = origFelder.filter((f) => {
        if (pflichtAlwaysKeep && f.pflicht) { pflichtKept++; return true; }
        if (ragSet.has(f.eCode)) { ragKept++; return true; }
        droppedNonPflicht++;
        return false;
      });

      // Floor-Aufstockung: wenn pro Anlage zu wenig Felder übrig sind
      // (häufig bei Anlagen ohne pflicht-Flags + dünner RAG-Treffer), aus
      // dem Original-Katalog (welcher schon pflicht-zuerst + Vordruckzeile-
      // sortiert ist) auffüllen, bis minPerAnlage erreicht ist.
      if (minPerAnlage > 0 && kept.length < minPerAnlage && origFelder.length > kept.length) {
        const have = new Set(kept.map((f) => f.eCode));
        for (const f of origFelder) {
          if (kept.length >= minPerAnlage) break;
          if (have.has(f.eCode)) continue;
          kept.push(f);
          have.add(f.eCode);
          floorTopUp++;
          droppedNonPflicht = Math.max(0, droppedNonPflicht - 1);
        }
      }

      narrowed[anlage] = { anlage: liste.anlage, felder: kept };
      ctx.emit('felder_narrow_anlage', {
        anlage,
        inputFelder: origFelder.length,
        outputFelder: kept.length,
      });
    }

    const outputFelder = Object.values(narrowed).reduce((s, l) => s + l.felder.length, 0);
    await ctx.artifacts.write('felder_narrowed.json', narrowed);
    ctx.emit('felder_narrow_done', {
      inputFelder,
      outputFelder,
      pflichtKept,
      ragKept,
      floorTopUp,
      droppedNonPflicht,
    });

    return {
      felder_per_anlage: narrowed,
      stats: { inputFelder, outputFelder, pflichtKept, ragKept, floorTopUp, droppedNonPflicht },
      ms: Date.now() - t0,
    };
  },
});
