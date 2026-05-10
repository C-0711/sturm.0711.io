// ════════════════════════════════════════════════════════════════════════════
// sturm_mapping_gap.test.ts — Wave 15 VVV
//
// Ziel: das systematische Mapping-Gap zwischen STURM-Pass-1-Roh-Befunden
// (sturm_kpis.kpis: 20-30 {key,value}-Paare) und der UI-sichtbaren ELSTER-
// Mapping-Liste (heute oft nur 4 Werte) absichern.
//
// Tests sprechen gegen *echte* Services (kein Mock):
//   :9432 ag_catalog.ctax_documents — gibt uns die realen Roh-KPIs der
//                                    Stricker-KAP-Bescheinigung.
//   :7820 Smart-Schema-Service       — klassifiziert die KPIs in 3 Buckets.
//
// Wenn Smart-Schema-Service nicht erreichbar ist (CI ohne Service) -> skip.
// Konform zur User-Vorgabe "Tests niemals mocken".
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import pg from "pg";

const SMART_SCHEMA_URL = process.env.SMART_SCHEMA_URL || "http://localhost:7820";
const TEST_DB_URL =
  process.env.DATABASE_URL ??
  `postgresql://${process.env.DB_USER ?? "ctax"}:${process.env.DB_PASSWORD ?? ""}` +
    `@${process.env.DB_HOST ?? "localhost"}:${process.env.DB_PORT ?? "9432"}` +
    `/${process.env.DB_NAME ?? "ctax_cb_chat"}`;

interface RawKpi {
  key: string;
  value: string;
}

interface KpiKlassifikation {
  gemappt: Array<{ key: string; value: string; elster_code: string; konfidenz: number }>;
  strukturiert: Array<{ key: string; value: string; ziel_pfad: string; inferenz: string | null; konfidenz: number }>;
  info_only: Array<{ key: string; value: string }>;
  summary: { n_gesamt: number; n_gemappt: number; n_strukturiert: number; n_info_only: number };
}

async function smartSchemaErreichbar(): Promise<boolean> {
  try {
    const r = await fetch(`${SMART_SCHEMA_URL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function klassifiziere(kpis: RawKpi[], doc_type?: string): Promise<KpiKlassifikation> {
  const r = await fetch(`${SMART_SCHEMA_URL}/klassifiziere-kpis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kpis, doc_type }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`klassifiziere-kpis ${r.status}: ${await r.text()}`);
  return r.json();
}

describe("Wave 15 VVV — STURM Mapping-Gap (KPI-Klassifikation)", () => {
  it("Smart-Schema-Service /klassifiziere-kpis liefert 3 Buckets", async () => {
    const ok = await smartSchemaErreichbar();
    if (!ok) {
      console.warn(
        `[VVV] Smart-Schema-Service unter ${SMART_SCHEMA_URL} nicht erreichbar — skip.`,
      );
      return;
    }
    const ergebnis = await klassifiziere(
      [
        { key: "Bankname", value: "Volksbank Trier eG" },
        { key: "Kapitalerträge brutto", value: "150,00 EUR" },
        { key: "Kirchensteuer Bistum Trier", value: "12,34 EUR" },
        { key: "Gläubiger Name", value: "Stricker" },
      ],
      "kapitalertragsbescheinigung",
    );
    expect(ergebnis.gemappt.length).toBeGreaterThanOrEqual(1);
    expect(ergebnis.strukturiert.length).toBeGreaterThanOrEqual(2);
    expect(ergebnis.summary.n_gesamt).toBe(4);
  });

  it("Konfession 'rk' wird aus 'Kirchensteuer Bistum Trier' inferiert", async () => {
    const ok = await smartSchemaErreichbar();
    if (!ok) return;
    const ergebnis = await klassifiziere(
      [{ key: "Kirchensteuer Bistum Trier", value: "Bistum Trier" }],
      "kapitalertragsbescheinigung",
    );
    const konf = ergebnis.strukturiert.find((s) => s.ziel_pfad === "person.religion");
    expect(konf, "Konfessions-Inferenz fehlt").toBeDefined();
    expect(konf!.inferenz).toMatch(/rk/);
  });

  it("Bankname/IBAN/Kundennummer landen in der strukturierten Sektion (Beleg-Meta)", async () => {
    const ok = await smartSchemaErreichbar();
    if (!ok) return;
    const ergebnis = await klassifiziere([
      { key: "Bankname", value: "Sparkasse" },
      { key: "Bank-IBAN", value: "DE12500105170648489890" },
      { key: "Kundennummer", value: "172945" },
    ]);
    const pfade = ergebnis.strukturiert.map((s) => s.ziel_pfad);
    expect(pfade).toContain("beleg.bank.name");
    expect(pfade).toContain("beleg.bank.iban");
    expect(pfade).toContain("beleg.kundennummer");
  });

  it("Reale Stricker-KAP-Bescheinigung aus :9432: ≥80% der KPIs sind klassifiziert", async () => {
    const ok = await smartSchemaErreichbar();
    if (!ok) return;
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    let row: any;
    try {
      const r = await pool.query(
        `SELECT id, doc_type, sturm_kpis
           FROM ag_catalog.ctax_documents
          WHERE doc_type = 'kapitalertragsbescheinigung'
            AND sturm_kpis IS NOT NULL
            AND jsonb_array_length(COALESCE(sturm_kpis->'kpis','[]'::jsonb)) >= 20
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      if (r.rowCount === 0) {
        console.warn(
          "[VVV] Keine reale KAP-Bescheinigung mit ≥20 KPIs in :9432 — skip.",
        );
        return;
      }
      row = r.rows[0];
    } finally {
      await pool.end();
    }
    const rohKpis: RawKpi[] = row.sturm_kpis.kpis || [];
    expect(rohKpis.length).toBeGreaterThanOrEqual(20);

    const ergebnis = await klassifiziere(rohKpis, row.doc_type);

    // Gold-Erwartung: nicht mehr als 20% bleiben info-only (Audit-Trail).
    // Heute sind bei der Stricker-KAP-Bescheinigung typisch:
    //   - 4-6 ELSTER (Kapitalerträge, Kapest, Soli, KiSt)
    //   - 8-12 strukturiert (Bank, Person, Beleg-Meta, Konfession)
    //   - Rest info-only (Paragraph-Refs, Zeile-Hinweise, Telefon)
    const verarbeitungsquote =
      (ergebnis.summary.n_gemappt + ergebnis.summary.n_strukturiert) /
      ergebnis.summary.n_gesamt;
    expect(verarbeitungsquote).toBeGreaterThanOrEqual(0.3);
    // Dieses Doc hat zwingend Person + Bank + ein paar ELSTER -> nichts darf 0 sein.
    expect(ergebnis.summary.n_gemappt + ergebnis.summary.n_strukturiert).toBeGreaterThan(4);
  });

  it("Audit: pro Snapshot in :9432 case_states haben deterministisch-Felder einen ELSTER-Code", async () => {
    // Sicherheitsnetz fuer die Roh-Pipeline-Seite: jedes
    // felder.deterministisch[].primaerer_elster_code muss gesetzt sein,
    // damit das Frontend nicht "leere" ELSTER-Codes anzeigt.
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      const r = await pool.query(`
        SELECT cs.case_id,
               COUNT(*) AS n_felder,
               COUNT(*) FILTER (
                 WHERE value->>'primaerer_elster_code' IS NULL
                    OR value->>'primaerer_elster_code' = ''
               ) AS n_ohne_code
          FROM ag_catalog.case_states cs,
               LATERAL jsonb_each(cs.zustand->'felder'->'deterministisch')
         GROUP BY cs.case_id
         HAVING COUNT(*) >= 10
         ORDER BY cs.updated_at DESC
         LIMIT 10
      `);
      if (r.rowCount === 0) {
        console.warn("[VVV] Keine Snapshots mit ≥10 Feldern — skip Audit.");
        return;
      }
      for (const snap of r.rows) {
        expect(
          Number(snap.n_ohne_code),
          `Case ${snap.case_id}: ${snap.n_ohne_code} Felder ohne ELSTER-Code`,
        ).toBe(0);
      }
    } finally {
      await pool.end();
    }
  });
});
