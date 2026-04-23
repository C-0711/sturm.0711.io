import type { WorkflowDef } from './types.ts';

/**
 * Identity-Helper: gibt die Definition unverändert zurück, aber mit strikter Typprüfung.
 * Ergänzt außerdem Defaults für `name`/`description` auf Stage-Ebene.
 */
export function defineWorkflow(def: WorkflowDef): WorkflowDef {
  const stages: WorkflowDef['stages'] = {};
  for (const [id, stage] of Object.entries(def.stages)) {
    stages[id] = {
      name: stage.name ?? id,
      ...stage,
    };
  }
  return { ...def, stages };
}

/**
 * Topologische Sortierung der Stages. Wirft bei Zyklen.
 * Parallelität: gibt Layer (Arrays paralleler Stages) zurück.
 */
export function topoLayers(def: WorkflowDef): string[][] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of Object.keys(def.stages)) {
    inDeg.set(id, 0);
    adj.set(id, []);
  }
  for (const [from, to] of def.edges) {
    adj.get(from)!.push(to);
    inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
  }
  const layers: string[][] = [];
  let frontier = Array.from(inDeg.entries())
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  const seen = new Set<string>();
  while (frontier.length) {
    layers.push(frontier);
    frontier.forEach(id => seen.add(id));
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adj.get(id)!) {
        const d = (inDeg.get(to) ?? 0) - 1;
        inDeg.set(to, d);
        if (d === 0) next.push(to);
      }
    }
    frontier = next;
  }
  if (seen.size !== Object.keys(def.stages).length) {
    const missing = Object.keys(def.stages).filter(id => !seen.has(id));
    throw new Error(`workflow ${def.id}: cycle detected, unresolved stages: ${missing.join(', ')}`);
  }
  return layers;
}
