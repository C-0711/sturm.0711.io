# Ground-Truth-Verifikation (Epic E)

Generischer, mock-freier E2E-Harness fuer die Steuer-Engine. Faehrt einen
beliebigen Mandanten-Beleg-Ordner **fresh** (ohne Cache) gegen die laufende
Engine und prueft das Ergebnis **cent-genau** gegen ein Ground-Truth-Fixture.

Drei Teile:

| Datei | Zweck |
|---|---|
| `scripts/case_e2e.py` | POSTet `/api/steuerfall` (fresh), pollt `/api/mastercase`, schreibt strukturierten Report. **Generisch, ordner-parametrisiert.** |
| `scripts/case_assert.py` | Vergleicht Report gegen Fixture: Soll/Ist/Diff je Position, Bescheid-Kennzahlen, Coverage. Exit != 0 bei Abweichung. |
| `tests/groundtruth/<case>.json` | Soll-Werte. **Nur hier** — nie im Produktivcode/Prompt/Katalog. |

## Wo laeuft das

Die Engine (`ctax-web`) laeuft auf Host **h200v**, Port **7190**. Die Skripte sind
fuer die Ausfuehrung **auf h200v** gedacht (dort ist `http://localhost:7190`
erreichbar). Ground-Truth-Fixture und Skripte liegen im Repo; auf h200v
synchronisiert.

## Ablauf auf h200v

```bash
ssh -o BatchMode=yes h200v

# (falls noch nicht dort) Skripte + Fixture hinkopieren — vom Mac aus:
#   scp scripts/case_e2e.py scripts/case_assert.py h200v:~/verify/
#   scp tests/groundtruth/hildburg-2024.json     h200v:~/verify/groundtruth/

cd ~/verify

# 1) E2E fresh fahren (Ordner + VZ; caseId optional)
python3 case_e2e.py /home/christoph.bertsch/0711-sturm-elster/Belege 2024
#   -> schreibt /tmp/Belege-e2e.json (Pfad steht auf stdout)
#   -> Fortschritt/Logs auf stderr (POST, Mastercase-Poll-Status)

# 2) Cent-genau gegen Ground Truth pruefen
python3 case_assert.py /tmp/Belege-e2e.json groundtruth/hildburg-2024.json
echo "Exit: $?"   # 0 = PASS, 1 = Abweichung/Coverage-Fail
```

Einzeiler (Report-Pfad direkt durchreichen):

```bash
OUT=$(python3 case_e2e.py /home/christoph.bertsch/0711-sturm-elster/Belege 2024)
python3 case_assert.py "$OUT" groundtruth/hildburg-2024.json
```

## case_e2e.py — Optionen

```
python3 case_e2e.py <belege-ordner> <vz> [caseId] [Optionen]

  --out <pfad>            Ziel-JSON (default /tmp/<caseId>.json)
  --base <url>            Engine-URL (default http://localhost:7190; ENV CTAX_BASE)
  --timeout-precalc <s>   Timeout POST /api/steuerfall (default 900)
  --poll-budget <s>       Mastercase-Poll-Budget (default 600)
  --poll-interval <s>     Poll-Intervall (default 6)
  --no-poll               Mastercase-Polling ueberspringen
  --exclude <substr>      Dateiname-Teilstring ausschliessen (mehrfach)
  --no-fresh              fresh:false (Cache erlauben — nur Debug)
```

Der Report enthaelt:
- `meta` (Veranlagungsart, OCR-Count, Mastercase-Status),
- `belege[]` (pro Beleg: Typ, Person, Status, **feldAnzahl** — Coverage),
- `calcs[]` (Bescheid: `bindend.{zve,einkommensteuer,kirchensteuer,gesamtsteuer}`, `angerechnet`, `erstattung`),
- `warnings[]`,
- `positionen{}` — **je E-Code alle beobachteten Werte** aus `fields`, `belege[].felderListe` und `mastercase.fakten` (verlustfrei, ohne Heuristik),
- `raw` — vollstaendige Engine-Antwort + Mastercase (Audit-Artefakt).

## case_assert.py — was geprueft wird

1. **Eingangsbetraege** (`positionen` im Fixture): jeder Soll-E-Code wird gegen
   **jede** beobachtete Position desselben E-Codes gematcht; der beste
   Cent-Treffer gewinnt. `toleranzCent: 0` = exakt. Deutsche Zahlformate
   (`34.726,16`, `2960,00`, `34726`) werden normalisiert.
2. **Vorauszahlungen/Anrechnung** und **Bescheid-Kennzahlen** (Erstattung/zvE) —
   teils als Korridor (`matchModus: korridor`, solange Endwerte nach Epic A-D
   noch nicht cent-fix sind).
3. **Coverage** (Epic A0/E3c): **jeder** Beleg liefert Felder **oder** eine
   begruendete Warnung. 0-Felder-Belege ohne Warnung => **FAIL**.

`matchModus` je Position: `zahl` (default, cent), `datum`, `text`, `korridor`.

Optionen:
```
  --json               Maschinenlesbares Ergebnis zusaetzlich auf stdout
  --strict-optional    Auch optionale (required=false) Abweichungen failen
  --no-coverage        Coverage-Assertion ueberspringen
```

## Fremder Mandant (ohne Code-Aenderung)

```bash
python3 case_e2e.py /pfad/zu/anderem/mandanten-ordner 2024 anderer-fall
# -> /tmp/anderer-fall.json ; eigenes tests/groundtruth/<fall>.json anlegen,
#    dann case_assert.py dagegen. Kein Eingriff in die Engine.
```

## Definition of Done (Epic E)

E2E rechnet fresh/ohne Cache/ohne Mock durch; jeder Beleg liefert Felder oder
eine begruendete Warnung; In-Process == MCP auf 0 Cent; das Endergebnis (kleine
Erstattung statt grosser Nachzahlung) deckt sich mit dem Fixture — und dieselbe
Pipeline rechnet einen fremden Ordner ohne Code-Aenderung.
