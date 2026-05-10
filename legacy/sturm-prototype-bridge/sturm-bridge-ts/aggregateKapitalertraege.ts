// aggregateKapitalertraege.ts — Phase 2.1
// ════════════════════════════════════════════════════════════════════════════
// Bank-KAP-Aggregator-Reducer: summiert Kapitalerträge, Sparer-Pauschbetrag,
// KapErtrSt, KiSt, Soli aus mehreren Bank-Bescheinigungen je case_state.
//
// Trigger: nach jedem schreibePass1 wenn beleg vom Typ
// steuerbescheinigung_kapitalertr / kapitalertragsbescheinigung. Läuft idempotent —
// rechnet immer NEU aus den aktuellen alle_werte[].
//
// Spart Opus-Calls: in Anlage KAP werden Werte aus N Banken IMMER addiert,
// das ist gesetzlicher Standardfall, kein Klärungsthema.
// ════════════════════════════════════════════════════════════════════════════

import { applyTool, loadAndGetSnapshot } from "../core/index.js";

// ELSTER-Codes die in Anlage KAP aggregiert werden (je Code: Summe der
// Einzelbelege landet im selben Code mit quelle.quellen_typ="aggregation").
const KAP_AGGREGATIONS_CODES = [
  "E1900701", // Kapitalerträge
  "E1900702", // Kapitalerträge (alt-Variante)
  "E1901401", // In Anspruch genommener Sparer-Pauschbetrag
  "E1904701", // Kapitalertragsteuer
  "E1904801", // Kirchensteuer zur Kapitalertragsteuer
  "E1904901", // Solidaritätszuschlag
];

// Belege die als KAP-Quelle aggregiert werden
const KAP_DOC_TYPES = new Set([
  "steuerbescheinigung_kapitalertr",
  "kapitalertragsbescheinigung",
  "lohnsteuerbescheinigung_kapital", // VAST hat oft KAP-Sektion
]);

interface AggResult {
  ecode: string;
  summe: string;
  beleg_count: number;
  einzelbeitraege: Array<{ beleg_id: string; wert: string }>;
}

/**
 * Parst einen deutschen Geld-String "1.234,56" oder "5,06" zu Cent (Integer).
 * Gibt null zurück bei nicht-numerischen Inputs.
 */
function parseGeld(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/\s|€|EUR/gi, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100); // Cent
}

/**
 * Formatiert Cent zurück zu deutschem Geld-String "1.234,56"
 */
function formatGeld(cents: number): string {
  const euros = cents / 100;
  return euros.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Hauptfunktion: aggregiert KAP-Werte für einen case_state.
 * Wird nach jedem KAP-Beleg aufgerufen.
 *
 * Returnt Liste der aggregierten Werte zur Auditierung.
 */
export async function aggregiereKapitalertraege(
  caseId: string,
): Promise<AggResult[]> {
  let snap;
  try {
    snap = await loadAndGetSnapshot(caseId, "pro_operator");
  } catch (e: any) {
    console.warn(`[aggregateKAP] Snapshot-Lookup Fehler für ${caseId}: ${e?.message ?? e}`);
    return [];
  }

  const belege = (snap as any).belege ?? [];
  const det: any = (snap as any).felder?.deterministisch ?? {};
  const nachCode: any = (snap as any).felder?.nach_elster_code ?? {};

  // Nur aggregieren wenn ≥2 KAP-Belege da sind (sonst keine Aggregation nötig)
  const kapBelege = belege.filter((b: any) =>
    KAP_DOC_TYPES.has(String(b.typ ?? "").toLowerCase())
  );
  if (kapBelege.length < 2) {
    return [];
  }

  const ergebnisse: AggResult[] = [];

  for (const ecode of KAP_AGGREGATIONS_CODES) {
    const pfade: string[] = nachCode[ecode] ?? [];
    if (pfade.length === 0) continue;

    // Sammle alle alle_werte[]-Einträge zu diesem Code, gruppiert nach beleg_id
    const beitraege = new Map<string, { wert: string; cent: number }>();
    for (const pfad of pfade) {
      const feld = det[pfad];
      if (!feld) continue;
      const werte: any[] = feld.alle_werte ?? [];
      for (const w of werte) {
        if (w.verworfen_am) continue; // ignoriere verworfene Werte
        const beleg_id = w.beleg_id;
        if (!beleg_id) continue;
        // Nur Werte aus KAP-Belegen einbeziehen
        const istKapBeleg = kapBelege.some((b: any) => b.beleg_id === beleg_id);
        if (!istKapBeleg) continue;
        // Aggregations-Output selbst überspringen (sonst Endlos-Akkumulation)
        if (w.quelle?.quellen_typ === "aggregation") continue;
        const cents = parseGeld(String(w.wert ?? ""));
        if (cents === null) continue;
        // Pro beleg_id nur ersten Wert zählen (einer pro Bank-Bescheinigung)
        if (!beitraege.has(beleg_id)) {
          beitraege.set(beleg_id, { wert: String(w.wert), cent: cents });
        }
      }
    }

    if (beitraege.size < 2) continue; // nur aggregieren wenn ≥2 Belege diesen Code haben

    let summeC = 0;
    for (const v of beitraege.values()) summeC += v.cent;

    const summe = formatGeld(summeC);
    const einzel = Array.from(beitraege.entries()).map(([beleg_id, v]) => ({
      beleg_id,
      wert: v.wert,
    }));

    // Schreibe das Aggregat als FELD_GESETZT mit eigener Quelle "aggregation"
    // damit es nicht mit Pass-2-Werten kollidiert. Höchste Prio (0).
    try {
      // Pfad: nimm den ersten existierenden Pfad (der "Hauptpfad" für diesen Code)
      const zielPfad = pfade[0];
      const hatPersonSuffix = /\[(p_a|p_b)\]$/.test(zielPfad);
      const baseDomainPfad = hatPersonSuffix ? zielPfad.replace(/\[(p_a|p_b)\]$/, "") : zielPfad;
      const personFromPath = hatPersonSuffix
        ? (zielPfad.endsWith("[p_a]") ? "p_a" : "p_b")
        : null;

      await applyTool({
        case_id: caseId,
        tool: "FELD_GESETZT",
        actor: { kind: "system", id: "auto.aggregator.kap" } as any,
        actor_id: "auto.aggregator.kap",
        payload: {
          domain_pfad: baseDomainPfad,
          person_id: personFromPath,
          primaerer_elster_code: ecode,
          anlagen: ["KAP"],
          primaere_anlage: "KAP",
          value_type: "string",
          wert: summe,
          konfidenz: 1.0,
          quelle: {
            quellen_typ: "aggregation",
            actor: { kind: "system", id: "auto.aggregator.kap" },
            prioritaet_hinweis: 0,
            beleg_count: beitraege.size,
          },
          beleg_id: null,
          sub_id: null,
          label: "Aggregat aus N Bank-Bescheinigungen",
        } as any,
      });
      console.log(
        `[aggregateKAP] ${ecode} = ${summe} (Σ ${beitraege.size} Belege: ${
          einzel.map((e) => e.wert).join(" + ")
        })`,
      );
      ergebnisse.push({ ecode, summe, beleg_count: beitraege.size, einzelbeitraege: einzel });
    } catch (e: any) {
      console.warn(`[aggregateKAP] applyTool Fehler für ${ecode}: ${e?.message ?? e}`);
    }
  }

  return ergebnisse;
}
