/**
 * Extraction-Fingerprint — content-addressed end-to-end identity for a run.
 *
 * Jeder ELSTER-Extraktions-Lauf bekommt einen kryptografischen Fingerabdruck
 * der ALLE wesentlichen Komponenten bindet:
 *
 *   container.merkle_root      — welche BMF-Atom-Wahrheit
 *   container.container_sha256 — Catalog-Manifest-Hash
 *   embedder.family + seed     — welcher Vektorraum, deterministisch
 *   cascade.artifact_sha256s   — TurboQuant-Indices identifizierend
 *   llm.model_pin              — welcher Gemma-4-Snapshot (kein "latest")
 *   schema.sha256              — nested_schema bei FSM-Pfad
 *   input.pdf_sha256           — Eingabe-Dokument
 *   input.text_sha256          — pdftotext-Output (deterministisch)
 *   stage_versions             — Code-Versionen der durchlaufenen Stages
 *
 * sha256(jcs(components)) → 32 Bytes, eine ID. Identische Eingabe + identische
 * Komponenten → identischer Fingerprint → byte-für-byte Replay möglich.
 *
 * Signatur: HMAC-SHA256 wie im bestehenden master-signer (Ed25519-Migration ist
 * Phase G+). Key wird über `resolveMasterKey()` aufgelöst.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ALG = 'HMAC-SHA256';
const FINGERPRINT_VERSION = 1;

// ─── JCS (RFC 8785) — minimale kanonische JSON-Serialisierung ──────────────

function jcs(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys
    .map((k) => JSON.stringify(k) + ':' + jcs((v as Record<string, unknown>)[k]))
    .join(',') + '}';
}

// ─── Komponenten-Beschreibung ──────────────────────────────────────────────

/** Strukturierte Beschreibung aller Determinanten eines Runs. */
export interface FingerprintComponents {
  /** Schema/Algorithmus-Version dieses Fingerprint-Formats. */
  fingerprint_version: number;
  /** Container-Identität. */
  container: {
    id: string;
    catalog_version: string;
    merkle_root: string;
    container_sha256: string;
  };
  /** Embedding-Layer. */
  embedder: {
    family: string;
    /** Native dim (vor MRL-truncation). */
    dim: number;
    /** TurboQuant projection seed (falls quantisiert). */
    seed?: number;
    /** sha256 jedes geladenen Embedding-Artefakts (cascade + exact). */
    artifact_sha256s: Record<string, string>;
  };
  /** LLM-Komponente (optional — nur wenn Disambig-Hop tatsächlich getriggert). */
  llm?: {
    /** Pinned model id, z.B. "google/gemma-4-31b-it@sha256:abc…". */
    model_pin: string;
    /** TurboQuant KV-Bitrate (b=4 für gemma4-mm production). */
    kv_quant_b?: number;
    temperature: number;
    max_tokens?: number;
    schema_sha256?: string;
  };
  /** Input-Identität. */
  input: {
    /** sha256 der PDF-Bytes. */
    pdf_sha256: string;
    /** sha256 des pdftotext-Outputs (für text-path replay). */
    text_sha256?: string;
    filename: string;
  };
  /** Code-Versionen der durchlaufenen Stages — Drift-Detektion. */
  stage_versions: Record<string, string>;
  /** ISO-Timestamp (informational — nicht Teil des Fingerprint-Hashes). */
  generated_at?: string;
}

export interface ExtractionFingerprint {
  /** Der eigentliche Fingerprint: sha256 über jcs(components). */
  digest: string;
  /** Volle Komponenten-Beschreibung (eingehängt in Run-Artefakte). */
  components: FingerprintComponents;
  /** HMAC-SHA256 über digest mit dem Master-Key. */
  signature?: { alg: typeof ALG; value: string; keyId: string };
}

// ─── Hash-Hilfsfunktionen ─────────────────────────────────────────────────

/** sha256 hex über Bytes oder String. */
export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 hex über Datei-Inhalt. */
export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

// ─── Fingerprint-Erzeugung ────────────────────────────────────────────────

/**
 * Bildet den deterministischen Fingerprint aus den Komponenten.
 *
 * Der `generated_at`-Timestamp wird vor dem Hashen entfernt damit derselbe
 * logische Run an verschiedenen Wallclock-Zeiten denselben Digest produziert.
 */
export function computeFingerprint(
  components: Omit<FingerprintComponents, 'fingerprint_version'> &
    Partial<Pick<FingerprintComponents, 'fingerprint_version'>>,
): ExtractionFingerprint {
  const full: FingerprintComponents = {
    fingerprint_version: components.fingerprint_version ?? FINGERPRINT_VERSION,
    ...components,
  };
  // Strip the timestamp from the hash payload — replay must yield identical
  // digests across wall-clock invocations.
  const { generated_at: _ignored, ...forHash } = full;
  void _ignored;
  const digest = sha256(jcs(forHash));
  return {
    digest,
    components: { ...full, generated_at: full.generated_at ?? new Date().toISOString() },
  };
}

/**
 * Optional: HMAC-Signatur über den Digest. Verwendet denselben Key-Mechanismus
 * wie `master-signer.ts` — symmetrisch (rotation-fähig via keyId). Phase G+
 * Migration zu Ed25519 ist im master-signer-Kommentar geplant.
 */
export function signFingerprint(
  fp: ExtractionFingerprint,
  key: string,
  keyId = 'sturm-extract-v1',
): ExtractionFingerprint {
  const value = createHmac('sha256', key).update(fp.digest).digest('base64');
  return { ...fp, signature: { alg: ALG, value, keyId } };
}

/** Verifikation — gibt {valid, errors} zurück. */
export function verifyFingerprint(
  fp: ExtractionFingerprint,
  key: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!fp.signature) { errors.push('missing signature'); return { valid: false, errors }; }
  if (fp.signature.alg !== ALG) { errors.push(`unsupported alg ${fp.signature.alg}`); return { valid: false, errors }; }
  // Recompute digest from components (modulo generated_at).
  const recomputed = computeFingerprint(fp.components).digest;
  if (recomputed !== fp.digest) errors.push('digest mismatch — components were modified after signing');
  const expected = createHmac('sha256', key).update(fp.digest).digest('base64');
  if (expected !== fp.signature.value) errors.push('signature mismatch');
  return { valid: errors.length === 0, errors };
}

// ─── Replay-Zertifikat ─────────────────────────────────────────────────────

/**
 * Replay-Cert = Fingerprint + extrahiertes Ergebnis + per-Feld-Attestationen.
 *
 * Eine Datei pro Run, deterministisch reproduzierbar wenn Eingabe + Container
 * + Code identisch sind. Das ist das Audit-Artefakt: einreichen → unabhängig
 * verifizieren.
 */
export interface ReplayCertificate {
  fingerprint: ExtractionFingerprint;
  /** Per-Feld: (eCode, Wert, Provenance, optional Per-Feld-Signatur). */
  attestations: Array<{
    ecode: string;
    value: string | number | null;
    drucktext: string;
    anlage: string;
    pflicht: boolean;
    /** Wie der Wert ermittelt wurde — "regex-match", "cascade-grounded",
     *  "llm-disambig", "no-evidence". */
    method: 'regex-match' | 'cascade-grounded' | 'llm-disambig' | 'no-evidence';
    /** Konsens-Score über Engines/Quellen (1.0 = einstimmig). */
    confidence: number;
    /** Quelle: Beleg-Index + Zeile/Bbox/Snippet wo der Wert herkam. */
    source?: {
      beleg?: string;
      page?: number;
      line_no?: number;
      snippet?: string;
      bbox?: [number, number, number, number];
    };
    /** Cosine-Distanz zwischen Label-Embedding und Atom-Embedding. */
    cosine?: number;
    /** Format-Validation gegen atom.metadata.formatRegex. */
    format_valid?: boolean;
    /** Normalisierte Form (canon für ELSTER-Submission). */
    normalized?: string;
  }>;
  /** Optionale Pflicht-Vollständigkeits-Befunde pro Anlage. */
  pflicht_completeness?: Array<{
    anlage: string;
    expected: number;
    found: number;
    missing_ecodes: string[];
  }>;
}

/**
 * Helper: ein einzelnes Komponenten-Bundle baut man üblicherweise inkrementell
 * über den Lauf hinweg. Diese Funktion fügt eine LLM-Komponente nachträglich ein,
 * falls der Disambig-Hop tatsächlich gefeuert hat.
 */
export function attachLlmComponent(
  components: FingerprintComponents,
  llm: NonNullable<FingerprintComponents['llm']>,
): FingerprintComponents {
  return { ...components, llm };
}
