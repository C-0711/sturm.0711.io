/**
 * Webhook system: persistent subscribers, monotonic event sequence, signed
 * payloads, retry-with-backoff delivery, dead-letter persistence.
 *
 * Layout:
 *   workspaces/<wsId>/.webhooks/
 *     log.jsonl                — append-only event log (all events for replay)
 *     seq.json                 — { lastSeq: N } monotonic per-workspace counter
 *     subscribers.json         — [{id, url, secret, events[], filters, createdAt}]
 *     deliveries.jsonl         — append-only delivery audit (subscriberId, eventId, attempts, lastStatus)
 *
 * Event payload (signed):
 *   {
 *     eventId:   "evt_<uuid>",
 *     eventSequence: <N>,         // monotonic per workspace
 *     eventType: "document.classified" | "document.extracted" | …,
 *     workspace: { id },
 *     pipeline:  { id, version },
 *     emittedAt: "ISO-8601",
 *     inputHash:  "sha256:…",     // from job/operation if applicable
 *     outputHash: "sha256:…",     // workspace verlaufHash after the change
 *     data:       { … event-specific … }
 *   }
 *
 * Headers per delivery:
 *   X-Sturm-Signature: t=<ms>,v1=<hex hmac-sha256(secret, "<t>.<body>")>
 *   X-Sturm-Event-Id: evt_<uuid>
 *   X-Sturm-Event-Type: <type>
 *   X-Sturm-Sequence: <N>
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

const SUBDIR = '.webhooks';

export type WebhookEventType =
  | 'document.ingested'
  | 'document.classified'
  | 'document.extracted'
  | 'document.audited'
  | 'document.approved'
  | 'document.citations_generated'
  | 'master.updated';

export interface WebhookSubscriber {
  id: string;
  url: string;
  secret: string;             // HMAC-Signaturen
  events: WebhookEventType[]; // [] = alle
  filters?: { workspaceId?: string }; // [] = alle
  active: boolean;
  createdAt: string;
  /** Optional friendly label */
  label?: string;
}

export interface WebhookEvent {
  eventId: string;
  eventSequence: number;
  eventType: WebhookEventType;
  workspace: { id: string };
  pipeline?: { id: string; version: string };
  emittedAt: string;
  inputHash?: string;
  outputHash?: string;
  data: Record<string, unknown>;
}

export interface DeliveryAttempt {
  subscriberId: string;
  eventId: string;
  attemptedAt: string;
  attempt: number;            // 1-based
  status: 'success' | 'failed';
  responseStatus?: number;
  errorMessage?: string;
  /** Next retry timestamp (or null if exhausted/success). */
  nextAttemptAt?: string | null;
}

const RETRY_DELAYS_MS = [0, 30_000, 5 * 60_000, 60 * 60_000, 6 * 60 * 60_000]; // 0s, 30s, 5min, 1h, 6h

function dir(workspacesDir: string, wsId: string): string {
  return path.join(workspacesDir, wsId, SUBDIR);
}

async function ensureDir(workspacesDir: string, wsId: string): Promise<void> {
  await fs.mkdir(dir(workspacesDir, wsId), { recursive: true });
}

// ---------- Sequence counter (monotonic per workspace) ----------

async function nextSequence(workspacesDir: string, wsId: string): Promise<number> {
  await ensureDir(workspacesDir, wsId);
  const fp = path.join(dir(workspacesDir, wsId), 'seq.json');
  let cur = 0;
  try { cur = (JSON.parse(await fs.readFile(fp, 'utf8')) as { lastSeq: number }).lastSeq; }
  catch { /* start at 0 */ }
  const next = cur + 1;
  await fs.writeFile(fp, JSON.stringify({ lastSeq: next }, null, 2));
  return next;
}

// ---------- Subscribers (CRUD) ----------

async function readSubscribers(workspacesDir: string, wsId: string): Promise<WebhookSubscriber[]> {
  const fp = path.join(dir(workspacesDir, wsId), 'subscribers.json');
  try { return JSON.parse(await fs.readFile(fp, 'utf8')); } catch { return []; }
}
async function writeSubscribers(workspacesDir: string, wsId: string, subs: WebhookSubscriber[]): Promise<void> {
  await ensureDir(workspacesDir, wsId);
  await fs.writeFile(path.join(dir(workspacesDir, wsId), 'subscribers.json'), JSON.stringify(subs, null, 2));
}

export async function addSubscriber(
  workspacesDir: string,
  wsId: string,
  args: { url: string; events?: WebhookEventType[]; secret?: string; label?: string },
): Promise<WebhookSubscriber> {
  if (!/^https?:\/\//.test(args.url)) throw new Error('subscriber.url must be http(s)://');
  const subs = await readSubscribers(workspacesDir, wsId);
  const sub: WebhookSubscriber = {
    id: 'sub_' + randomUUID(),
    url: args.url,
    secret: args.secret ?? randomUUID().replace(/-/g, ''),
    events: args.events ?? [],
    active: true,
    createdAt: new Date().toISOString(),
    label: args.label,
  };
  subs.push(sub);
  await writeSubscribers(workspacesDir, wsId, subs);
  return sub;
}
export async function listSubscribers(workspacesDir: string, wsId: string): Promise<WebhookSubscriber[]> {
  return readSubscribers(workspacesDir, wsId);
}
export async function deleteSubscriber(workspacesDir: string, wsId: string, id: string): Promise<boolean> {
  const subs = await readSubscribers(workspacesDir, wsId);
  const next = subs.filter((s) => s.id !== id);
  if (next.length === subs.length) return false;
  await writeSubscribers(workspacesDir, wsId, next);
  return true;
}

// ---------- Event log ----------

export async function appendEventLog(workspacesDir: string, wsId: string, event: WebhookEvent): Promise<void> {
  await ensureDir(workspacesDir, wsId);
  await fs.appendFile(path.join(dir(workspacesDir, wsId), 'log.jsonl'), JSON.stringify(event) + '\n');
}

export async function readEventLog(workspacesDir: string, wsId: string, fromSeq = 0): Promise<WebhookEvent[]> {
  const fp = path.join(dir(workspacesDir, wsId), 'log.jsonl');
  let raw: string;
  try { raw = await fs.readFile(fp, 'utf8'); } catch { return []; }
  const out: WebhookEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as WebhookEvent;
      if (ev.eventSequence >= fromSeq) out.push(ev);
    } catch { /* skip */ }
  }
  return out;
}

// ---------- Delivery audit ----------

async function appendDelivery(workspacesDir: string, wsId: string, attempt: DeliveryAttempt): Promise<void> {
  await ensureDir(workspacesDir, wsId);
  await fs.appendFile(path.join(dir(workspacesDir, wsId), 'deliveries.jsonl'), JSON.stringify(attempt) + '\n');
}

export async function readDeliveries(workspacesDir: string, wsId: string, subscriberId?: string): Promise<DeliveryAttempt[]> {
  const fp = path.join(dir(workspacesDir, wsId), 'deliveries.jsonl');
  let raw: string;
  try { raw = await fs.readFile(fp, 'utf8'); } catch { return []; }
  const out: DeliveryAttempt[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as DeliveryAttempt;
      if (!subscriberId || a.subscriberId === subscriberId) out.push(a);
    } catch { /* skip */ }
  }
  return out;
}

// ---------- Signing + delivery ----------

/** Build the X-Sturm-Signature header value (Stripe-style: `t=<ms>,v1=<hmac>`).
 *  Receivers verify by recomputing HMAC over `<t>.<body>` and comparing v1. */
export function signPayload(secret: string, body: string, timestampMs: number = Date.now()): string {
  const sig = createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
  return `t=${timestampMs},v1=${sig}`;
}

async function deliverOne(sub: WebhookSubscriber, event: WebhookEvent): Promise<{ status: number | null; error?: string }> {
  try {
    const body = JSON.stringify(event);
    const signature = signPayload(sub.secret, body);
    const resp = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sturm-Signature': signature,
        'X-Sturm-Event-Id': event.eventId,
        'X-Sturm-Event-Type': event.eventType,
        'X-Sturm-Sequence': String(event.eventSequence),
      },
      body,
    });
    if (resp.ok) return { status: resp.status };
    return { status: resp.status, error: `non-2xx response: ${resp.status}` };
  } catch (e) {
    return { status: null, error: (e as Error).message ?? String(e) };
  }
}

/** Deliver event to all matching subscribers with retry-on-failure background loop.
 *  Resolves immediately after the first attempt; subsequent retries run in background. */
export async function deliverEvent(workspacesDir: string, wsId: string, event: WebhookEvent): Promise<void> {
  const subs = (await readSubscribers(workspacesDir, wsId)).filter(
    (s) => s.active && (s.events.length === 0 || s.events.includes(event.eventType)),
  );
  for (const sub of subs) {
    void retryDeliver(workspacesDir, wsId, sub, event, 1);
  }
}

async function retryDeliver(workspacesDir: string, wsId: string, sub: WebhookSubscriber, event: WebhookEvent, attempt: number): Promise<void> {
  const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? null;
  if (attempt > 1 && delayMs != null) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const r = await deliverOne(sub, event);
  const success = r.status != null && r.status >= 200 && r.status < 300;
  const exhausted = attempt >= RETRY_DELAYS_MS.length;
  const nextAttempt: string | null = success || exhausted
    ? null
    : new Date(Date.now() + (RETRY_DELAYS_MS[attempt] ?? 6 * 60 * 60_000)).toISOString();
  await appendDelivery(workspacesDir, wsId, {
    subscriberId: sub.id,
    eventId: event.eventId,
    attemptedAt: new Date().toISOString(),
    attempt,
    status: success ? 'success' : 'failed',
    responseStatus: r.status ?? undefined,
    errorMessage: r.error,
    nextAttemptAt: nextAttempt,
  });
  if (!success && !exhausted) {
    void retryDeliver(workspacesDir, wsId, sub, event, attempt + 1);
  }
}

// ---------- Public emit() helper used by route handlers ----------

export async function emitWebhookEvent(
  workspacesDir: string,
  wsId: string,
  args: {
    type: WebhookEventType;
    pipeline?: { id: string; version: string };
    inputHash?: string;
    outputHash?: string;
    data: Record<string, unknown>;
  },
): Promise<WebhookEvent> {
  const seq = await nextSequence(workspacesDir, wsId);
  const event: WebhookEvent = {
    eventId: 'evt_' + randomUUID(),
    eventSequence: seq,
    eventType: args.type,
    workspace: { id: wsId },
    pipeline: args.pipeline,
    emittedAt: new Date().toISOString(),
    inputHash: args.inputHash,
    outputHash: args.outputHash,
    data: args.data,
  };
  await appendEventLog(workspacesDir, wsId, event);
  // Fire-and-forget delivery
  void deliverEvent(workspacesDir, wsId, event);
  return event;
}
