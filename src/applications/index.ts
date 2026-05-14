/**
 * Anwendungs-Registry — analog zu src/workflows/index.ts.
 * Wird genau einmal beim Server-Boot aufgerufen (nach `registerAllWorkflows`,
 * damit die referenzierten Workflows bereits in der Registry stehen).
 */

import { registerApplication } from '../core/registry.ts';
import { buildSteuerfallEstApplication } from './steuerfall-est/index.ts';

export function registerAllApplications(): void {
  registerApplication(buildSteuerfallEstApplication());
}
