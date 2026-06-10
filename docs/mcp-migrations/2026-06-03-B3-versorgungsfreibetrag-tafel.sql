-- ============================================================================
-- B3 — Versorgungsfreibetrags-Tafel §19 Abs. 2 EStG, Jahrgänge 2007–2022
-- ============================================================================
-- Ziel-DB: lane1_bmf_calculator.thresholds (category 'versorgungsfreibetrag')
--
-- BEFUND (MCP-Test): Der Versorgungsfreibetrag wird NICHT in Modul 10 gerechnet
-- (dessen §19-Formeln haben kein Input-Mapping → versorgung_summe=0), sondern in
-- Modul 29 (werbungskosten_pauschbetraege, versorgungsbezuege ← E0200801). Das
-- `massgebendes_jahr` defaultet auf 2005 (kein Versorgungsbeginn-Mapping) → der
-- Lookup liefert IMMER 40 %/3000/900. Für Hildburg (Beginn 1991, ≤2005) ist 40 %
-- zufällig korrekt; für Beginn 2007–2022 ist es falsch.
--
-- DIESE MIGRATION liefert die fehlenden Tafelwerte (gesicherter AltEinkG-Schedule
-- 2005er Fassung: −1,6pp/−120/−36 bis 2020, dann −0,8pp/−60/−18). Sie ist additiv
-- und harmlos.
--
-- ⚠️ NOCH NICHT WIRKSAM ohne den zweiten Schritt: Der VersorgungsBEGINN muss als
-- canonical `versorgungsbezuege_1_beginn` auf das Modul gemappt werden, das den
-- Freibetrag rechnet (Modul 29 prüfen!) — OHNE den Versorgungsbetrag zusätzlich
-- auf Modul 10 zu mappen (sonst Doppelzählung Modul 10 + 29 → Hildburg bricht).
-- Erst nach geklärtem Mapping anwenden + gegen Hildburg (muss +160,78 bleiben)
-- UND einen 2010er-Beginn (Soll 32 %/2400/720) testen.
--
-- 2023+ bewusst ausgelassen: Wachstumschancengesetz (−0,4pp/−30/−9 ab 2023) —
-- separat zu verifizieren. Vorhandene Zeilen 2005/2006/2024 unverändert.
-- Anwenden: psql ... -f diese_datei && docker compose restart lane1-bmf
-- ============================================================================

INSERT INTO lane1_bmf_calculator.thresholds
  (threshold_name, category, threshold_value, threshold_type, unit, tax_year, legal_reference)
VALUES
  ('versorgungsfreibetrag_prozent_2007',  'versorgungsfreibetrag', 36.80, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2007',      'versorgungsfreibetrag', 2760.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2007', 'versorgungsfreibetrag', 828.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2008',  'versorgungsfreibetrag', 35.20, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2008',      'versorgungsfreibetrag', 2640.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2008', 'versorgungsfreibetrag', 792.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2009',  'versorgungsfreibetrag', 33.60, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2009',      'versorgungsfreibetrag', 2520.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2009', 'versorgungsfreibetrag', 756.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2010',  'versorgungsfreibetrag', 32.00, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2010',      'versorgungsfreibetrag', 2400.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2010', 'versorgungsfreibetrag', 720.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2011',  'versorgungsfreibetrag', 30.40, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2011',      'versorgungsfreibetrag', 2280.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2011', 'versorgungsfreibetrag', 684.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2012',  'versorgungsfreibetrag', 28.80, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2012',      'versorgungsfreibetrag', 2160.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2012', 'versorgungsfreibetrag', 648.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2013',  'versorgungsfreibetrag', 27.20, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2013',      'versorgungsfreibetrag', 2040.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2013', 'versorgungsfreibetrag', 612.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2014',  'versorgungsfreibetrag', 25.60, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2014',      'versorgungsfreibetrag', 1920.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2014', 'versorgungsfreibetrag', 576.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2015',  'versorgungsfreibetrag', 24.00, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2015',      'versorgungsfreibetrag', 1800.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2015', 'versorgungsfreibetrag', 540.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2016',  'versorgungsfreibetrag', 22.40, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2016',      'versorgungsfreibetrag', 1680.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2016', 'versorgungsfreibetrag', 504.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2017',  'versorgungsfreibetrag', 20.80, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2017',      'versorgungsfreibetrag', 1560.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2017', 'versorgungsfreibetrag', 468.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2018',  'versorgungsfreibetrag', 19.20, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2018',      'versorgungsfreibetrag', 1440.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2018', 'versorgungsfreibetrag', 432.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2019',  'versorgungsfreibetrag', 17.60, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2019',      'versorgungsfreibetrag', 1320.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2019', 'versorgungsfreibetrag', 396.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2020',  'versorgungsfreibetrag', 16.00, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2020',      'versorgungsfreibetrag', 1200.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2020', 'versorgungsfreibetrag', 360.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2021',  'versorgungsfreibetrag', 15.20, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2021',      'versorgungsfreibetrag', 1140.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2021', 'versorgungsfreibetrag', 342.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_prozent_2022',  'versorgungsfreibetrag', 14.40, 'prozent', '%',   2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_max_2022',      'versorgungsfreibetrag', 1080.00, 'betrag', 'EUR', 2024, '§19 Abs.2 EStG'),
  ('versorgungsfreibetrag_zuschlag_2022', 'versorgungsfreibetrag', 324.00,  'betrag', 'EUR', 2024, '§19 Abs.2 EStG')
ON CONFLICT DO NOTHING;
