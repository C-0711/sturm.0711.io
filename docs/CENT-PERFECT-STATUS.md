# Umsetzungs-Status — Cent-genaue ELSTER-Engine

Stand der Roadmap `CENT-PERFECT-TASKLIST.md`. Testfall Hildburg Haubrich-Koch / VZ 2024.

## Kernergebnis: Hildburg rechnet cent-richtig

| Schritt | Ergebnis | Beleg |
|---|---|---|
| Ausgangslage (fehlerhaft) | **3.643,39 € Nachzahlung** | — |
| + B2 Vorauszahlungen | 190,39 € Nachzahlung | VZ 3.453 angerechnet |
| + B4 Rentenfreibetrag | 1.601,79 € Nachzahlung | zvE 37.325 → 41.301 (Rente +3.976) |
| + §35a + KV/PV | **+160,78 € ERSTATTUNG** | zvE 43.588 · im Audit-Korridor |

Harness (sauberer 18-Beleg-Ordner): **erstattung +160,78 OK · zvE 43.588 OK · Coverage OK.**

## Erledigt (deployed + verifiziert)
- **A0** Coverage-Lücken-Warnung · **D1** typgerechte Anzeige (Bug 3)
- **B2/A1** Vorauszahlungen (Steuerkonto-Parser → Anrechnung)
- **B4** Rentenfreibetrag (BMF-MCP DB-Migration `rentenanpassungsbetrag`, §22-korrekt)
- **B1/A2** §35a haushaltsnahe (−2.389 €) · **B6/A3** KV/PV-Basis (2.554,66 €)
- **C1/C2** Dokument-Dedup + Person-Auflösung (Harmonizer)
- **D2/D3** Frontend (NCP-Busy, State-Reset)
- **E1–E3** Ground-Truth-Harness (`scripts/case_e2e.py` + `case_assert.py` + `tests/groundtruth/`)

**Leitprinzipien eingehalten:** alle Beträge zur Laufzeit aus den Belegen, MCP-Module rechnen, kein Mock, keine Case-Werte im Code — gilt für jeden Mandanten.

## Offen — bewegt Hildburgs Ergebnis NICHT mehr, aber für Vollständigkeit/andere Mandanten

| Task | Warum offen | Präziser nächster Schritt |
|---|---|---|
| **B3** Versorgungsfreibetrag-Tafel 2007–2040 | DB hat nur 2005/2006/2024; Hildburg (Beginn 1991→≤2005-Fallback 40/3000/900) **korrekt**. Andere Jahrgänge fallen auf 12,8/960/288 zurück (falsch). | (a) 2007–2022 = original AltEinkG-Schedule (−1,6pp/−120/−36 bis 2020, dann −0,8/−60/−18) — gesetzlich gesichert für gesperrte Kohorten. (b) 2023+ braucht **Wachstumschancengesetz**-Werte (verlangsamter Abbau −0,4pp/−30/−9) — vor Eintrag verifizieren. (c) `module_mappings` module_id=10: Versorgungsbetrag/-beginn auf Modul 10 mappen (sonst §19-Formeln ohne Input). |
| **B7** Altersentlastungsbetrag §24a 2024 | Hardcoded 0 (einkommen.ts:112). Hildburg: Renten/Versorgung sind ausgenommen → kein Effekt. | §24a-Kohortentafel parametrisieren (jahrgangsabhängig); gilt für Kapital-/VuV-Einkünfte alter Mandanten. |
| **B8** In-Process-Abgleich (`konform`) | In-Process-Vorschau rechnet §35a + Renten-Anpassung noch nicht → `abgleich.konform=false`. **Bindender MCP-Wert ist korrekt.** | §35a-Minderung + Renten-Anpassungs-Freibetrag in `einkommen.ts`/`adapter.ts` spiegeln; Toleranz 1→0. |
| **A4/A6** Spenden (60 €) | Zahlschein-Scan OCR-verstümmelt; Parser steht (clean text). A0-Warnung flaggt es. | Vision-OCR (gemma4-mm) oder höhere dpi/Rotation für die Zuwendungsbestätigung. |
| **A5** Wohndarlehn/Bank-Scan | Augustinum-Zins 654,48 + Volksbank 2,56 sind Sparer-Pauschbetrag-gedeckt → ~0 € Steuer. | Richtungs-Erkennung (Gläubiger→KAP) im Anker-Parser für Mandanten über dem Pauschbetrag. |

## ⚠️ Deploy-Hygiene (wichtig)
Das prod-Repo `h200v:~/0711-sturm-elster/repo/` ist ein **divergenter Teil-Checkout** (ältere `src/`-Stände, fehlende web-Dateien). Beim Deploy der neuen `mastercase-harmonize.ts` fehlten `extract-anchors.ts` + neuere `field-mapper`-Exports → Boot-Crash (behoben durch Nachsyncen). **Empfehlung:** prod auf einen sauberen `git pull`-Checkout des Branches umstellen (statt rsync von Teilmengen), sonst riskiert jeder Deploy mit neuen Imports einen Crash.

## BMF-MCP-Änderungen (nicht in git — als Migration dokumentiert)
- `docs/mcp-migrations/2026-06-03-B4-rentenanpassungsbetrag.sql` — angewandt + Container-Restart.
- Weitere MCP-DB-Änderungen (B3 Versorgungstafel) gehören ebenfalls als Migration dorthin.
