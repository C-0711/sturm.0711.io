/**
 * HTTP-Endpoints für den 5-Fragen-Onboarding-Wizard.
 *
 *   POST /api/applications/:appId/instances/:caseId/onboarding
 *     Body: OnboardingAnswers JSON
 *     → führt runOnboardingWizard() aus, persistiert in inst.context,
 *       returnt { ok, context }.
 *
 *   GET  /api/applications/:appId/instances/:caseId/onboarding
 *     → Status-Check: returnt { context } oder { context: null }.
 *
 * Auth: derselbe Ownership-Guard wie alle anderen
 * /api/applications/:appId/instances/:caseId/*-Routen (cookie-session ODER
 * Bearer). Wird vom Server-Mount-Order automatisch davor geschaltet.
 */

import express, { type Express } from 'express';
import {
  loadInstanceFile,
  saveInstanceFile,
} from './applications.ts';
import { getApplication } from '../core/registry.ts';
import {
  runOnboardingWizard,
  validateOnboardingAnswers,
} from './onboarding-wizard.ts';

export interface OnboardingEndpointOptions {
  /** Pfad zu `applications-data/` (gleicher Wert wie `APPLICATIONS_DIR`). */
  applicationsDir: string;
}

export function registerOnboardingEndpoint(
  app: Express,
  opts: OnboardingEndpointOptions,
): void {
  const ROOT = opts.applicationsDir;

  // POST — Wizard-Antworten speichern
  app.post(
    '/api/applications/:appId/instances/:caseId/onboarding',
    express.json({ limit: '32kb' }),
    async (req, res) => {
      const { appId, caseId } = req.params;
      if (!getApplication(appId)) {
        return res.status(404).json({ error: `application not found: ${appId}` });
      }
      const inst = await loadInstanceFile(ROOT, appId, caseId);
      if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });

      let answers;
      try {
        answers = validateOnboardingAnswers(req.body);
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }

      let context;
      try {
        context = runOnboardingWizard(answers);
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }

      inst.context = context;
      await saveInstanceFile(ROOT, inst);
      res.json({ ok: true, context });
    },
  );

  // GET — Status-Check (Context schon gesetzt?)
  app.get(
    '/api/applications/:appId/instances/:caseId/onboarding',
    async (req, res) => {
      const { appId, caseId } = req.params;
      if (!getApplication(appId)) {
        return res.status(404).json({ error: `application not found: ${appId}` });
      }
      const inst = await loadInstanceFile(ROOT, appId, caseId);
      if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
      res.json({ context: inst.context ?? null });
    },
  );
}
