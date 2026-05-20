/**
 * Weighted Greedy Set-Cover mit Pflicht-Atom-Forcing.
 *
 * Gegeben:
 *   - candidates: Liste von Kandidaten-eCodes mit Score (z.B. cosinus-aehnlichkeit)
 *     und der Menge an Sektionen, die sie abdecken.
 *   - sections: Liste der Beleg-Sektionen (Universum).
 *   - pflichtEcodes: eCodes, die in JEDEM Fall ins Ergebnis muessen (anlage-spezifisch).
 *
 * Ergebnis:
 *   - selected: gewaehlte eCode-Untermenge
 *   - coverage: welche Sektion durch welchen eCode abgedeckt wird
 *   - uncoveredSections: Sektionen, die kein Kandidat erreicht hat
 *
 * Algorithmus:
 *   1. Pflicht-eCodes werden zwangsweise selektiert (auch wenn sie keine Section abdecken).
 *   2. Greedy: in jeder Runde der Kandidat, der die meisten unabgedeckten Sektionen
 *      pro Score-Einheit abdeckt (cost-effective set-cover Heuristik).
 *   3. Abbruch wenn: maxEcodes erreicht ODER alle Sektionen abgedeckt ODER kein Kandidat
 *      mehr eine neue Section abdeckt.
 *
 * Deterministisch — tie-break ueber lex(eCode), keine RNG.
 */

export interface SectionRef {
  id: string;
  label?: string;
}

export interface ECodeCandidate {
  ecode: string;
  score: number; // cosinus-Aehnlichkeit, [0,1], aus polar-cone-retrieval
  coversSections: string[]; // section IDs aus retrieval matches
}

export interface SetCoverInput {
  sections: SectionRef[];
  candidates: ECodeCandidate[];
  pflichtEcodes: string[];
  maxEcodes?: number;
  minScoreForCoverage?: number;
}

export interface SetCoverResult {
  selected: string[];
  coverage: { sectionId: string; ecode: string; score: number }[];
  uncoveredSections: string[];
  selectionTrace: { round: number; ecode: string; reason: "pflicht" | "greedy"; newlyCovered: string[]; score: number }[];
}

export function greedySetCover(input: SetCoverInput): SetCoverResult {
  const maxEcodes = input.maxEcodes ?? 50;
  const minScore = input.minScoreForCoverage ?? 0.5;

  const sectionIds = new Set(input.sections.map((s) => s.id));
  const candidates = input.candidates
    .filter((c) => c.score >= minScore)
    .sort((a, b) => (a.ecode < b.ecode ? -1 : 1)); // deterministisch
  const byEcode = new Map(candidates.map((c) => [c.ecode, c]));

  const selected = new Set<string>();
  const covered = new Set<string>();
  const coverageMap: { sectionId: string; ecode: string; score: number }[] = [];
  const trace: SetCoverResult["selectionTrace"] = [];

  // Phase 1: Pflicht-eCodes zwangsweise.
  let round = 0;
  for (const ec of input.pflichtEcodes) {
    if (selected.has(ec)) continue;
    selected.add(ec);
    const cand = byEcode.get(ec);
    const newlyCovered: string[] = [];
    if (cand) {
      for (const sid of cand.coversSections) {
        if (sectionIds.has(sid) && !covered.has(sid)) {
          covered.add(sid);
          coverageMap.push({ sectionId: sid, ecode: ec, score: cand.score });
          newlyCovered.push(sid);
        }
      }
    }
    trace.push({ round: ++round, ecode: ec, reason: "pflicht", newlyCovered, score: cand?.score ?? 0 });
  }

  // Phase 2: Greedy fuer Rest.
  while (selected.size < maxEcodes) {
    let bestEcode: string | null = null;
    let bestNew: string[] = [];
    let bestScore = 0;

    for (const cand of candidates) {
      if (selected.has(cand.ecode)) continue;
      const newCovered = cand.coversSections.filter((sid) => sectionIds.has(sid) && !covered.has(sid));
      if (newCovered.length === 0) continue;
      // cost-effective: anzahl neuer sektionen * score
      const effectiveScore = newCovered.length * cand.score;
      if (effectiveScore > bestScore || (effectiveScore === bestScore && bestEcode && cand.ecode < bestEcode)) {
        bestScore = effectiveScore;
        bestEcode = cand.ecode;
        bestNew = newCovered;
      }
    }

    if (!bestEcode || bestNew.length === 0) break;
    selected.add(bestEcode);
    const cand = byEcode.get(bestEcode)!;
    for (const sid of bestNew) {
      covered.add(sid);
      coverageMap.push({ sectionId: sid, ecode: bestEcode, score: cand.score });
    }
    trace.push({ round: ++round, ecode: bestEcode, reason: "greedy", newlyCovered: bestNew, score: cand.score });
  }

  const uncovered = input.sections.filter((s) => !covered.has(s.id)).map((s) => s.id);

  return {
    selected: Array.from(selected).sort(),
    coverage: coverageMap,
    uncoveredSections: uncovered,
    selectionTrace: trace,
  };
}
