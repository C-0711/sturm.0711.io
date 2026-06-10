-- ============================================================================
-- B4 — Festgeschriebener Rentenfreibetrag (§22 Nr.1 EStG) im BMF-MCP aktivieren
-- ============================================================================
-- Ziel-DB:  Container ctaxv1-postgres, DB `ctax`, Schema `lane1_bmf_calculator`
-- Dienst:   ctaxv1-lane1-bmf (CTAXV1/docker-compose.yml, MCP :12010)
--
-- Befund (MCP-Code-Kartierung): Die Formel
--     rente_erstes_jahr      = rente_brutto - rentenanpassungsbetrag      (step 1)
--     rentenfreibetrag_konst = rente_erstes_jahr * (1 - besteuerungsanteil/100)
--     rente_steuerpflichtig  = rente_brutto - rentenfreibetrag_konst
-- ist gesetzlich KORREKT (fixierter Freibetrag). Aber `rentenanpassungsbetrag`
-- hatte KEIN eCode-Mapping (module_id=10) → immer 0 → rente_erstes_jahr =
-- rente_brutto → freibetrag = 0.5*Brutto → steuerpflichtig kollabiert zu
-- Besteuerungsanteil × AKTUELLEM Brutto (Unterschätzung).
--
-- Fix: Mapping ergänzen. Der sturm-Extraktor liefert bereits E1800606
-- (Rentenanpassungsbetrag); E2400106/E2400206 sind die ELSTER-Anlage-R-Codes.
-- `feldateToElsterFelder` reicht E1800606 unverändert an den MCP durch.
--
-- Verifiziert (MCP-Direkttest, Rente 24807,78 / Beginn 1995 / Anpassung 7953,18):
--   ohne Mapping: zvE 12265,89   |   mit Mapping: zvE 16242,48  (= 24807,78
--   − 0,5×(24807,78−7953,18) − 102 WK − 36 SA-Pauschbetrag).  End-to-end im
--   echten /api/steuerfall: Hildburg-zvE 37325,06 → 41301,56.
--
-- Anwenden:  psql ... -f diese_datei  &&  docker compose restart lane1-bmf
--            (Mappings sind @lru_cache beim Boot → Restart zwingend.)
-- Rückgängig: DELETE FROM lane1_bmf_calculator.module_mappings
--             WHERE module_id=10 AND canonical_field='rentenanpassungsbetrag';
-- ============================================================================

INSERT INTO lane1_bmf_calculator.module_mappings
  (canonical_field, module_id, is_required, is_trigger, priority,
   elster_code_quelle, aggregation, preprocessing)
VALUES
  ('rentenanpassungsbetrag', 10, false, false, 0,
   '{E1800606,E2400106,E2400206}', 'sum', 'comma_to_dot')
ON CONFLICT DO NOTHING;
