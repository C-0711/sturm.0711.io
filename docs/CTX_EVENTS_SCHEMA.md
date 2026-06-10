# CTX Events Schema (B7)

**Append-only audit log** for every ctx-Container. File: `<container.outDir>/events.jsonl`,
one JSON object per line, UTF-8, no trailing comma.

Records are emitted via `src/lib/ctx-events.ts::emitCtxEvent()`. Audit-log writes
are best-effort and never block or fail a request — a corrupted disk should never
break retrieval.

## Canonical Event Types

| event              | When                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `created`          | First publish of this container                                      |
| `retrieved`        | `POST /:id/retrieve` succeeded with ≥1 hit                           |
| `retrieved_empty`  | `POST /:id/retrieve` succeeded but returned 0 hits                   |
| `retrieved_403`    | `POST /:id/retrieve` blocked by ACL (Phase B3)                       |
| `retrieved_404`    | `POST /:id/retrieve` for missing container                           |
| `rate_limit_hit`   | nginx or per-device quota rejected the request (Phase B4/B5)         |
| `preamble_fetched` | `GET /:id/preamble` pulled (any surface)                             |
| `atom_fetched`     | `GET /:id/atom/:slug` pulled                                         |
| `events_appended`  | External agent appended a custom event via `POST /:id/events`        |
| `acl_changed`      | `PATCH /:id` updated `meta.acl` (Phase B3)                           |
| `visibility_changed` | `PATCH /:id` toggled `public`/`private` (Phase B8)                 |
| `deleted`          | Container removed from registry                                      |
| `anchored`         | Container sealed on Base mainnet (Phase C6) — payload has `tx_hash`  |

External agents are free to append custom event types via `POST /:id/events`.
Their `event` string is recorded verbatim, but a meta-event `events_appended`
is emitted alongside so audit consumers can distinguish first-party from
third-party log entries.

## Record Shape

```typescript
interface CtxEventBase {
  ts: string;              // ISO-8601 UTC, always set
  event: string;           // one of CtxEventType (or custom for /events POST)
  container_id: string;    // "0711:ctx:<ns>:<shortId>"
  device_id?: string;      // opaque id from X-Device-Id header or 'ua:<hash>' or 'anonymous'
  ip_hash?: string;        // sha256(ip).hex.slice(0,16) — NEVER the raw IP
  query_hash?: string;     // sha256(query).hex.slice(0,16) — for dup-detection without storing text
  hit_count?: number;      // returned hits (retrieved/retrieved_empty)
  k?: number;              // requested K
  latency_ms?: number;     // wall-clock duration of the request
  details?: Record<string, unknown>; // free-form for non-canonical events
}
```

## Privacy Principles

- **No raw IPs.** Only `sha256(ip)[:16]`. Sufficient for rate-abuse correlation
  in a session but not reconstructable to the source.
- **No raw queries.** Only `sha256(query)[:16]`. Same query from the same device
  shows the same `query_hash` so caching and "user kept hammering the same thing"
  patterns are detectable, but the actual search text is not stored.
- **Device IDs are opaque identifiers**, issued by the gateway's token broker
  (Phase B1). They are not PII — a device is not a person.
- **DSGVO request to delete container** removes `events.jsonl` along with all
  other container files (Phase E5).

## Backward Compatibility

This schema is **additive-only**. Existing events keep their meaning; new events
get new strings. Old records (from pre-B7 emission via the raw `appendFile` in
`POST /:id/events`) may lack any of the optional fields — consumers must
tolerate missing keys.

## Example

```jsonl
{"ts":"2026-05-24T07:12:33.421Z","event":"created","container_id":"0711:ctx:local:my-project-a1b2c3","device_id":"dev-bombas-mac","ip_hash":"3f5a82c7d1e09b34"}
{"ts":"2026-05-24T07:13:01.118Z","event":"preamble_fetched","container_id":"0711:ctx:local:my-project-a1b2c3","device_id":"dev-bombas-mac","ip_hash":"3f5a82c7d1e09b34","details":{"surface":"claude"}}
{"ts":"2026-05-24T07:13:42.901Z","event":"retrieved","container_id":"0711:ctx:local:my-project-a1b2c3","device_id":"dev-bombas-mac","ip_hash":"3f5a82c7d1e09b34","query_hash":"a91b3f2c80e5d716","hit_count":5,"k":5,"latency_ms":87}
{"ts":"2026-05-24T07:14:10.443Z","event":"rate_limit_hit","container_id":"0711:ctx:local:my-project-a1b2c3","device_id":"dev-anon-curl","ip_hash":"d92e1a48a3071b2c","details":{"limiter":"nginx-ctx_retrieve"}}
```

## Reading the Log

```bash
# tail the log via HTTP
curl https://sturm.0711.io/ctx/<id>/events

# locally on REACTOR
tail -F ~/0711/0711-STURM/runs/ctx/<shortId>/events.jsonl | jq

# aggregate top device-ids per container (last 1000 lines)
tail -n 1000 events.jsonl | jq -r '.device_id // "anon"' | sort | uniq -c | sort -rn
```

---

Schema version: **1** · Locked 2026-05-24 by Bombas as part of Phase B7.
Future changes require explicit version bump (set `_schema=2` on every new record).
