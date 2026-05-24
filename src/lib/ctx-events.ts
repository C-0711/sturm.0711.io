/**
 * ctx-events — append-only audit log for ctx-Containers (B7).
 *
 * Schema documented in `docs/CTX_EVENTS_SCHEMA.md`. All event-emitting
 * code paths in ctx-server.ts go through `emitCtxEvent()`.
 *
 * File layout: `<container.outDir>/events.jsonl` — one JSON object per line,
 * never modified after write, monotonically appended.
 *
 * Privacy: query text and IP are hashed (sha256, truncated to 16 hex chars)
 * before persisting. Device-id is recorded verbatim because it's an
 * opaque opaque identifier issued by the gateway, not PII.
 */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Canonical event types — additive, never rename/remove. */
export type CtxEventType =
  | 'created'           // container published for first time
  | 'retrieved'         // /:id/retrieve succeeded, returned ≥1 hit
  | 'retrieved_empty'   // /:id/retrieve succeeded but 0 hits
  | 'retrieved_403'     // /:id/retrieve blocked by ACL
  | 'retrieved_404'     // /:id/retrieve target missing
  | 'rate_limit_hit'    // request denied by limit_req
  | 'preamble_fetched'  // /:id/preamble pulled
  | 'atom_fetched'      // /:id/atom/:slug pulled
  | 'events_appended'   // external agent appended a custom event
  | 'acl_changed'       // PATCH /:id updated ACL
  | 'visibility_changed' // PATCH /:id updated public/private
  | 'deleted'           // container removed
  | 'anchored';         // sealed on-chain (Phase C6)

export interface CtxEventBase {
  /** ISO-8601 UTC timestamp, set by emitCtxEvent. */
  ts: string;
  /** One of CtxEventType (string-typed so external agents can append custom). */
  event: string;
  /** Container ID like `0711:ctx:local:...`. */
  container_id: string;
  /** Opaque device identifier from broker token (or 'anonymous'). */
  device_id?: string;
  /** sha256(ip)[:16], never the raw IP. */
  ip_hash?: string;
  /** sha256(query)[:16] — lets you spot duplicate queries without storing text. */
  query_hash?: string;
  /** Number of hits returned (retrieved/retrieved_empty). */
  hit_count?: number;
  /** Requested k parameter. */
  k?: number;
  /** End-to-end latency in milliseconds. */
  latency_ms?: number;
  /** Free-form details — useful for non-canonical events. */
  details?: Record<string, unknown>;
}

export interface EmitCtxEventInput {
  outDir: string;
  containerId: string;
  event: CtxEventType | string;
  deviceId?: string;
  ip?: string;
  query?: string;
  hitCount?: number;
  k?: number;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

/** sha256(value).hex.slice(0, 16) — 8 bytes is enough for dup-detection. */
function hash16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Append-only emit. Never throws — audit log failure must not break a request. */
export async function emitCtxEvent(input: EmitCtxEventInput): Promise<void> {
  const line: CtxEventBase = {
    ts: new Date().toISOString(),
    event: input.event,
    container_id: input.containerId,
  };
  if (input.deviceId) line.device_id = input.deviceId;
  if (input.ip) line.ip_hash = hash16(input.ip);
  if (input.query) line.query_hash = hash16(input.query);
  if (typeof input.hitCount === 'number') line.hit_count = input.hitCount;
  if (typeof input.k === 'number') line.k = input.k;
  if (typeof input.latencyMs === 'number') line.latency_ms = input.latencyMs;
  if (input.details) line.details = input.details;

  const path = join(input.outDir, 'events.jsonl');
  try {
    await appendFile(path, JSON.stringify(line) + '\n');
  } catch (err) {
    // Audit log failure is non-fatal — log to stderr but don't propagate.
    // eslint-disable-next-line no-console
    console.error(`[ctx-events] append failed for ${input.containerId}:`, (err as Error).message);
  }
}

/**
 * Best-effort client IP extraction from an Express request.
 * Honors X-Forwarded-For (first hop) when proxied behind nginx/caddy.
 */
export function extractClientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip ?? 'unknown';
}

/**
 * Best-effort device id from the request — checks X-Device-Id header,
 * else falls back to a hash of the user-agent (stable but anonymous).
 */
export function extractDeviceId(req: { headers: Record<string, unknown> }): string {
  const did = req.headers['x-device-id'];
  if (typeof did === 'string' && did.length > 0) return did;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) return `ua:${hash16(ua)}`;
  return 'anonymous';
}
