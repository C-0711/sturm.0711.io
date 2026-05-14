/**
 * STURM — "Anwendung" (Application) Definition
 *
 * Eine Anwendung ist eine Orchestrierung *über* Workflows: persistente
 * Workspace-/Fall-State, RAG-Anbindung, MCP-Komposition, Lifecycle (create →
 * ingest → seal → export). Workflows sind weiterhin reine DAGs aus Stages.
 *
 * Eine Anwendung referenziert Workflow-IDs für ihre Lifecycle-Trigger; die
 * Validation der Referenzen ist *weich* (Warnung statt Fehler), damit die
 * Registry assembliert auch während Workflows phasenweise hinzukommen.
 */

export type ApplicationId = string;

export interface ApplicationWorkflowRefs {
  /** Workflow gestartet bei Dokument-Upload (z.B. `elster-v5_2-rag`). */
  extraction?: string;
  /** Workflow zum Versiegeln eines Falls (HMAC + commit + anchor). */
  seal?: string;
  /** Optionale weitere Trigger (e.g. `review`, `audit`). Frei benannt. */
  [name: string]: string | undefined;
}

export interface ApplicationMcpRef {
  /** Optionale Default-URL. Env-Variable hat Vorrang. */
  url?: string;
  /** Env-Variable, aus der die URL gezogen wird (z.B. `BMF_MCP_URL`). */
  envVar: string;
  /** Tool-Namen, die diese MCP exposed (UI-Hinweis). */
  tools: string[];
  /** Menschenlesbare Kurzbeschreibung für UI. */
  description?: string;
}

export interface ApplicationRagRef {
  /** Gitchain-Catalog-Container-ID (z.B. `0711:elster:bmf:jahresdok-2024:v1`). */
  containerId: string;
  /** Optional: Pfad zum quantisierten Tier-0-Index. */
  indexPath?: string;
  /** Retrieval-Strategie ("turboquant-cascade" ist aktuell die einzige). */
  strategy?: 'turboquant-cascade';
}

export interface ApplicationDef {
  id: ApplicationId;
  name: string;
  description: string;
  /** UI-Kategorie für die Anwendungs-Liste. */
  category: 'tax' | 'document' | 'medical' | 'other';
  /** Muss der Aufrufer einen Mandanten binden, bevor Instanzen entstehen können? */
  mandantRequired: boolean;
  /** Gitchain-Container, die die Anwendung lesend referenziert. */
  containers?: string[];
  /** Workflows, die im Lifecycle dieser Anwendung getriggert werden. */
  workflows: ApplicationWorkflowRefs;
  /** Komponierte MCP-Bridges (z.B. BMF Lane-1, ELSTER Lane-5). */
  mcps?: Record<string, ApplicationMcpRef>;
  /** RAG-Konfiguration (Container + Index-Tier). */
  rag?: ApplicationRagRef;
}

/**
 * Identity-Helper mit strenger Typprüfung, analog zu `defineWorkflow`.
 * Setzt keine Defaults — Anwendungen müssen alle Felder explizit befüllen.
 */
export function defineApplication(def: ApplicationDef): ApplicationDef {
  if (!def.id) throw new Error('application: id missing');
  if (!def.name) throw new Error(`application ${def.id}: name missing`);
  if (!def.workflows) throw new Error(`application ${def.id}: workflows missing`);
  return def;
}
