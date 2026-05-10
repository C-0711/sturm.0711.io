// autoMeta.ts — Phase 2.2 + 2.3
// ════════════════════════════════════════════════════════════════════════════
// Auto-Reducer für deterministische Meta-Daten:
//   - Steuerjahr aus case_id ableiten + setzen (Phase 2.2)
//   - Veranlagungsart aus personen[].length + Indikator-Feldern (Phase 2.3)
//
// Beide Tasks sind regelbasiert, brauchen kein LLM. Sparen Opus-Calls.
// ════════════════════════════════════════════════════════════════════════════

import { applyTool, loadAndGetSnapshot } from "../core/index.js";

interface AutoMetaErgebnis {
  steuerjahr_gesetzt?: number;
  veranlagungsart_gesetzt?: "zusammen" | "einzel" | "getrennt";
}

const ECODE_VERANLAGUNGSJAHR = "E0109815";
const ECODE_VERANLAGUNGSART = "E0123101";

/**
 * Phase 2.2: Steuerjahr aus case_id extrahieren und als ELSTER-Feld setzen.
 * Idempotent — nur setzen wenn noch kein Wert existiert.
 *
 * case_id-Format: 0711:ctax:b2c:<mandant>:<jahr>:<fall_id_short>
 */
async function setzeSteuerjahr(caseId: string): Promise<number | null> {
  const m = caseId.match(/:(\d{4}):[a-f0-9]+$/i);
  if (!m) return null;
  const jahr = parseInt(m[1], 10);
  if (!Number.isInteger(jahr) || jahr < 2015 || jahr > 2100) return null;

  let snap;
  try {
    snap = await loadAndGetSnapshot(caseId, "pro_operator");
  } catch {
    return null;
  }

  // Skip wenn bereits gesetzt
  const nachCode: any = (snap as any).felder?.nach_elster_code ?? {};
  const det: any = (snap as any).felder?.deterministisch ?? {};
  const pfade: string[] = nachCode[ECODE_VERANLAGUNGSJAHR] ?? [];
  for (const p of pfade) {
    const feld = det[p];
    const wert = feld?.alle_werte?.[0]?.wert ?? feld?.wert;
    if (wert !== undefined && wert !== null && String(wert).trim() !== "") {
      return null; // schon gesetzt
    }
  }

  try {
    await applyTool({
      case_id: caseId,
      tool: "FELD_GESETZT",
      actor: { kind: "system", id: "auto.meta.steuerjahr" } as any,
      actor_id: "auto.meta.steuerjahr",
      payload: {
        domain_pfad: `elster.${ECODE_VERANLAGUNGSJAHR}`,
        person_id: null,
        primaerer_elster_code: ECODE_VERANLAGUNGSJAHR,
        anlagen: ["ESt1A"],
        primaere_anlage: "ESt1A",
        value_type: "integer",
        wert: String(jahr),
        konfidenz: 1.0,
        quelle: {
          quellen_typ: "berechnung",
          actor: { kind: "system", id: "auto.meta.steuerjahr" },
          prioritaet_hinweis: 5,
        },
        beleg_id: null,
        sub_id: null,
        label: "Veranlagungsjahr",
      } as any,
    });
    console.log(`[autoMeta] Steuerjahr ${jahr} gesetzt für ${caseId}`);
    return jahr;
  } catch (e: any) {
    console.warn(`[autoMeta] setzeSteuerjahr Fehler: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Phase 2.3: Veranlagungsart aus personen[] + Indikator-Feldern ableiten.
 * - personen.length === 2 mit beide echte idnr → "zusammen" (default bei Ehegatten)
 * - sturm.veranlagungsart enthält "Zusammenveranlagung" → "zusammen"
 * - sturm.veranlagungsart enthält "Einzel" → "einzel"
 * - sturm.veranlagungsart enthält "Getrennt" → "getrennt"
 * - personen.length === 1 mit echter idnr → "einzel"
 *
 * Idempotent — nur setzen wenn noch kein Wert.
 */
async function setzeVeranlagungsart(caseId: string): Promise<"zusammen" | "einzel" | "getrennt" | null> {
  let snap;
  try {
    snap = await loadAndGetSnapshot(caseId, "pro_operator");
  } catch {
    return null;
  }

  const nachCode: any = (snap as any).felder?.nach_elster_code ?? {};
  const det: any = (snap as any).felder?.deterministisch ?? {};

  // Skip wenn bereits gesetzt
  const pfade: string[] = nachCode[ECODE_VERANLAGUNGSART] ?? [];
  for (const p of pfade) {
    const feld = det[p];
    const wert = feld?.alle_werte?.[0]?.wert ?? feld?.wert;
    if (wert !== undefined && wert !== null && String(wert).trim() !== "") {
      return null; // schon gesetzt
    }
  }

  // Indikator 1: sturm.veranlagungsart-Feld
  const sturmVa = det["sturm.veranlagungsart"]?.alle_werte?.[0]?.wert
    ?? det["sturm.veranlagungsart"]?.wert;
  let art: "zusammen" | "einzel" | "getrennt" | null = null;
  if (sturmVa) {
    const s = String(sturmVa).toLowerCase();
    if (/zusammen/i.test(s)) art = "zusammen";
    else if (/einzel/i.test(s)) art = "einzel";
    else if (/getrennt/i.test(s)) art = "getrennt";
  }

  // Indikator 2: personen-Anzahl (echte, ohne synth_)
  if (!art) {
    const personen: any[] = (snap as any).personen ?? [];
    const echtePersonen = personen.filter(
      (p) =>
        !String(p?.idnr ?? "").startsWith("synth_") &&
        String(p?.vorname ?? "").trim() !== "",
    );
    if (echtePersonen.length === 2 &&
        echtePersonen.some((p) => String(p?.rolle ?? "").includes("ehegatte") ||
                                  String(p?.rolle ?? "").includes("steuerpflichtiger_b"))) {
      art = "zusammen";
    } else if (echtePersonen.length === 1) {
      art = "einzel";
    }
  }

  if (!art) return null;

  try {
    await applyTool({
      case_id: caseId,
      tool: "FELD_GESETZT",
      actor: { kind: "system", id: "auto.meta.veranlagungsart" } as any,
      actor_id: "auto.meta.veranlagungsart",
      payload: {
        domain_pfad: `elster.${ECODE_VERANLAGUNGSART}`,
        person_id: null,
        primaerer_elster_code: ECODE_VERANLAGUNGSART,
        anlagen: ["ESt1A"],
        primaere_anlage: "ESt1A",
        value_type: "string",
        wert: art,
        konfidenz: 1.0,
        quelle: {
          quellen_typ: "berechnung",
          actor: { kind: "system", id: "auto.meta.veranlagungsart" },
          prioritaet_hinweis: 5,
        },
        beleg_id: null,
        sub_id: null,
        label: "Veranlagungsart",
      } as any,
    });
    console.log(`[autoMeta] Veranlagungsart ${art} gesetzt für ${caseId}`);
    return art;
  } catch (e: any) {
    console.warn(`[autoMeta] setzeVeranlagungsart Fehler: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Hauptfunktion: läuft Phase 2.2 + 2.3 zusammen.
 * Wird nach jedem schreibePass1 aufgerufen.
 */
export async function autoMeta(caseId: string): Promise<AutoMetaErgebnis> {
  const ergebnis: AutoMetaErgebnis = {};
  const sj = await setzeSteuerjahr(caseId);
  if (sj) ergebnis.steuerjahr_gesetzt = sj;
  const va = await setzeVeranlagungsart(caseId);
  if (va) ergebnis.veranlagungsart_gesetzt = va;
  return ergebnis;
}
