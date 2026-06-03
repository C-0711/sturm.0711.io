# MCP-Fix: Versorgungsfreibetrag (§19 Abs. 2 EStG) — bindende Festsetzung

**Datum:** 2026-06-03 · **Host:** h200v (`ctaxv1-lane1-bmf`, :12010) · **Status:** deployed + verifiziert

## Problem
Die bindende BMF-MCP-Festsetzung wandte den **Versorgungsfreibetrag nicht an**.
Der Bruttolohn (E0200201) wurde voll als §19-Arbeitslohn gerechnet; die
Versorgungsbezüge (E0200801, Nr. 8 LStB) blieben unberücksichtigt. Für Hildburg
(Beamten-Witwenpension) ⇒ zvE 43.236 statt korrekt 44.483 und ein um den
Versorgungsfreibetrag verfälschtes Ergebnis.

Der MCP **hatte die komplette, korrekte Versorgungs-Formelkette** schon (Modul 10
`anlage_r`: `versorgung_summe → massgebendes_jahr → lookup(prozent/max/zuschlag)
→ versorgungsfreibetrag_berechnet → versorgung_steuerpflichtig → −102 →
para19_versorgung`). Sie lief im v2-Pfad nur nie (Input hartkodiert 0,0) und die
Jahrgangs-Tafel war unvollständig.

## Drei Teile

### 1. DB — Tafel + Mapping (`versorgung_db.sql`, reversibel via `before.sql`)
- `lane1_bmf_calculator.thresholds`: Versorgungsfreibetrags-Tafel **2007–2022**
  ergänzt (Kategorie `versorgungsfreibetrag`, korrekte `threshold_type`-Werte
  `prozent`/`hoechstbetrag`/`zuschlag` — der Lookup matcht `threshold_name LIKE
  '%jahr%'`). 2005/2006/2024 waren bereits da. **2023/2024 bewusst ausgelassen**
  (WachstumschancenG-Unsicherheit; für ≤2005-Jahrgänge irrelevant).
- `lane1_bmf_calculator.module_mappings` (Modul 10): `versorgungsbezuege_1_betrag
  ← {E0200801}` (sum), `versorgungsbezuege_1_beginn ← {E0201307,E0201904}`
  (first_present).

### 2. Python — De-Overlap + Ketten-Aktivierung (`*-mcp-server.patch`)
`bmf_calculator_mcp_server.py`, `_calculate_comprehensive_tax` (v2-FLAT-Pfad):
- `_versorgung_summe` aus `versorgungsbezuege_1/2/3_betrag` bilden.
- **De-Overlap:** `bruttolohn_aktiv = max(0, bruttolohn − _versorgung_summe)` —
  der Versorgungsanteil (in Nr. 3 enthalten) zählt nicht zusätzlich als §19-Lohn.
  WK-Pauschbetrag + zvE-Basis nutzen `bruttolohn_aktiv`. **No-op bei Versorgung=0
  → kein Regress für reine Arbeitnehmer.**
- anlage_r-Inline-Call mit **echten** Versorgungswerten (statt `0,0`) und **allen
  sechs** `versorgungsbezuege_1/2/3_betrag/beginn` (sonst überspringt die Formel-
  Engine die Kette als „missing params", Z. 701–707 formula_executor).
- `para19_versorgung` aus dem anlage_r-Ergebnis zur zvE addieren.

### 3. Rebuild
lane1-bmf ist gebacken (kein Mount) → `docker compose build lane1-bmf && up -d`.

## ⚠️ Deployment-Landmine (wichtig!)
Der **Host-`bmf_calculator_mcp_server.py` war VERALTET** gegenüber dem laufenden
Container — ihm fehlten 3 Live-Fixes (Betriebsverlust/VuV, Splitting-`married`,
§35a-Cap 5.200 €). Ein naiver Rebuild vom Host hätte sie regressiert. Deshalb
wurde der Patch auf die **extrahierte Container-Live-Version** (`/tmp/
container_server.py`) angewandt und damit der Host-Stand gleich mitkorrigiert.
→ **Empfehlung:** CTAXV1 unter Versionskontrolle bringen; Host ≠ Image driftet.

## Verifikation (MCP direkt)
| Fall | zvE | Erwartung |
|---|---|---|
| Hildburg (Beginn ≤2005) | **44.483,26** | VersFB 3.000+900, = In-Process 44.514 ✓ |
| 2010-Kohorte | **45.263,26** | VersFB 2.400+720 (+780 Δ) ✓ |
| Arbeitnehmer 50.000, keine Versorgung | 44.894 | De-Overlap no-op, kein Regress ✓ |
| Hildburg + §35a (E0107301) | ESt 9.007 → **6.617,87** | −2.389,36 = 20 % v. 11.946,79 ✓ |

NRestarts=0, keine Fehler-Logs.

## Revert
```
docker tag ctaxv1-lane1-bmf:before-versorgung ctaxv1-lane1-bmf:latest
docker compose up -d lane1-bmf
docker exec -i ctaxv1-postgres psql -U ctax -d ctax < ~/mcp-versorgung-backup-20260603-130318/before.sql
```
Backup-Verzeichnis auf h200v: `~/mcp-versorgung-backup-20260603-130318/` (before.sql,
bmf_calculator_mcp_server.py.bak, versorgung_db.sql).

## Offene Folgepunkte (klein, generalisierend)
- **Versorgungsbeginn Nr. 30 LStB → E0201307** extrahieren (heute nicht; Hildburg
  defaultet korrekt auf ≤2005/40 %, aber für Nicht-≤2005-Jahrgänge nötig).
- **KV-96 %-Kürzung** im MCP ist unbedingt — für PRIVAT Versicherte/Rentner ohne
  Krankengeldanspruch wären 100 % korrekt (In-Process bereits gefixt; ~20 € Δ).
- **§35a-Vokabular:** Flow nutzt E0107301 (wirkt), GT-Fixture E0107208 (wirkt nicht
  im MCP) — angleichen.
- Tafel **2023/2024** nach WachstumschancenG verifizieren + ergänzen.
