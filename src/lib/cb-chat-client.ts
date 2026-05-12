/**
 * Thin client for cb-chat (CTAX-Chat) integration.
 *
 * No persistent credentials — every call takes a session cookie that the
 * caller passes through. The server doesn't store the cookie; it lives only
 * on the request as `X-CBChat-Cookie` (or per-job).
 *
 * cb-chat's API surface (reverse-engineered from the case-doc page):
 *   GET  /api/faelle/<fallId>/dokumente         → list of doc-metadata rows
 *   GET  /api/documents/<ctax_document_id>/serve → file bytes
 *   GET  /api/pro/dokument/<id>/befunde         → LLM findings (haiku/opus)
 *
 * STURM only uses /faelle/<fallId>/dokumente + /documents/.../serve. The
 * befunde endpoint exists but adds no value — STURM re-classifies via mistral.
 */

const DEFAULT_BASE = 'https://cb-chat.0711.io';

export interface CbChatDocRow {
  /** numerischer DB-Primary-Key. Nicht für /serve nutzbar. */
  document_id: number;
  /** anwendungsseitige UUID-artige Kennung — die einzige die /serve akzeptiert. */
  ctax_document_id: string;
  filename: string;
  mime_type?: string;
  size_bytes?: number;
  doc_type?: string;
  haiku_doc_type?: string;
  status?: string;
  kurz_beschreibung?: string;
  created_at?: string;
  page_count?: number;
  field_count?: number;
  summary?: string;
  confidence?: number;
  artifact_id?: string | null;
  session_id?: string;
}

export interface CbChatClientOpts {
  baseUrl?: string;
  cookie: string;
  signal?: AbortSignal;
}

/**
 * Slim Fall-Row used by the workspace import modal — was the user picks
 * which case to pull instead of pasting a UUID.
 */
export interface CbChatFallRow {
  fall_id: string;
  fall_nummer?: string;
  steuerjahr?: number;
  status?: string;
  mandant_id?: string | null;
  primaer_profil?: string | null;
  /** vorname + familienname aus fall_daten.person, falls vorhanden */
  person_name?: string | null;
  session_phase?: string | null;
  erstellt_am?: string;
  /** completeness_percentage aus fall_daten.summary, falls vorhanden */
  vollstaendigkeit?: number | null;
  /** + erstattung / – nachzahlung aus fall_daten.summary, falls vorhanden */
  saldo?: number | null;
}

/** GET /api/faelle — Berater-Fall-Liste fuer das cb-chat-Konto hinter dem Cookie. */
export async function listCases(opts: CbChatClientOpts): Promise<CbChatFallRow[]> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const url = `${base}/api/faelle`;
  const resp = await fetch(url, {
    headers: { Cookie: opts.cookie, Accept: 'application/json' },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`cb-chat list cases ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as any;
  const rows: any[] = Array.isArray(data) ? data
    : Array.isArray(data?.faelle) ? data.faelle
    : Array.isArray(data?.cases) ? data.cases
    : null;
  if (!rows) throw new Error(`cb-chat list cases unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  return rows.map((r) => {
    const person = r.person_daten || r.fall_daten?.person || null;
    const personName = person
      ? [person.vorname, person.familienname || person.nachname].filter(Boolean).join(' ').trim() || null
      : null;
    const summary = r.zusammenfassung || r.fall_daten?.summary || null;
    const saldo = summary?.erstattung != null ? Number(summary.erstattung)
      : summary?.nachzahlung != null ? -Number(summary.nachzahlung)
      : null;
    return {
      fall_id: r.fall_id,
      fall_nummer: r.fall_nummer,
      steuerjahr: r.steuerjahr,
      status: r.status,
      mandant_id: r.mandant_id ?? null,
      primaer_profil: r.primaer_profil ?? null,
      person_name: personName,
      session_phase: r.session_phase ?? null,
      erstellt_am: r.erstellt_am,
      vollstaendigkeit: typeof summary?.completeness_percentage === 'number' ? summary.completeness_percentage : null,
      saldo,
    };
  });
}

/** GET /api/faelle/<fallId>/dokumente — returns the raw rows (with duplicates). */
export async function listCaseDocuments(fallId: string, opts: CbChatClientOpts): Promise<CbChatDocRow[]> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const url = `${base}/api/faelle/${encodeURIComponent(fallId)}/dokumente`;
  const resp = await fetch(url, {
    headers: { Cookie: opts.cookie, Accept: 'application/json' },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`cb-chat list ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as any;
  // cb-chat sometimes wraps in {dokumente: [...]} or {documents: [...]} — be tolerant.
  if (Array.isArray(data)) return data as CbChatDocRow[];
  if (Array.isArray(data?.dokumente)) return data.dokumente as CbChatDocRow[];
  if (Array.isArray(data?.documents)) return data.documents as CbChatDocRow[];
  throw new Error(`cb-chat list returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
}

/** Dedupe by ctax_document_id, keeping the first occurrence. */
export function dedupeByCtaxId(rows: CbChatDocRow[]): CbChatDocRow[] {
  const seen = new Set<string>();
  const out: CbChatDocRow[] = [];
  for (const r of rows) {
    if (!r.ctax_document_id || seen.has(r.ctax_document_id)) continue;
    seen.add(r.ctax_document_id);
    out.push(r);
  }
  return out;
}

/** GET /api/documents/<ctaxId>/serve — returns the binary content + content-type. */
export async function downloadDocument(ctaxId: string, opts: CbChatClientOpts): Promise<{ buffer: Buffer; mimeType: string }> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const url = `${base}/api/documents/${encodeURIComponent(ctaxId)}/serve`;
  const resp = await fetch(url, {
    headers: { Cookie: opts.cookie },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`cb-chat serve ${resp.status} for ${ctaxId}: ${(await resp.text()).slice(0, 200)}`);
  const ab = await resp.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    mimeType: resp.headers.get('content-type') ?? 'application/octet-stream',
  };
}
