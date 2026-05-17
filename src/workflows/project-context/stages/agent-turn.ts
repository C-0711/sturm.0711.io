/**
 * agent-turn — schreibt eine Zeile in events.jsonl. Append-only, keine
 * Konflikte beim parallelen Schreiben mehrerer Agenten in den Container.
 *
 * Format pro Zeile:
 *   {ts, agent, model, action, atom_ids, query?, response_sha?, project_sha}
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defineStage } from '../../../core/stage.ts';

interface TurnIn {
  containerId: string;
  agent: string;
  model?: string;
  action?: string;
  retrieved?: Array<{ atomId: string; score: number }>;
  query?: string;
  responseSha?: string;
}

interface TurnOut {
  eventPath: string;
  offset: number;        // byte offset where this event was appended
}

export const agentTurnStage = defineStage<TurnIn, TurnOut, never>({
  id: 'agent-turn',
  name: 'Agent-Turn loggen',
  description: 'Append-only event log entry — parallel-safe.',
  hints: {
    inputs: '{ agent, model?, action?, retrieved?, query?, responseSha? }',
    outputs: '{ eventPath, offset }',
  },
  async run(input, ctx) {
    const attach = ctx.results['attach']?.output as { workdir?: string; projectSha?: string } | undefined;
    if (!attach?.workdir) throw new Error('agent-turn: no attach.workdir');

    const eventPath = path.join(attach.workdir, 'events.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      run_id: ctx.runId,
      agent: input.agent,
      model: input.model ?? null,
      action: input.action ?? 'retrieve',
      atom_ids: input.retrieved?.map((h) => h.atomId) ?? [],
      query: input.query ?? null,
      response_sha: input.responseSha ?? null,
      project_sha: attach.projectSha ?? null,
    }) + '\n';

    const before = await fs.stat(eventPath).then((s) => s.size).catch(() => 0);
    await fs.appendFile(eventPath, line);
    ctx.emit('event.appended', { agent: input.agent, offset: before });
    return { eventPath, offset: before };
  },
});
