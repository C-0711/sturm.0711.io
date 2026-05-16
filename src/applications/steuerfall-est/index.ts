/**
 * Anwendung: Steuerfall ESt (Einkommensteuererklärung)
 *
 * Lebenszyklus eines persistenten Falls:
 *   create   → Tax-Case-Container + Workspace anlegen, Mandant binden
 *   ingest   → Dokument-Upload triggert `elster-v5_2-rag` (RAG + 4-LLM-Ensemble)
 *   review   → Reviewer prüft canonical_layer + Validator-Output
 *   seal     → `steuerfall-seal` workflow: HMAC-Signatur + Commit + Anchor
 *   export   → `elster_einreichen` (Lane-5 MCP) sendet ERiC-XML
 *
 * Referenzierte Workflows können phasenweise nachgereicht werden — die Registry
 * warnt nur, bricht nicht ab.
 */

import { defineApplication } from '../../core/application.ts';
import type { ToolRef } from '../../core/tools/types.ts';

/**
 * Phase-P1 Tool-Roster: explizite Deklaration *aller* Werkzeuge, die der
 * Steuerfall-ESt-Lifecycle benutzt. Ersetzt im Effekt das frühere
 * `mcps` + `rag`-Sugar; beide Felder bleiben aus Backwards-Compat erhalten,
 * werden aber durch `def.tools` überschattet, sobald die Engine `resolveTools`
 * nutzt (P2). Reihenfolge spiegelt die CTAX-Tool-Tabelle wider.
 */
const steuerfallEstTools: ToolRef[] = [
  // 1 — Hochleistungs-Extraktor (vLLM, JSON-Schema-Mode)
  {
    name: 'gemma4-mm',
    kind: 'llm',
    required: true,
    alwaysOn: true,
    roles: ['extraction-llm', 'disambig-llm'],
    config: {
      provider: 'vllm',
      envBaseUrl: 'VLLM_URL',
      model: 'gemma4-mm',
      jsonMode: 'json_schema',
    },
  },
  // 2 — Kritischer Gegenleser / Klassifikations-Fallback (Anthropic Haiku)
  {
    name: 'claude-haiku',
    kind: 'llm',
    required: true,
    alwaysOn: false,
    roles: ['critic-llm', 'classify-fallback'],
    config: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      jsonMode: 'none',
    },
  },
  // 3 — Primärer Klassifizierer (Mistral-Small)
  {
    name: 'mistral-small',
    kind: 'llm',
    required: true,
    alwaysOn: false,
    roles: ['classify-primary', 'fallback-llm'],
    config: {
      provider: 'mistral',
      model: 'mistral-small-latest',
      jsonMode: 'json_object',
    },
  },
  // 4 — OCR-Primärquelle (Mistral OCR)
  {
    name: 'mistral-ocr',
    kind: 'llm',
    required: true,
    alwaysOn: false,
    roles: ['ocr-primary'],
    config: {
      provider: 'mistral',
      model: 'mistral-ocr-latest',
      jsonMode: 'none',
    },
  },
  // 5 — CPU-only Embedder mit Matryoshka-Truncation
  {
    name: 'embeddinggemma',
    kind: 'embedder',
    required: true,
    alwaysOn: true,
    roles: ['embed'],
    config: {
      provider: 'ollama',
      model: 'embeddinggemma',
      matryoshka: [128, 256, 512, 768],
      cpuOnly: true,
    },
  },
  // 6 — RAG-Index: TurboQuant-Cascade über ELSTER-Container
  {
    name: 'elster-rag',
    kind: 'rag-index',
    required: true,
    alwaysOn: true,
    roles: ['retrieve'],
    config: {
      containerId: '0711:elster:gemma4-tq:embeddings:v1',
      manifest: 'src/verticals/elster-v3/data/embeddings.gemma4.cascade.json',
      strategy: 'turboquant-cascade',
      tiers: ['d128', 'd256', 'd768', 'fp32'],
      topK: { d128: 512, d256: 128, d768: 32, fp32: 8 },
    },
  },
  // 7 — Statischer Katalog (Atoms + Container + Nested-Schemas)
  {
    name: 'elster-catalog',
    kind: 'catalog',
    required: true,
    alwaysOn: false,
    roles: ['catalog'],
    config: {
      containerId: '0711:elster:bmf:jahresdok-2024:v1',
      files: {
        atoms: 'src/verticals/elster-v3/data/atoms.json',
        container: 'src/verticals/elster-v3/data/container.json',
        nested: 'src/verticals/elster-v3/data/nested_schemas',
      },
    },
  },
  // 8 — Lane-1 BMF-Steuerrechner (MCP)
  {
    name: 'bmf-lane1',
    kind: 'mcp',
    required: true,
    alwaysOn: false,
    roles: ['steuerrechner'],
    config: {
      envUrl: 'BMF_MCP_URL',
      defaultUrl: 'http://localhost:12010/mcp',
      tools: ['berechne_vollstaendige_steuer_v2'],
    },
  },
  // 9 — Lane-5 ELSTER-Einreichung (MCP, optional)
  {
    name: 'elster-lane5',
    kind: 'mcp',
    required: false,
    alwaysOn: false,
    roles: ['einreichung'],
    config: {
      envUrl: 'ELSTER_MCP_URL',
      tools: ['elster_einreichen'],
    },
  },
  // 10 — Gitchain-Anker (on-seal-only) — IMMER aktiv (User-Vorgabe)
  {
    name: 'gitchain',
    kind: 'gitchain',
    required: true,
    alwaysOn: true,
    roles: ['anchor'],
    config: {
      envApi: 'GITCHAIN_API_URL',
      envDb: 'GITCHAIN_DATABASE_URL',
      envRepoRoot: 'GITCHAIN_REPO_ROOT',
      containerNamespace: 'ctax',
      anchorMode: 'on-seal-only',
    },
  },
];

export function buildSteuerfallEstApplication() {
  return defineApplication({
    id: 'steuerfall-est',
    name: 'Steuerfall ESt',
    description:
      'Einkommensteuererklärung als versionierter, versiegelbarer Steuerfall — ' +
      'Belegerfassung mit Retrieval-Augmented Extraction (TurboQuant + 4-LLM-' +
      'Konsens), BMF Lane-1 Steuerberechnung, ELSTER Lane-5 Einreichung.',
    category: 'tax',
    mandantRequired: true,
    containers: [
      '0711:elster:bmf:jahresdok-2024:v1',
      'lane1:bmf:rechner:2024:v1',
      'lane5:elster:einreichung:v1',
    ],
    workflows: {
      extraction: 'elster-v5_2-rag',
      seal: 'steuerfall-seal',
    },
    // Backwards-Compat: `mcps` + `rag` bleiben erhalten, damit ältere
    // Konsumenten (UI, Registry-Inspect) ohne Anpassung weiterarbeiten.
    // Sobald die Engine auf `resolveTools` umsteigt (P2), gewinnt `tools`.
    mcps: {
      'bmf-lane1': {
        envVar: 'BMF_MCP_URL',
        tools: ['berechne_vollstaendige_steuer_v2'],
        description:
          'Lane-1 BMF-Steuerrechner: zvE, tarifliche ESt, Soli, festzusetzende ' +
          'Steuer mit Formel-Trace + §EStG-Bezug.',
      },
      'bmf-lane5': {
        envVar: 'ELSTER_MCP_URL',
        tools: ['elster_einreichen'],
        description:
          'Lane-5 ELSTER-Einreichung: ERiC-XML wird signiert und an die ELSTER-' +
          'Schnittstelle übergeben; Rückgabe: Einreichungs-ID + Anlagen-Status.',
      },
    },
    rag: {
      containerId: '0711:elster:bmf:jahresdok-2024:v1',
      indexPath: 'src/verticals/elster-v3/data/embeddings.gemma4.tq-d128.bin',
      strategy: 'turboquant-cascade',
    },
    tools: steuerfallEstTools,
  });
}
