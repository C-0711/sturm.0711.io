# Cent-genaue Korrektheit — Task-Liste (dynamisch, ohne Mock, ohne Case-Hardcode)

> Abgeleitet aus dem E2E + Cent-Audit „Hildburg Haubrich-Koch / VZ 2024". Hildburg ist
> nur der **Testfall** — jede Aufgabe ist auf **Belegtyp-Ebene** bzw. **Gesetzes-Ebene**
> zu lösen, damit sie für beliebige Mandanten gilt.

## Leitprinzipien (gelten für JEDE Task)
1. **Kein Mock.** Verifikation immer gegen echte Dienste (tornado :7180, BMF-MCP :12010, vLLM/OCR) und echte Belege.
2. **Kein Case-Hardcode.** Keine Namen/Beträge/IdNr aus Hildburg in Code/Prompts/Katalogen. Muster sind belegtyp-generisch („Zuwendungsbestätigung", nicht „Hospiz Balthasar"). Beträge entstehen ausschließlich zur Laufzeit aus dem Dokument.
3. **Recht ≠ Case-Daten.** Tarif-/Freibetrags-Tabellen (§32a, Versorgungs-/Rentenfreibetrag, Pauschbeträge) sind Gesetz → gehören parametrisiert nach **Veranlagungsjahr** in den Code, nicht als Case-Wert.
4. **Cent-genau & MCP-verbindlich.** Jede Festsetzung wird gegen den BMF-MCP gegengeprüft; Konformitätstoleranz schrittweise von ±1 € → **0 Cent**.
5. **Stiller-Verlust verboten.** Klassifizierter Beleg mit 0 Feldern, gedeckelter/weggelassener Wert → muss als Warnung sichtbar werden (kein „sieht vollständig aus").

---

## EPIC A — Extraktions-Coverage (Bug 4: 7/18 Belege liefern 0 Felder)

**Ursache (geerdet):** Die Extraktionskette hat 5 Glieder; fehlt EINES, bleibt der Beleg leer:
1. `src/workflows/steuerbelege/data/dokumenttypen.json` — Typ + `patterns[]` + `anlagen[]` + `ecodeHintsProAnlage`
2. `src/verticals/elster-v3/data/nested_schemas/<typ>.json` — vLLM-JSON-Schema (Layer-1)
3. `src/verticals/elster-v3/data/atoms.json` — E-Code-Atome (`datentyp`, `drucktext`, `formatRegex`, `vordruckzeile`)
4. tornado `~/tornado/crates/catalog` via `catalog-build/` (belegtypen.yaml + `profiles/<typ>.yaml` Spatial-Hints) — nur falls Phase-0–4-Windowing nötig
5. optional `web/extract-<typ>.ts` — deterministische Anker-Spezialisierung (Vorbild: `web/extract-anchors.ts`)

### A0 — Coverage-Gap-Detektor (Querschnitt, zuerst)
- **Ziel:** Jeder klassifizierte Beleg, der 0 Felder liefert, erzeugt eine strukturierte Warnung mit Typ + Grund (kein Schema / keine Atome / Windowing leer).
- **Ort:** `src/workflows/elster/lib/lane1.ts` (nach `mapBeleg`/`aggregate`) → `Lane1BelegOutcome` um `coverageGap?: {stage, grund}` erweitern; in `web/server.ts` `runSteuerfall` in `warnings[]` spiegeln.
- **Dynamik:** rein strukturell (Felderzahl == 0 trotz Klassifikation), kein Belegtyp hartcodiert.
- **Akzeptanz:** Hildburg-E2E listet die 7 Lücken automatisch; künftige unbekannte Typen ebenso.

### A1 — Belegtyp: Steuerkontoabfrage → Vorauszahlungen *(höchste €-Wirkung, siehe B2)*
- **Ziel:** Geleistete VZ (ESt/SolZ/KiSt je Quartal + Jahressumme) strukturiert auslesen.
- **Orte:** dokumenttypen.json (neu `steuerkontoabfrage`, patterns generisch: `Steuerkontoabfrage`, `Buchungen.*Steuerkonto`, `Vorauszahlung`); nested_schema `steuerkontoabfrage.json` (Array `buchungen[]{steuerart, zeitraum, faellig, betrag, erlaeuterung}` + abgeleitete `vorauszahlung_2024{est,solz,kist}`); atoms für neue VZ-E-Codes (siehe B2).
- **Dynamik:** Zeitraum-/Steuerart-Parsing, kein fixes Jahr; VZ-Jahr = Veranlagungsjahr aus Kontext.
- **Akzeptanz:** liefert ESt-VZ = Summe der vier 2024er-Quartalsbuchungen (Hildburg-Ground-Truth zur Prüfung, **nicht** im Code).

### A2 — Belegtyp: Haushaltsnahe Dienstleistungen / Handwerker (§35a)
- **Ziel:** Den **Arbeitslohn-/Lohnkostenanteil** (Basis der 20 %) + Einordnung §35a Abs. 2 (haushaltsnah, Pflege/Betreuung) vs. Abs. 3 (Handwerker) auslesen.
- **Orte:** dokumenttypen.json (`haushaltsnahe_35a`, patterns: `haushaltsnahe Dienstleistung`, `§\\s?35a`, `Arbeitslohnanteil`, `Wohnstift|Seniorenresidenz|Jahresbescheinigung`); nested_schema mit `positionen[]{leistung, betrag, kategorie:enum[haushaltsnah,pflege_betreuung,handwerker]}` + Summen je Kategorie; atoms für §35a-E-Codes.
- **Dynamik:** Kategorien per Enum/Heuristik; keine festen Beträge.
- **Akzeptanz:** Summe abzugsfähiger Arbeitslohnanteil korrekt aggregiert (Hildburg: 11.946,79 € → nur als Prüfwert).

### A3 — Belegtyp: Private Kranken-/Pflegeversicherung (PKV-Beitragsbescheinigung)
- **Ziel:** **Basisabsicherung** KV + PV (Spalte „Basis", nicht Gesamt/Wahlleistung) trennen; Beitragsrückerstattung erfassen.
- **Orte:** dokumenttypen.json (`pkv_beitragsbescheinigung`, patterns: `Beitragsbescheinigung`, `Basisabsicherung`, `Pflegepflichtversicherung`); nested_schema `{kv_basis, kv_gesamt, pv_pflicht, erstattung}`; atoms → mappt auf bestehende KV/PV-Basis-E-Codes (E0202504/E0202604 etc., bereits im Adapter, siehe Agent-Calc-Map).
- **Dynamik:** Basis-vs-Gesamt-Logik generisch (Spaltenlabels), kein Anbieter („Debeka") hartcodiert.
- **Akzeptanz:** KV-Basis + PV-Pflicht fließen als Sonderausgaben in zvE (Hildburg: 1.781,98 + 772,68 → Prüfwert).

### A4 — Belegtyp: Spenden / Zuwendungsbestätigung (Eintrag existiert, Kette vervollständigen)
- **Ziel:** `betrag_eur` + `art` + `empfaenger` je Zuwendung; **belegt vs. behauptet** trennen (Zuwendungsbestätigung vs. bloßer SEPA-Beleg vs. Eigenaufstellung).
- **Orte:** `spendenquittung`/`zuwendungsbestaetigung` in dokumenttypen.json prüfen; nested_schema (Array, mit `nachweisart:enum[zuwendungsbestaetigung,zahlungsbeleg,eigenaufstellung]`); atoms §10b-E-Codes; **OCR-Qualität** (verstümmelte Zahlscheine) → A6.
- **Dynamik:** Empfänger frei; Summen aus Items; `nachweisart` steuert spätere Plausibilisierung.
- **Akzeptanz:** belegte Summe (Hildburg 60 €) ≠ behauptete (85 €) wird unterschieden + als Hinweis geführt.

### A5 — Belegtyp: Steuerbescheinigung Bank (Scan) + Wohndarlehn-Zins (Gläubiger)
- **Ziel:** (a) gescannte Bank-Steuerbescheinigungen über `web/extract-anchors.ts`-Pfad auch bei reinem Bild robust mappen (KAP-Zeilen); (b) **Richtungs-Erkennung** beim Wohndarlehn: Stpfl. = Gläubiger → Zinsertrag (Anlage KAP), nicht Werbungskosten.
- **Orte:** `web/extract-anchors.ts` (Anker-Fallback für Bild-only); neuer `richtung:enum[erhalten,gezahlt]` im Schema; Mapping erhalten→KAP, gezahlt+Vermietung→VuV.
- **Dynamik:** Richtung aus Beleg-Semantik (`Zinsertrag`/`gewährtes Darlehen`), nicht aus Dateiname.
- **Akzeptanz:** Augustinum-Zins (Hildburg 654,48 €) landet als Kapitalertrag, nicht als Schuldzins.

### A6 — OCR-Qualität für schwierige Scans (generisch)
- **Ziel:** Verdrehte/handschriftliche Belege (Spenden-Zahlscheine) → zweite OCR-Stufe (höhere dpi / Rotation / Crop) statt 0 Felder.
- **Orte:** `web/server.ts` `parseImage`/`ocrEnsembleFromPath`; Rerun-Strategie bei niedriger Konfidenz/leerem Mapping.
- **Dynamik:** Trigger = Konfidenz/Leere, nicht Belegname.
- **Akzeptanz:** Spenden-Beträge werden ohne manuelles Zutun lesbar (oder klare „OCR unsicher"-Markierung statt stiller 0).

---

## EPIC B — Berechnungs-Vollständigkeit (cent-genau)

**Geerdet:** Rechnung läuft über `berechneHaushaltAuthoritativ` (`web/server.ts:323`) → `src/workflows/elster/lib/steuer/{authoritative,einkommen,tarif,adapter}.ts` + BMF-MCP (`src/lib/bmf-mcp-client.ts:59`, :12010). Folgendes **fehlt** bzw. ist falsch:

### B1 — §35a Steuerermäßigung (direkter Steuerabzug) — **NICHT implementiert**
- **Wirkung:** mindert die **festgesetzte ESt** (und damit KiSt/SolZ-Basis) — €-für-€. Audit: −2.389,36 €.
- **Orte:** Eingabefeld(er) in `adapter.ts` (E-Codes für §35a Abs. 2/3 ergänzen, derzeit fehlen sie im Katalog); Berechnung nach Tarif in `engine.ts`/`authoritative.ts` (20 %, Höchstbeträge 4.000 € haushaltsnah/Pflege bzw. 1.200 € Handwerker, beides separat); MCP-Vertrag prüfen, ob MCP §35a kann — sonst lokal nach MCP-ESt abziehen + Abgleich anpassen.
- **Dynamik:** Höchstbeträge als VZ-Parameter; Basis aus A2.
- **Akzeptanz:** ESt sinkt um min(20 % × Basis, Höchstbetrag); KiSt 9 % auf reduzierte ESt; MCP-Abgleich grün.

### B2 — Vorauszahlungen in der Anrechnung — **fehlt komplett** (größter €-Fehler: 3.445 €)
- **Geerdet:** `adapter.ts:172–175` summiert nur einbehaltene LSt/SolZ/KiSt/KapESt. Keine VZ.
- **Orte:** neue E-Codes für geleistete VZ (ESt/SolZ/KiSt) aus A1; `Anrechnung`-Interface (`engine.ts:20`) um `vorauszahlungen{est,solz,kist}` erweitern; `bausteineAusFelder` (`adapter.ts:115–184`) summieren; `authoritative.ts` Anrechnung = einbehalten + VZ; `calcs[].angerechnet` (`web/server.ts:327`) entsprechend.
- **Dynamik:** VZ-Jahr = Veranlagungsjahr; nur Quartale des VZ (Vorjahres-Reste ausschließen — A1 liefert die Trennung).
- **Akzeptanz:** Anrechnung = LSt 3.290 + ESt-VZ 3.161 (+ KiSt einbehalten 295,99 + KiSt-VZ 284) — Hildburg nur als Prüfwert.

### B3 — Versorgungsfreibetrag + Zuschlag (§19 Abs. 2) — **Tafel fehlt**
- **Geerdet:** E0200902 (Bemessungsgrundlage) wird extrahiert, aber jahrgangsabhängige Tafel fehlt im zvE-Kern (`einkommen.ts`); evtl. macht MCP es — verifizieren.
- **Orte:** Tafel (Prozentsatz/Höchst-Freibetrag/Zuschlag **nach Versorgungsbeginnjahr**, lebenslang fixiert) als VZ-/Jahrgangs-Parameter; „mehrere Versorgungsbezüge" → Maxima nach frühestem Beginnjahr auf Summe (§19 Abs. 2 S. 4); WK-Pauschbetrag Versorgungsbezüge **102 €** (nicht 1.230 €).
- **Dynamik:** Tafel = Gesetz, Beginnjahr aus E-Code (Versorgungsbeginn), Bemessungsgrundlage aus E0200902.
- **Akzeptanz:** Einkünfte §19 = Versorgungsbezüge − VersFB(+Zuschlag) − 102. Validierung gegen Vorjahres-Bescheid 2023 (gleiche Person: 34.544 − 3.900 − 102 = 30.542 ✓-Muster).

### B4 — Rentenbesteuerung: gesetzlicher Rentenfreibetrag statt nur Besteuerungsanteil — **Einkommens-Unterschätzung ~6.575 €**
- **Geerdet:** `adapter.ts:50–55` nutzt `besteuerungsanteil()` × aktuellen Jahresbetrag. Korrekt ist: **steuerpflichtiger Teil = Rentenbetrag − festgeschriebener Rentenfreibetrag**; der **Rentenanpassungsbetrag (E1800606)** ist voll steuerpflichtig und wird derzeit ignoriert.
- **Orte:** Renten-Logik in `einkommen.ts`/`adapter.ts`: Festschreibungs-Freibetrag = (1 − Besteuerungsanteil(Beginnjahr)) × (Rentenbetrag − Anpassungsbetrag); steuerpflichtig = Rentenbetrag − Freibetrag; E1800606/E2400xx (Anpassungsbetrag) als Eingang aufnehmen.
- **Dynamik:** Besteuerungsanteil-Tabelle = Gesetz (Beginnjahr); Beträge aus E-Codes.
- **Akzeptanz:** DRV-Rente steuerpflichtig ≈ Rentenbetrag − 50 %×(Rentenbetrag−Anpassung) (Hildburg: 24.807,78 − 8.427,30 ≈ 16.380 — Prüfwert); zvE rückt von 37.325 auf ~43.900 (an 2023-Anker 43.765).

### B5 — Spenden §10b in zvE — **erfasst, nicht berechnet**
- **Orte:** `adapter.ts` Mapping der Spenden-E-Codes (aus A4) → Sonderausgaben in `einkommen.ts` (Höchstbetrag 20 % GdE, Großspenden-Vortrag generisch); nur **belegte** Spenden (`nachweisart`) ansetzen, Rest als Rückfrage.
- **Dynamik:** 20 %-GdE-Deckel = Gesetz; Beträge aus Beleg.
- **Akzeptanz:** belegte Spenden mindern zvE; unbelegte erzeugen Rückfrage statt stillem Ansatz.

### B6 — KV/PV-Basis als Sonderausgaben verdrahten
- **Orte:** sicherstellen, dass die A3-Werte (KV-Basis, PV-Pflicht) über die bestehenden Adapter-E-Codes (E0202504… / E0202604…) in `vorsorgeaufwendungen()` (`einkommen.ts:125`) landen; Doppelerfassung mit LStB-Nr.28 vermeiden (Vote/Dedup, Epic C).
- **Akzeptanz:** KV-Basis + PV voll abzugsfähig; keine Doppelzählung mit Nr. 28.

### B7 — Altersentlastungsbetrag §24a für VZ 2024+ — **hartcodiert 0**
- **Geerdet:** `einkommen.ts:112` retval=0 für 2024.
- **Orte:** §24a-Tafel (Prozentsatz/Höchstbetrag nach Jahr des 64. Geburtstags, lebenslang fixiert) als VZ-Parameter.
- **Dynamik:** Tafel = Gesetz; Geburtsjahr aus E-Code.
- **Akzeptanz:** korrekt 0 oder >0 je Kohorte; gegen MCP geprüft.

### B8 — VZ-Parametrisierung + 0-Cent-Abgleich härten
- **Orte:** `tarif.ts` `TARIF_PARAMS` (Grundfreibetrag 2024 = 11.784 €, `reconcile`-Flag) gegen MCP final bestätigen; Konformitätstoleranz `KONFORM_TOLERANZ_EUR` (`authoritative.ts:87`) schrittweise 1 → 0.
- **Dynamik:** alle Tarif-/Freibetragswerte je VZ; kein Jahr hartverdrahtet in der Logik, nur in der Parametertabelle.
- **Akzeptanz:** In-Process == MCP auf 0 Cent für VZ 2023 **und** 2024.

---

## EPIC C — Aggregation / Dedup-Härtung (`web/mastercase-harmonize.ts`)

### C1 — Duplikat-Beleg (ELSTER-PDF ↔ gescanntes Original, identische Werte)
- **Geerdet:** `voteKey()` (Z. 96) bündelt identische Werte → dedup je `(person,e_code)`; aber `sumIncome()` (Z. 322) **summiert** über distinct Belege — Risiko der Doppelzählung, wenn dasselbe Dokument als zwei „Belege" zählt (z. B. „Witwen Pension.pdf" = LBV-Scan).
- **Orte:** vor `sumIncome` ein **Dokument-Fingerprint-Dedup** (Hash über die Menge `(e_code→value)` eines Belegs; near-identische Belege als eine Quelle behandeln); `verworfen[]` mit Grund `duplikat-dokument`.
- **Dynamik:** Fingerprint über Feldinhalte, nicht Dateiname.
- **Akzeptanz:** Versorgungsbezüge gesamt = 34.726,16 (kein Doppel der LBV-30.707).

### C2 — `person=unknown` nach erfolgreicher Extraktion auflösen
- **Orte:** `assignPersons()` (Z. 242) — nach Epic A liefern die Belege Felder; IdNr/Name-Anker → Person; Einzelveranlagung → 'A'.
- **Akzeptanz:** keine `person unknown` bei Single-Mandant.

---

## EPIC D — Frontend-Korrektheit (`web/index.html`)

### D1 — Bug 3: typgerechte Formatierung (Anzeige-Bug, Daten sind korrekt)
- **Geerdet:** `eur()` (Z. 376) wird auf ALLE Feldwerte angewandt; `d.fields[]` hat kein Typ-Feld. Der Katalog hat es aber: `atoms.json.metadata.datentyp` (currency/date/string…).
- **Orte:** `web/server.ts` `runSteuerfall` — jedes Feld um `format` aus dem Katalog (`elster-catalog.ts byECode`) anreichern; `index.html` Helper `fmt(f,v)` (Z. 1046–1050) → currency→`eur`, date→`dd.MM.yyyy`, year→`YYYY`, id/string→roh; Anwendung Z. 1100/1109/feur.
- **Dynamik:** Format kommt aus dem E-Code-Katalog, nicht aus Wert-Heuristik.
- **Akzeptanz:** IdNr `57438590613`, Geburtsdatum `24.11.1935`, PLZ `53474`, Jahr `1991` korrekt — kein „€".

### D2 — Bug 2: aktiver Fall ↔ angezeigter Bescheid konsistent
- **Orte:** Mastercase-Poll an `caseId` binden und vor Übernahme prüfen `active?.id === polledId` (sonst verwerfen); `recompute()` (Z. 606) + Fallwechsel (Z. 506): `viewDoc=null; auditMode=false;` konsequent; „← Zurück zum Bescheid" (Z. 693) → garantiert `activeTab='fall'`.
- **Dynamik:** rein zustandsbasiert.
- **Akzeptanz:** Auswahl „Fall X" zeigt immer Bescheid X; Zurück-Button landet im Bescheid, nicht im Chat.

### D3 — Bug 1: „Neuer Fall"-Panel hängt/resetet bei busy
- **Orte:** `createCase()` (Z. 567): statt `renderNcp()` im busy-State einen **separaten Upload-/Rechen-Fortschritt** rendern; `ncp.vz`/`ncp.files` nicht verlieren; Inputs `disabled`; erst nach Erfolg `closeNcp()`.
- **Akzeptanz:** Jahr + Belege bleiben sichtbar; klarer Fortschritt; kein „Zuerst Jahr wählen" während der Rechnung.

---

## EPIC E — Verifikation ohne Mock (Ground-Truth-Harness)

### E1 — Wiederverwendbarer E2E-Harness (real, fresh)
- **Orte:** `scripts/hildburg_e2e.py` + `scripts/hildburg_analyze.py` generalisieren zu `scripts/case_e2e.py <belege-ordner> <vz>` → POST `/api/steuerfall` mit `fresh:true`, Mastercase-Poll, strukturierter Report.
- **Dynamik:** Ordner-parametrisiert; **keine** erwarteten Werte im Engine-Code.
- **Akzeptanz:** läuft für beliebigen Beleg-Ordner.

### E2 — Ground-Truth-Fixtures (Soll-Werte NUR im Test)
- **Orte:** `tests/groundtruth/<case>.json` — Soll-Beträge je E-Code + Bescheid-Kennzahlen (für Hildburg aus den Belegen/2023-Bescheid abgeleitet). Assertions cent-genau gegen den E2E-Output.
- **Dynamik/Guardrail:** Soll-Werte leben **ausschließlich** im Test-Fixture, nie im Produktivcode/Prompt/Katalog.
- **Akzeptanz:** Cent-Diff je Position = 0; Abweichungen schlagen den Test.

### E3 — Doppelte Absicherung
- **Orte:** (a) jeder berechnete Bescheid gegen BMF-MCP (Toleranz 0, B8); (b) wenn ein Vorjahres-Bescheid-PDF vorliegt, dessen Kennzahlen parsen und als zusätzlichen Plausibilitäts-Anker nutzen; (c) Coverage-Assertion aus A0 (kein Beleg still 0).
- **Akzeptanz:** drei unabhängige Checks grün, sonst CI-rot.

---

## Reihenfolge (Wirkung × Aufwand)
1. **A0** (Gap-Detektor) + **D1** (Anzeige-Bug, klein, sofort sichtbar).
2. **A1 → B2** (Vorauszahlungen — größter €-Fehler, 3.445 €).
3. **B4** (Rentenfreibetrag — schließt die 6.575-€-Einkommenslücke) + **B3** (Versorgungsfreibetrag).
4. **A2 → B1** (§35a — 2.389 €) ; **A3 → B6** (KV/PV) ; **A4 → B5** (Spenden).
5. **C1/C2** (Dedup/Person) , **A5/A6** (Bank-Scan/Wohndarlehn/OCR).
6. **B7, B8** (Altersentlastung 2024, 0-Cent-Abgleich) , **D2/D3** (State/UX).
7. **E1–E3** begleitend ab Schritt 1 (jede Korrektur wird sofort gegen Ground Truth + MCP geprüft).

**Definition of Done (gesamt):** Hildburg-E2E rechnet **fresh, ohne Cache, ohne Mock** durch; jeder der 18 Belege liefert Felder oder eine begründete Warnung; In-Process == MCP auf 0 Cent; das Endergebnis (≈ Nullnummer statt 3.643,39 € Nachzahlung) deckt sich mit den Ground-Truth-Fixtures — und dieselbe Pipeline rechnet einen **fremden** Mandanten-Ordner ohne Code-Änderung.
