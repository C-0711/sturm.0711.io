// validateSturmOutput.ts — Datenqualitäts-Gate vor schreibePass1.
// ════════════════════════════════════════════════════════════════════════════
// Verhindert dass kaputte STURM-Pass-2-Outputs ins case_state landen:
//   - "Maria Ute" als Wert für E0100301 (Nachname-Code)
//   - "Rainer Stricker" als Wert für E0100201 (Vorname-Code, nur 1 Wort erwartet)
//   - "abc" als Wert für ein Betrags-Feld
//   - "12-31" als Wert für ein Datums-Feld
//
// Heuristik:
//   1. Lade aus ag_catalog.elster_fields die {bezeichnung, value_type} pro Code
//   2. Pro Wert: Pattern-Match gegen erwartete Form
//   3. Bei Mismatch: reject (mit Log) oder mark low_confidence
//
// Architekturentscheidung: deterministische Regex+Lookup (keine LLM-Call)
// damit Pipeline schnell + reproduzierbar bleibt. Zweite GPU-LLM-Stage ist
// optional als Add-on möglich, hier nicht eingebaut.
// ════════════════════════════════════════════════════════════════════════════

import pg from "pg";

export interface Pass2Wert {
  elster_code: string;
  value: string;
  anlage: string;
  drucktext?: string;
  vordruckzeile?: string;
}

export interface ValidationIssue {
  elster_code: string;
  value: string;
  bezeichnung: string;
  reason: string;
  severity: "reject" | "low_confidence";
}

export interface ValidationResult {
  accepted: Pass2Wert[];
  rejected: ValidationIssue[];
  total: number;
}

// ─── Heuristik-Regeln ──────────────────────────────────────────────────────

const VORNAME_TYPISCH = new Set<string>([
  "maria", "anna", "ute", "lisa", "sandra", "stefanie", "julia", "monika",
  "ingrid", "renate", "petra", "andrea", "gabi", "gabriele", "kerstin",
  "susanne", "birgit", "sabine", "barbara", "claudia", "andrea", "tina",
  "christine", "manuela", "christiane", "doris", "angelika",
  "klaus", "hans", "peter", "stefan", "andreas", "michael", "thomas",
  "christian", "manuel", "daniel", "paul", "lukas", "tom", "jan", "tim",
  "jürgen", "wolfgang", "gerhard", "horst", "günter", "manfred", "bernd",
  "martin", "frank", "uwe", "rainer", "ralf", "wolfram", "joachim",
]);

function normalisiere(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Hauptregel: prüft einen einzelnen Pass-2-Wert gegen Bezeichnung + value_type.
 * Returnt null wenn ok, sonst Issue mit Severity.
 */
function pruefeWert(
  v: Pass2Wert,
  bezeichnung: string,
  valueType: string | null,
): { reason: string; severity: "reject" | "low_confidence" } | null {
  const wert = (v.value ?? "").toString().trim();
  if (wert === "") return null; // leerer Wert wird ohnehin in schreibePass1 gefiltert

  const bz = bezeichnung.toLowerCase();
  const istVorname = /\bvorname\b/.test(bz);
  const istNachname = /\bnachname\b/.test(bz) || (/\bname\b/.test(bz) && !istVorname && !/dateiname|firmenname|software/.test(bz));
  const istBetrag = !!valueType && /^(integer|decimal|number|betrag|cent|zahl)$/i.test(valueType);
  const istDatum = !!valueType && /^date$/i.test(valueType);

  // ── Regel V1: Vorname-Feld darf kein "Vorname Nachname"-Pattern enthalten ──
  if (istVorname && !istNachname) {
    // Mehr als ein Großbuchstaben-Wort: vermutlich Nachname mit reingerutscht
    if (/^[A-ZÄÖÜ][a-zäöüß-]+\s+[A-ZÄÖÜ][a-zäöüß-]+/.test(wert)) {
      return {
        reason: `Vorname-Feld enthält 'Vorname Nachname'-Pattern: "${wert}"`,
        severity: "reject",
      };
    }
  }

  // ── Regel V2: Nachname-Feld darf kein Doppelvornamen-Pattern enthalten ──
  if (istNachname && !istVorname) {
    const woerter = wert.split(/\s+/);
    if (woerter.length >= 2) {
      const allesVornamen = woerter.every((w) => VORNAME_TYPISCH.has(normalisiere(w)));
      if (allesVornamen) {
        return {
          reason: `Nachname-Feld enthält reine Vornamen: "${wert}"`,
          severity: "reject",
        };
      }
      // Mind. ein Wort ist typischer Vorname → low_confidence (kann Doppelname sein)
      const irgendVorname = woerter.some((w) => VORNAME_TYPISCH.has(normalisiere(w)));
      if (irgendVorname && woerter.length === 2) {
        return {
          reason: `Nachname-Feld enthält Vornamen-Token: "${wert}"`,
          severity: "low_confidence",
        };
      }
    }
  }

  // ── Regel B: Betrags-Feld muss numerisch sein ──
  if (istBetrag) {
    const cleaned = wert.replace(/[.,\s€]/g, "").replace(/^-/, "");
    if (!/^\d+$/.test(cleaned)) {
      return {
        reason: `Betrags-Feld (${valueType}) enthält nicht-numerischen Wert: "${wert}"`,
        severity: "reject",
      };
    }
  }

  // ── Regel D: Datums-Feld muss ISO oder DD.MM.YYYY sein ──
  if (istDatum) {
    if (!/^(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4})$/.test(wert)) {
      return {
        reason: `Datums-Feld enthält ungültiges Format: "${wert}"`,
        severity: "reject",
      };
    }
  }

  return null;
}

/**
 * Hauptfunktion: validiert eine Liste Pass-2-Werte gegen ag_catalog.elster_fields.
 * Returnt akzeptierte Werte (zum Schreiben) und rejected (zum Loggen).
 */
export async function validatePass2Output(
  values: Pass2Wert[],
  pool: pg.Pool,
): Promise<ValidationResult> {
  if (values.length === 0) {
    return { accepted: [], rejected: [], total: 0 };
  }

  const codes = Array.from(new Set(values.map((v) => v.elster_code)));
  let metaMap = new Map<string, { bezeichnung: string; value_type: string | null }>();
  try {
    const r = await pool.query<{ elster_code: string; bezeichnung: string | null; value_type: string | null }>(
      `SELECT DISTINCT ON (elster_code) elster_code, bezeichnung, value_type
         FROM ag_catalog.elster_fields
        WHERE elster_code = ANY($1::text[])
        ORDER BY elster_code, tax_year DESC`,
      [codes],
    );
    for (const row of r.rows) {
      metaMap.set(row.elster_code, {
        bezeichnung: row.bezeichnung ?? "",
        value_type: row.value_type,
      });
    }
  } catch (e: any) {
    console.warn(`[validatePass2Output] elster_fields-Lookup Fehler: ${e?.message ?? e}`);
    // Bei DB-Fehler: defensive Annahme — alle akzeptieren, kein Reject
    return { accepted: values, rejected: [], total: values.length };
  }

  const accepted: Pass2Wert[] = [];
  const rejected: ValidationIssue[] = [];

  for (const v of values) {
    const meta = metaMap.get(v.elster_code);
    if (!meta) {
      // Unbekannter Code → defensive akzeptiert
      accepted.push(v);
      continue;
    }
    const issue = pruefeWert(v, meta.bezeichnung, meta.value_type);
    if (issue) {
      rejected.push({
        elster_code: v.elster_code,
        value: v.value,
        bezeichnung: meta.bezeichnung,
        reason: issue.reason,
        severity: issue.severity,
      });
      if (issue.severity === "reject") continue;
    }
    accepted.push(v);
  }

  return { accepted, rejected, total: values.length };
}
