import type { StageDefinition, WorkflowDef } from './types.ts';
import type { ApplicationDef } from './application.ts';

const stageRegistry = new Map<string, StageDefinition<any, any, any>>();
const workflowRegistry = new Map<string, WorkflowDef>();
const applicationRegistry = new Map<string, ApplicationDef>();

export function registerStage(stage: StageDefinition<any, any, any>): void {
  if (stageRegistry.has(stage.id)) {
    throw new Error(`stage already registered: ${stage.id}`);
  }
  stageRegistry.set(stage.id, stage);
}

export function getStage(id: string): StageDefinition<any, any, any> | undefined {
  return stageRegistry.get(id);
}

export function listStages(): StageDefinition<any, any, any>[] {
  return Array.from(stageRegistry.values());
}

export function registerWorkflow(def: WorkflowDef): void {
  if (workflowRegistry.has(def.id)) {
    throw new Error(`workflow already registered: ${def.id}`);
  }
  // Validate: jede referenzierte Stage muss registriert sein
  for (const [stageId, stageDef] of Object.entries(def.stages)) {
    if (!stageRegistry.has(stageDef.uses)) {
      throw new Error(
        `workflow ${def.id}: stage "${stageId}" uses "${stageDef.uses}" which is not registered`
      );
    }
  }
  // Validate: Edges verweisen auf existierende Stages
  for (const [from, to] of def.edges) {
    if (!def.stages[from]) throw new Error(`workflow ${def.id}: edge from unknown stage "${from}"`);
    if (!def.stages[to])   throw new Error(`workflow ${def.id}: edge to unknown stage "${to}"`);
  }
  workflowRegistry.set(def.id, def);
}

export function getWorkflow(id: string): WorkflowDef | undefined {
  return workflowRegistry.get(id);
}

export function listWorkflows(): WorkflowDef[] {
  return Array.from(workflowRegistry.values());
}

/**
 * Registriert eine Anwendung. Referenzierte Workflows werden *weich* validiert
 * (Console-Warning), damit phasenweises Hinzukommen funktioniert.
 */
export function registerApplication(def: ApplicationDef): void {
  if (applicationRegistry.has(def.id)) {
    throw new Error(`application already registered: ${def.id}`);
  }
  for (const [trigger, workflowId] of Object.entries(def.workflows)) {
    if (workflowId && !workflowRegistry.has(workflowId)) {
      console.warn(
        `[application:${def.id}] trigger "${trigger}" referenziert Workflow "${workflowId}" — noch nicht registriert`,
      );
    }
  }
  applicationRegistry.set(def.id, def);
}

export function getApplication(id: string): ApplicationDef | undefined {
  return applicationRegistry.get(id);
}

export function listApplications(): ApplicationDef[] {
  return Array.from(applicationRegistry.values());
}
