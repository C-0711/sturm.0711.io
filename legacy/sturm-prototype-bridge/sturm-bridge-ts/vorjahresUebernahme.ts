// vorjahresUebernahme.ts — Phase 2.4
// ════════════════════════════════════════════════════════════════════════════
// Vorjahres-Stammdaten-Übernahme: kopiert beständige Felder (Adresse,
// Religion, Bankverbindung, Pendler-km, Arbeitstage, Steuernummer, FA)
// aus dem Vorjahres-Bucket ins aktuelle Veranlagungsjahr.
//
// Übernahme-Werte bekommen quelle.quellen_typ="vorjahres_uebernahme" und
// niedrige Priorität (10) — aktuelle Belege im laufenden Jahr gewinnen
// immer.
//
// Trigger: nach jedem schreibePass1, sucht Cross-Bucket via case_id-Pattern.
// ════════════════════════════════════════════════════════════════════════════

import pg from "pg";
import { applyTool, loadAndGetSnapshot } from "../core/index.js";

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL ??
    `postgresql://${process.env.DB_USER ?? "ctax"}:${process.env.DB_PASSWORD ?? ""}` +
    `@${process.env.DB_HOST ?? "localhost"}:${process.env.DB_PORT ?? "9432"}` +
    `/${process.env.DB_NAME ?? "ctax_cb_chat"}`;
  _pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=ag_catalog,ctax,public",
  });
  return _pool;
}

// ELSTER-Codes die JAHRES-übergreifend stabil sind (stabile Stammdaten +
// typischerweise unveränderliche Pendler-Verhältnisse).
const STAMMDATEN_CODES = [
  // Adresse
  "E0101104", // Strasse
  "E0102002", // Strasse alt-Variante
  "E0102102", // Strasse alt-Variante
  "E0102105", // Strasse — siehe Pass-1 Output
  "E0101201", // PLZ
  "E0101206", // PLZ alt
  "E0101405", // PLZ-Ort
  "E0101601", // Ort
  // Bank
  "E0224701", // IBAN
  "E0229803", // BIC
  // Steuernummer + Finanzamt
  "E0121709", // Finanzamt
  "E0123412", // Steuernummer
  // Pendler (Arbeitsweg ändert sich selten von Jahr zu Jahr)
  "E0203501", // PLZ Tätigkeitsstätte, Ort, Strasse
  "E0203503", // aufgesuchte Tage (Arbeitstage pro Jahr)
  "E0203504", // einfache Entfernung in km (Pendlerpauschale)
  "E0203505", // davon mit PKW
  "E0203506", // davon mit ÖPNV/Rad
  "E0203508", // Arbeitstage je Woche
  // ELSTER-Code-Alias: Mistral mappt "einfache Entfernung in km" oft auch
  // auf E0207116 (Reisekosten/DHF-Block) statt auf E0203504 (Pendler-Block).
  // Beide Codes meinen denselben Wert; wir uebernehmen E0207116 mit
  // ALIAS auf E0203504 (siehe ALIAS_MAP unten).
  "E0207116", // einfache Entfernung in km (Reisekosten-Variante)
  "E0207303", // davon mit privatem Kfz (Reisekosten-Variante)
];

// ELSTER-Code-Alias-Mapping: wenn der Quell-Code anders heisst als der
// Ziel-Code unter dem Pendlerpauschale-Calc den Wert sucht, schreiben
// wir den Wert beim Uebernehmen unter dem ZIEL-Code in den Ziel-Bucket.
// Beispiel: E0207116 (17 km, Reisekosten-Block) → E0203504 (Pendler-Block).
const ALIAS_MAP: Record<string, string> = {
  E0207116: "E0203504", // einfache Entfernung in km — Reisekosten → Pendler
  E0207303: "E0203505", // davon mit privatem Kfz — Reisekosten → Pendler
};

// Werte die NIE übernommen werden (jahres-spezifisch)
const NIE_UEBERNEHMEN = new Set<string>([
  "E0210101", // Bruttoarbeitslohn
  "E1900701", "E1900702", // Kapitalerträge
  "E1901401", // Sparer-Pauschbetrag
  "E1904701", "E1904801", "E1904901", // KapErtrSt + Soli + KiSt
]);

interface UebernahmeErgebnis {
  vorjahr_case_id: string;
  ziel_case_id: string;
  uebernommene_codes: string[];
}

/**
 * Findet das passende Vorjahres-Bucket für ein gegebenes case_id.
 * Sucht in aller case_states nach gleichem fall_id-Suffix mit Vorjahres-Jahr.
 */
async function findeVorjahresCase(currentCaseId: string): Promise<string | null> {
  // Pattern: 0711:ctax:b2c:<mandant>:<jahr>:<fall_id_short>
  const m = currentCaseId.match(/^(.+):(\d{4}):([a-f0-9]+)$/i);
  if (!m) return null;
  const [, prefix, jahrStr, fallShort] = m;
  const jahr = parseInt(jahrStr, 10);
  if (!Number.isInteger(jahr)) return null;
  const vorjahr = jahr - 1;
  const candidate = `${prefix}:${vorjahr}:${fallShort}`;

  try {
    const r = await pool().query(
      `SELECT case_id FROM ag_catalog.case_states WHERE case_id = $1 LIMIT 1`,
      [candidate],
    );
    if (r.rows.length > 0) return candidate;
  } catch (e: any) {
    console.warn(`[vorjahres] Lookup-Fehler: ${e?.message ?? e}`);
  }
  return null;
}

/**
 * Hauptfunktion: übernimmt Stammdaten aus dem Vorjahres-Bucket ins aktuelle.
 * Idempotent — überspringt Codes die im aktuellen Bucket schon einen Wert haben.
 */
export async function uebernehmeVorjahresStammdaten(
  caseId: string,
): Promise<UebernahmeErgebnis | null> {
  const vorjahrCaseId = await findeVorjahresCase(caseId);
  if (!vorjahrCaseId) return null;

  let vorjahrSnap, aktSnap;
  try {
    [vorjahrSnap, aktSnap] = await Promise.all([
      loadAndGetSnapshot(vorjahrCaseId, "pro_operator"),
      loadAndGetSnapshot(caseId, "pro_operator"),
    ]);
  } catch (e: any) {
    console.warn(`[vorjahres] Snapshot-Fehler: ${e?.message ?? e}`);
    return null;
  }

  const vorjahrNachCode: any = (vorjahrSnap as any).felder?.nach_elster_code ?? {};
  const vorjahrDet: any = (vorjahrSnap as any).felder?.deterministisch ?? {};
  const aktNachCode: any = (aktSnap as any).felder?.nach_elster_code ?? {};
  const aktDet: any = (aktSnap as any).felder?.deterministisch ?? {};

  const uebernommen: string[] = [];

  for (const quellCode of STAMMDATEN_CODES) {
    if (NIE_UEBERNEHMEN.has(quellCode)) continue;

    // Alias-Mapping: ggf. unter anderem Code im Ziel-Bucket schreiben
    // (z.B. E0207116 [Reisekosten] → E0203504 [Pendler])
    const zielCode = ALIAS_MAP[quellCode] ?? quellCode;

    // Skip wenn aktueller Bucket bereits einen Wert unter dem ZIEL-Code hat
    const aktPfade: string[] = aktNachCode[zielCode] ?? [];
    let aktHatWert = false;
    for (const p of aktPfade) {
      const f = aktDet[p];
      const w = f?.alle_werte?.[0]?.wert ?? f?.wert;
      if (w !== undefined && w !== null && String(w).trim() !== "") {
        aktHatWert = true;
        break;
      }
    }
    if (aktHatWert) continue;

    // Wert aus Vorjahres-Bucket unter QUELL-Code holen
    const vorjahrPfade: string[] = vorjahrNachCode[quellCode] ?? [];
    if (vorjahrPfade.length === 0) continue;
    const vorjahrPfad = vorjahrPfade[0];
    const vorjahrFeld = vorjahrDet[vorjahrPfad];
    if (!vorjahrFeld) continue;
    const vorjahrWert = vorjahrFeld.alle_werte?.[0]?.wert ?? vorjahrFeld.wert;
    if (vorjahrWert === undefined || vorjahrWert === null || String(vorjahrWert).trim() === "") continue;

    // Person-Suffix-Behandlung wie in aktenpruefung
    const hatSuffix = /\[(p_a|p_b)\]$/.test(vorjahrPfad);
    const personFromPath = hatSuffix
      ? (vorjahrPfad.endsWith("[p_a]") ? "p_a" : "p_b")
      : null;
    // Ziel-Pfad nutzt den ZIEL-Code (nicht den Quell-Code) damit der Wert
    // unter dem korrekten ELSTER-Slot landet. Die Bridge-Mapping akzeptiert
    // dann den Wert fuer den richtigen Calculator.
    const baseDomainPfad = `elster.${zielCode}`;

    try {
      await applyTool({
        case_id: caseId,
        tool: "FELD_GESETZT",
        actor: { kind: "system", id: "auto.vorjahres_uebernahme" } as any,
        actor_id: "auto.vorjahres_uebernahme",
        payload: {
          domain_pfad: baseDomainPfad,
          person_id: personFromPath,
          primaerer_elster_code: zielCode,
          elster_code_aliase: zielCode !== quellCode ? [quellCode] : [],
          anlagen: vorjahrFeld.anlagen ?? [],
          primaere_anlage: vorjahrFeld.primaere_anlage ?? "",
          value_type: vorjahrFeld.value_type ?? "string",
          wert: String(vorjahrWert),
          konfidenz: 0.7, // niedriger als aktuelle Belege (0.95+)
          quelle: {
            quellen_typ: "vorjahres_uebernahme",
            actor: { kind: "system", id: "auto.vorjahres_uebernahme" },
            prioritaet_hinweis: 10, // niedrige Prio: aktuelle Belege gewinnen
            vorjahr_case_id: vorjahrCaseId,
            quell_ecode: zielCode !== quellCode ? quellCode : undefined,
          },
          beleg_id: null,
          sub_id: null,
          label: vorjahrFeld.label ?? null,
        } as any,
      });
      uebernommen.push(zielCode !== quellCode ? `${quellCode}→${zielCode}` : zielCode);
    } catch (e: any) {
      console.warn(`[vorjahres] applyTool Fehler für ${quellCode}→${zielCode}: ${e?.message ?? e}`);
    }
  }

  if (uebernommen.length === 0) return null;
  console.log(
    `[vorjahres] ${vorjahrCaseId} → ${caseId}: ${uebernommen.length} Stammdaten übernommen ` +
    `(${uebernommen.join(", ")})`,
  );
  return { vorjahr_case_id: vorjahrCaseId, ziel_case_id: caseId, uebernommene_codes: uebernommen };
}
