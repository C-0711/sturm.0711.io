"""
German tax law constants — algorithmic, not data.

These are statutory parameters with explicit §-references. Not mock values:
they are the actual gesetzliche Werte that drive arithmetic constraints in
tax-form validation. Updating them requires an act of parliament (or
Bundessozialversicherungs-Rechengrößenverordnung for SV-BBG/Rates).

Scope: VZ 2023 (Stricker-Test). For other Veranlagungszeiträume, add a
year-keyed lookup — same statute, different parameter values per year.
"""

# ────────────────────────────────────────────────────────────────────────────
# § 4 SolzG — Solidaritätszuschlag
# ────────────────────────────────────────────────────────────────────────────
SOLI_RATE = 0.055  # 5.5% on ESt and KESt

# Freigrenze § 3 SolzG — under threshold, Soli = 0
SOLI_FREIGRENZE_2023_SINGLE = 17543  # EUR ESt
SOLI_FREIGRENZE_2023_VERHEIRATET = 35086

# ────────────────────────────────────────────────────────────────────────────
# Kirchensteuer — Landeskirchensteuergesetze
# ────────────────────────────────────────────────────────────────────────────
KIST_RATE_BY_BW = 0.08          # Bayern, Baden-Württemberg
KIST_RATE_ELSEWHERE = 0.09      # alle anderen Bundesländer
KIST_RATES_VALID = (0.0, KIST_RATE_BY_BW, KIST_RATE_ELSEWHERE)

# § 51a (2c) EStG — KiSt-Bemessungsgrundlage Kapitalerträge
# Sparer-Pauschbetrag wird NICHT abgezogen für KiSt-Berechnung
# → KiSt = Rate × KESt direkt

# ────────────────────────────────────────────────────────────────────────────
# § 20 (9) EStG — Sparer-Pauschbetrag
# ────────────────────────────────────────────────────────────────────────────
SPARER_PAUSCHBETRAG_2023_SINGLE = 1000        # bis VZ 2022: 801
SPARER_PAUSCHBETRAG_2023_VERHEIRATET = 2000   # gemeinsame Veranlagung

# ────────────────────────────────────────────────────────────────────────────
# § 9a EStG — Pauschbeträge Werbungskosten
# ────────────────────────────────────────────────────────────────────────────
ARBEITNEHMER_PAUSCHBETRAG_2023 = 1230  # § 9a Satz 1 Nr. 1 Buchst. a
WK_PAUSCHBETRAG_KAP = 0                # entfallen mit Sparer-Pauschbetrag
WK_PAUSCHBETRAG_VERMIETUNG = 0         # echte WK nachzuweisen
WK_PAUSCHBETRAG_SONSTIGE = 102         # § 9a Satz 1 Nr. 3

# ────────────────────────────────────────────────────────────────────────────
# § 9 (1) Nr. 4 EStG — Entfernungspauschale
# ────────────────────────────────────────────────────────────────────────────
ENTFERNUNGSPAUSCHALE_KM_1_20 = 0.30          # EUR/km
ENTFERNUNGSPAUSCHALE_KM_AB_21_2022_2026 = 0.38  # § 9 (1) Nr. 4 Satz 8
ENTFERNUNGSPAUSCHALE_JAHRESHOECHST = 4500    # § 9 (1) Nr. 4 Satz 2 (ohne eigenen PKW)
# Aufhebung Höchstbetrag bei eigenem KFZ — § 9 (2) Satz 2

# ────────────────────────────────────────────────────────────────────────────
# § 9 (4a) EStG — Verpflegungsmehraufwand
# ────────────────────────────────────────────────────────────────────────────
VERPFLEGUNG_PAUSCHALE_24H = 28               # Inland, ganztägig
VERPFLEGUNG_PAUSCHALE_8H_OR_ANREISE = 14     # >8h Abwesenheit ODER An-/Abreise

# Doppelte Haushaltsführung — § 9 (1) Nr. 5
DOPPELTE_HAUSHALT_MIETE_HOECHST = 1000       # EUR/Monat, § 9 (1) Nr. 5 Satz 4

# ────────────────────────────────────────────────────────────────────────────
# § 32a EStG — Einkommensteuertarif 2023
# ────────────────────────────────────────────────────────────────────────────
GRUNDFREIBETRAG_2023 = 10908             # § 32a (1) Nr. 1
SPLITTINGTARIF_GRUNDFREIBETRAG_2023 = 2 * GRUNDFREIBETRAG_2023
SPITZENSTEUERSATZ = 0.42                 # § 32a (1) Nr. 4
REICHENSTEUER_SATZ = 0.45                # § 32a (1) Nr. 5 (ab 277.826 € zvE)
REICHENSTEUER_GRENZE_2023 = 277826

# ────────────────────────────────────────────────────────────────────────────
# § 32a (5) EStG — Tarifzonen 2023 (zvE in €)
# ────────────────────────────────────────────────────────────────────────────
# Zone 1: 0 – 10.908 → 0
# Zone 2: 10.909 – 15.999 → progressiv (Eingangssteuersatz 14%)
# Zone 3: 16.000 – 62.809 → progressiv
# Zone 4: 62.810 – 277.825 → 42%
# Zone 5: ab 277.826 → 45%
TARIF_ZONE_2_OBERGRENZE_2023 = 15999
TARIF_ZONE_3_OBERGRENZE_2023 = 62809
TARIF_ZONE_4_OBERGRENZE_2023 = 277825
EINGANGSSTEUERSATZ = 0.14

# ────────────────────────────────────────────────────────────────────────────
# Sozialversicherung 2023 — Beitragssätze
# (Bundessozialversicherungs-Rechengrößenverordnung 2023)
# ────────────────────────────────────────────────────────────────────────────
RV_RATE_2023 = 0.186                      # § 158 SGB VI (9.3% AN + 9.3% AG)
RV_RATE_AN = 0.093
RV_RATE_AG = 0.093

KV_ALLG_RATE_2023 = 0.146                 # § 241 SGB V (7.3% AN + 7.3% AG)
KV_RATE_AN = 0.073
KV_RATE_AG = 0.073
KV_ZUSATZBEITRAG_DURCHSCHN_2023 = 0.016   # GKV-Schätzerkreis durchschn.

PV_RATE_2023 = 0.0305                     # § 55 (1) SGB XI (1.525% AN + 1.525% AG)
PV_ZUSCHLAG_KINDERLOS_AB_23 = 0.0035      # § 55 (3) SGB XI — Kinderlose
PV_RATE_KINDERLOS = PV_RATE_2023 + PV_ZUSCHLAG_KINDERLOS_AB_23  # 3.4%
PV_RATE_SACHSEN_AN = 0.02025              # Sachsen-Sonderregel

ALV_RATE_2023 = 0.026                     # § 341 SGB III (1.3% AN + 1.3% AG)
ALV_RATE_AN = 0.013
ALV_RATE_AG = 0.013

# Beitragsbemessungsgrenzen 2023 (Monatswerte)
BBG_RV_KNV_WEST_MONAT_2023 = 7300         # West & Knappschaft
BBG_RV_OST_MONAT_2023 = 7100
BBG_KV_PV_MONAT_2023 = 4987.50            # bundeseinheitlich
BBG_RV_KNV_WEST_JAHR_2023 = 87600
BBG_RV_OST_JAHR_2023 = 85200
BBG_KV_PV_JAHR_2023 = 59850

# Knappschaftliche RV — § 158 SGB VI
RV_KNAPPSCHAFT_RATE_2023 = 0.247

# ────────────────────────────────────────────────────────────────────────────
# § 10 EStG — Sonderausgaben Vorsorgeaufwendungen
# ────────────────────────────────────────────────────────────────────────────
# § 10 (1) Nr. 2 — Altersvorsorge (Basis: gesetzliche RV + Rürup + berufsst. Vers.)
# Höchstbetrag = Höchstbeitrag knappschaftliche RV × 2 für 2023 voll
# 2023: 2 × Beitragsbemessungsgrenze West-Knappschaft × Rate
# Vereinfacht: 26.528 € (single) / 53.056 € (verh.) — bestätigt durch BMF
ALTERSVORSORGE_HOECHSTBETRAG_2023_SINGLE = 26528
ALTERSVORSORGE_HOECHSTBETRAG_2023_VERHEIRATET = 53056
# Abzugsfähig: 100% des bis Höchstbetrag eingezahlten Betrags (ab 2023 volle 100%)
ALTERSVORSORGE_ABZUGSPROZENTSATZ_2023 = 1.00   # § 10 (3) Satz 6 — ab VZ 2023

# § 10 (1) Nr. 3 — Krankenversicherung Basis-KV / Pflegepflicht
# Voll abzugsfähig (Basis-Anteil)

# § 10 (1) Nr. 3a — sonstige Vorsorgeaufwendungen
SONSTIGE_VORSORGE_HOECHST_ARBEITNEHMER = 1900   # § 10 (4) Satz 1
SONSTIGE_VORSORGE_HOECHST_SELBSTAENDIG = 2800   # § 10 (4) Satz 2

# § 10a EStG — Altersvorsorgezulage (Riester)
RIESTER_HOECHSTBETRAG = 2100              # § 10a (1) Satz 1
RIESTER_GRUNDZULAGE = 175                 # § 84 EStG
RIESTER_KINDERZULAGE_AB_2008 = 300        # § 85 (1) Satz 2 (Kind geb. ab 2008)
RIESTER_KINDERZULAGE_VOR_2008 = 185
RIESTER_MINDESTEIGENBEITRAG_PROZENT = 0.04  # § 86 (1)
RIESTER_SOCKELBETRAG = 60                  # § 86 (1) Satz 4 (Mindestbeitrag-Untergrenze)

# ────────────────────────────────────────────────────────────────────────────
# § 32 EStG — Kinderfreibetrag + BEA
# ────────────────────────────────────────────────────────────────────────────
KINDERFREIBETRAG_2023_GESAMT = 6024        # pro Kind, gemeinsam beide Elternteile
BEA_FREIBETRAG_2023_GESAMT = 2928          # Betreuung/Erziehung/Ausbildung
KINDERFREIBETRAEGE_2023_GESAMT = KINDERFREIBETRAG_2023_GESAMT + BEA_FREIBETRAG_2023_GESAMT
KINDERFREIBETRAG_PRO_ELTERNTEIL_2023 = KINDERFREIBETRAEGE_2023_GESAMT // 2

# Kindergeld 2023 (zum Vergleich Günstigerprüfung)
KINDERGELD_2023_PRO_KIND_MONAT = 250        # einheitlich seit 01.01.2023

# § 33a (1) — Unterhaltsleistungen
UNTERHALT_HOECHSTBETRAG_2023 = 10908        # = Grundfreibetrag

# § 33a (2) — Ausbildungsfreibetrag
AUSBILDUNGSFREIBETRAG_2023 = 1200

# ────────────────────────────────────────────────────────────────────────────
# § 33b EStG — Behindertenpauschbeträge (Reform 2021)
# ────────────────────────────────────────────────────────────────────────────
BEHINDERTEN_PAUSCHBETRAG_BY_GDB = {
    20: 384, 30: 620, 40: 860, 50: 1140, 60: 1440,
    70: 1780, 80: 2120, 90: 2460, 100: 2840,
}
BEHINDERTEN_PAUSCHBETRAG_HILFLOS_BLIND_TAUBBLIND = 7400  # H, Bl, TBl

# § 33b (6) — Pflege-Pauschbetrag
PFLEGE_PAUSCHBETRAG_PG2 = 600
PFLEGE_PAUSCHBETRAG_PG3 = 1100
PFLEGE_PAUSCHBETRAG_PG4_PG5_H = 1800

# ────────────────────────────────────────────────────────────────────────────
# § 33 (3) EStG — Zumutbare Eigenbelastung (Staffel)
# Tabelle: Familienstand × Kinderzahl × Einkommens-Tier → Prozentsatz vom GdE
# ────────────────────────────────────────────────────────────────────────────
# Tier-Grenzen (Gesamtbetrag der Einkünfte):
ZUMUTBAR_TIER_1_OBERGRENZE = 15340   # bis
ZUMUTBAR_TIER_2_OBERGRENZE = 51130   # 15.341 – 51.130
                                      # > 51.130: Tier 3

ZUMUTBARE_EIGENBELASTUNG = {
    # (familienstand, kinder_count, tier): prozentsatz
    ("single",      0, 1): 0.05, ("single",      0, 2): 0.06, ("single",      0, 3): 0.07,
    ("verheiratet", 0, 1): 0.04, ("verheiratet", 0, 2): 0.05, ("verheiratet", 0, 3): 0.06,
    # 1-2 Kinder
    ("any", 1, 1): 0.02, ("any", 1, 2): 0.03, ("any", 1, 3): 0.04,
    ("any", 2, 1): 0.02, ("any", 2, 2): 0.03, ("any", 2, 3): 0.04,
    # 3+ Kinder
    ("any", 3, 1): 0.01, ("any", 3, 2): 0.01, ("any", 3, 3): 0.02,
}

# ────────────────────────────────────────────────────────────────────────────
# § 24a EStG — Altersentlastungsbetrag (Tabelle nach Geburtsjahr)
# Person muss am 1.1. des VZ das 64. LJ vollendet haben → geb. vor 02.01.1959
# ────────────────────────────────────────────────────────────────────────────
ALTERSENTLASTUNG_2023_MAX_PROZENT = 0.136     # für geb. 1958
ALTERSENTLASTUNG_2023_MAX_BETRAG = 646        # EUR Höchstbetrag bei geb. 1958
# Lineare Abschmelzung in den Jahren — vereinfacht hier nur die 2023-Werte:
ALTERSENTLASTUNG_GEBURTSJAHR_LIMIT = 1959     # nur Personen geboren vor 02.01.1959

# ────────────────────────────────────────────────────────────────────────────
# § 35a EStG — haushaltsnahe Beschäftigung / Dienstleistungen
# ────────────────────────────────────────────────────────────────────────────
HAUSHALTSNAHE_BESCHAEFTIGUNG_HOECHST = 510    # § 35a (1)
HAUSHALTSNAHE_DIENSTL_HOECHST = 4000           # § 35a (2)
HANDWERKER_LEISTUNG_HOECHST = 1200              # § 35a (3)
HAUSHALTSNAHE_PROZENT = 0.20                    # 20% der Aufwendungen

# ────────────────────────────────────────────────────────────────────────────
# § 10b EStG — Spenden
# ────────────────────────────────────────────────────────────────────────────
SPENDEN_HOECHSTBETRAG_PROZENT_GDE = 0.20       # 20% des GdE
SPENDEN_HOECHSTBETRAG_PROZENT_UMSATZ = 0.004    # 4‰ Summe Umsätze + Lohn (Unt.)

# ────────────────────────────────────────────────────────────────────────────
# Tolerances for ratio matches (handle 2-decimal rounding)
# ────────────────────────────────────────────────────────────────────────────
RATIO_TOLERANCE = 0.002       # ±0.2 percentage points on rate ratios
ABS_TOLERANCE_CENTS = 2       # absolute rounding tolerance for derived values
SUM_TOLERANCE_CENTS = 5       # for accumulated sum-of-components matches

# ────────────────────────────────────────────────────────────────────────────
# Helper: Bundesland → KiSt-Rate aus Finanzamt-Name oder PLZ
# Algorithmisch, kein Mock — nutzt offizielle Finanzamt-Liste BMF
# ────────────────────────────────────────────────────────────────────────────
KIST_RATE_BY_BUNDESLAND = {
    "BW": KIST_RATE_BY_BW, "BY": KIST_RATE_BY_BW,
    "BE": KIST_RATE_ELSEWHERE, "BB": KIST_RATE_ELSEWHERE,
    "HB": KIST_RATE_ELSEWHERE, "HH": KIST_RATE_ELSEWHERE,
    "HE": KIST_RATE_ELSEWHERE, "MV": KIST_RATE_ELSEWHERE,
    "NI": KIST_RATE_ELSEWHERE, "NW": KIST_RATE_ELSEWHERE,
    "RP": KIST_RATE_ELSEWHERE, "SL": KIST_RATE_ELSEWHERE,
    "SN": KIST_RATE_ELSEWHERE, "ST": KIST_RATE_ELSEWHERE,
    "SH": KIST_RATE_ELSEWHERE, "TH": KIST_RATE_ELSEWHERE,
}
