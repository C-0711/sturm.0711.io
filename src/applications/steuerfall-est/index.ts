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
  });
}
