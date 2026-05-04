# STURM Roadmap — Private Einkommensteuer-Belege

**Stand**: 2026-04-24
**Ziel**: Für eine private Einkommensteuererklärung soll jeder Beleg erkannt, der richtigen ELSTER-Anlage + den passenden eCodes zugeordnet und maschinenlesbar verfügbar sein — bis zu einem aggregierten ESt-Ergebnis pro Mandant und Veranlagungszeitraum.

Scope-Grenze: private Veranlagung. Selbstständige (S/G/EÜR), Land- und Forstwirtschaft (L), Investmentanteil-Detailfälle (KAP_INV) sind bewusst nicht in P1–P9 enthalten.

## Status

- **P0 — erreicht (2026-04-24)**: Workflow `steuerbelege-v1` mit 12 Typen, Regex+LLM-Klassifizierung, einfache Feldextraktion, 1 Beleg pro Run. Läuft unter PM2 als `sturm` auf Port 7800.
- Offen: Person-Zuordnung (A/B), Format-Validierung, Mandat-Konzept, Aggregation, Lückenanalyse, Export.

## Die sechs Säulen

1. **Klassifizierung** — Beleg → Dokumenttyp → Ziel-Anlage. Regex-first, LLM-Fallback. Muss Mehrfach-Zuordnung können (ein Steuerbescheid Vorjahr fließt sowohl in SA als auch in ESt1A).
2. **Extraktion** — Werte → eCodes. Gegen Format-Regex aus ELSTER-Katalog validieren. Mehrfach-Werte (zwei Arbeitgeber = zwei Zeilen auf N).
3. **Kontext-Zuordnung** — Person A/B, VZ, Absender, Beleg-Zeitraum. Bei Zusammenveranlagung kritisch.
4. **Session / Mandat** — N Beleg-Runs gehören zu einer Veranlagung. Speicher-Schicht über den Engine-Runs.
5. **Validierung & Lückenanalyse** — Pflicht-Belege je Lebenssituation; Plausibilitäten (SolZ ≈ 5,5 % der LSt, Kirchensteuer 8–9 %).
6. **Export** — JSON, CSV, ELSTER-Online-importfähiger JSON. Optional ERiC-XML als separater Track.

## Beleg-Universum (Ziel ~45 Typen)

| Familie | Anlage(n) | Typische Belege |
|---|---|---|
| Arbeit | N, N_AUS, N_DHH, N_GRE | Lohnsteuerbescheinigung, Arbeitsmittel, Fortbildung, Reisekosten, Bewerbung, Arbeitszimmer-Nachweis, doppelte Haushaltsführung |
| Kapital | KAP, KAP_INV, KAP_BET | Jahressteuerbescheinigung, NV-Bescheinigung, Erträgnisaufstellung, Freistellungsauftrag, ausl. Quellensteuer |
| Rente | R, R_AUS, RAV_bAV | Rentenbezugsmitteilung, Versorgungsbezüge, bAV-Leistungen |
| Sonderausgaben | SA | Spendenquittung, Kirchensteuer-Beleg, Steuerbescheid Vorjahr, Unterhalt Ex-Partner, Schulgeld, Versorgungsausgleich, eigene Ausbildung |
| Vorsorge | VOR | Kranken-/Pflege-Beitrag, Arbeitslosenvers., Unfall, Haftpflicht (begrenzt) |
| Außergew. Belastungen | AgB | Arzt, Apotheke, Heilbehandlung, Kur, Pflegeheim Angehörige, Behinderten-Nachweis, Scheidung (begrenzt), Bestattung |
| Haushaltsnah | HA_35a | Handwerker, Nebenkosten-Abrechnung, Haushaltshilfe, Gartenpflege, Hausmeister, Pflegedienste (nicht AgB) |
| Kinder | Kind | Kita, Tagesmutter, Au-Pair, Kindergeld-Bescheid, Schulbescheinigung, Immatrikulation |
| Altersvorsorge | AV | Riester, Rürup-Basisrente, §92-Zulagen |
| Vermietung | V, V_FeWo | Mietvertrag, Nebenkosten, Darlehenszins, Grundsteuer, Reparatur, AfA |
| Energetisch | EM_35c | Fachunternehmen-Bescheinigung § 35c |
| Hauptvordruck | ESt1A | Personaldaten, IBAN, Steuernummer, IDNr, Vorauszahlungen |

## Phasen

| Phase | Inhalt | Aufwand | Status |
|---|---|---|---|
| P0 | Grund-Workflow `steuerbelege-v1`, 12 Typen | — | fertig |
| P1 | Katalog auf 47 Typen, eCode-Hints für alle 47 (273 Codes), robuste Patterns | S | **fertig 2026-04-24** |
| P1.5 | VZ-Refactor: `data/felder/<VZ>/`, Loader-Signatur `loadFelder(anlage, vz)`, Workflow-Input `vz` | S | **fertig 2026-04-24** |
| P1.6 | S-Scope-Erweiterung: 8 Belegtypen (2 Einnahmen auf Anlage S mit eCodes, 6 Betriebsausgaben mit `anlage: null` als reine Dokumentation) | S | **fertig 2026-04-24** |
| P2 | Stage `kontext-extraktion` (Person A/B, VZ, Absender, Zeitraum) | S | **nächste** |
| P3 | Stage `feld-validierung` gegen ELSTER-FormatRegex | S | offen |
| P4 | Veranlagungs-Konzept: REST-Endpoints, `sessions/{id}/` mit Refs auf Run-Artefakte (ohne Auth) | M | offen |
| P5 | Workflow `est-aggregation-v1` — pro Anlage aggregieren | M | offen |
| P6 | Lückenanalyse: `checklisten.json` pro Lebenssituation | S | offen |
| P7 | Export (JSON, CSV, ELSTER-Online-Import-JSON) | S–M | offen |
| P8 | Neue Haupt-UI (Veranlagung, Belegliste, Anlagen-Übersicht, Lücken, Download, ERiC-Button) | M–L | offen |
| P9 | Eval-Set + Accuracy-Metriken | laufend | offen |
| P10 | ERiC-XML-Integration (feste Abgabe via BMF-Bibliothek + Zertifikat) | L | **geplant** |

Nach P5 ist das System funktional vollständig: hochladen → klassifizieren → extrahieren → aggregieren. P6/P7/P8 polieren Nutzen und Bedienung.

## Architektur-Ergänzungen

Die Engine (Runner, SSE, Artefakt-Store) bleibt unverändert. Alles ist zusätzliche Stage-/Workflow-Logik plus eine Mandat-Schicht oberhalb der Engine.

```
src/core/
  sessions.ts                    NEU (P4) — Mandat-Verwaltung

src/workflows/
  steuerbelege/                  erweitert (P1, P2, P3)
  est-aggregation/               NEU (P5)
    stages/
      beleg-sammler.ts
      anlage-aggregator.ts
      konsistenz-checker.ts
      luecken-analyse.ts         (P6)
    data/
      checklisten.json           (P6)

src/stages/
  feld-validierung.ts            NEU (P3) — generisch

src/exporter/                    NEU (P7)
  json-export.ts
  elster-online-json.ts

src/ui/
  mandat.html                    NEU (P8)
```

## Entscheidungspunkte (fixiert 2026-04-24)

1. **LLM-Hosting**: **A — Mistral überall**. Status quo bleibt für alle Stages (OCR, Klassifizierung, Extraktion). Datenschutz-Note: Belege mit IDNr, Kontodaten, Gesundheitsinfos verlassen H200 → Paris. Beleg-Hash-Caching reduziert Wiederholungsvolumen; Beleg-Inhalte werden in Logs sanitisiert (bereits im Runner, max 2000 chars).
2. **Mandat-Auth**: **A — Single-User**. Kein Login, keine Cookie-Session. Das „Mandat" in P4 wird zum reinen Ordnungsbegriff (eine Veranlagung = N Belege) ohne Access-Control. Wenn später Multi-User nötig: Sessions nachrüsten.
3. **ERiC-Abgabe**: **C — volle ERiC-Integration**. P10 ist **fest** geplant, nicht optional. Benötigt: ERiC-Binary vom BMF + persönliches ELSTER-Zertifikat. Wird als separater Service gebaut (Child-Process-Wrapper), nicht in die Node-Engine geladen.
4. **Scope-Grenze**: **B — privat + kleine Nebentätigkeit (S minimal)**. Zusatzumfang: Honorarnachweis, Betriebsausgaben-Belege (Büromaterial, Fachbuch, KFZ, Bewirtung), Geschäftskonto-Auszug. Ziel-Anlagen: S, ESt1A-Ergänzung. Kein G, kein EÜR, keine Umsatzsteuer.
5. **VZ-Versionierung**: **B — VZ-Unterordner von Anfang an**. Refactor auf `data/felder/<VZ>/<Anlage>.json` wird vor P2 gezogen (P1.5). Loader bekommt VZ-Parameter, Default = aktueller VZ aus Workflow-Input.

### Konsequenzen für die Roadmap

- **P1.5 (neu, vorgezogen)** — VZ-Refactor: `data/felder/` → `data/felder/<VZ>/`, Loader-Signatur `loadFelder(anlage, vz)`, Workflow-Input bekommt optionales `vz`-Feld, Default = aktueller VZ.
- **P1 bis dato** wird ergänzt: ~8 S-Belegtypen in `dokumenttypen.json` (honorarnachweis, betriebsausgabe_material, betriebsausgabe_kfz, betriebsausgabe_bewirtung, geschaeftskonto_auszug, fortbildung_selbststaendig etc.).
- **P10 ERiC** ist fest, nicht optional. Verschiebt sich an den Schluss der produktiven Phasen, aber muss beim UI-Design (P8) bereits mitgedacht werden (Export-Knopf „ELSTER-Abgabe").
- **Datenschutz-Haltung** bleibt: `uploads/` + `runs/` gitignored, Logs sanitisiert. Eine dokumentierte DSGVO-Selbsterklärung wäre sinnvoll, bleibt aber Out-of-Scope für die Implementierung.

## Risiken

- **Beleg-Varianz**: Spendenquittungen haben kein einheitliches Layout — LLM-Fallback muss gut sein. Eval-Set früh.
- **OCR-Fehler** bei schlechten Scans. Zweit-OCR-Pfad (Tesseract lokal) als Fallback vormerken.
- **eCode-Drift**: ELSTER-Felder ändern sich jährlich. VZ-Versionierung (siehe Entscheidung 5).
- **Kosten** bei vielen Belegen × LLM-Calls × Mandanten. Beleg-Hash-Caching (gleiche Datei zweimal → nur einmal verarbeiten).
- **Rechtlich**: automatisiert extrahierte Werte sind keine geprüfte Steuererklärung. UI immer „Entwurf, manuell prüfen"; Export als Vorlage, nicht als Abgabe.

## Prinzipien (aus CLAUDE.md bestätigt)

- Workflows sind Daten. Neue Typen, neue Checklisten, neue Familien entstehen als JSON-Erweiterungen, nicht als Code-Varianten.
- Stages sind pur bezüglich Seiten-Effekte — nur `ctx.emit`, `ctx.artifacts`, `ctx.logger`.
- Keine Case-Daten hartcodieren. Beleg-spezifische Werte niemals in Code oder Prompts.
- Keine Modell-Namen in User-facing Strings. „Mistral OCR" / „Kurator" statt API-IDs.
- `uploads/` und `runs/` sind gitignored, enthalten sensible Daten.
