import { describe, it, expect } from "vitest";
import { greedySetCover } from "./set-cover.ts";

describe("greedySetCover", () => {
  it("zwangsselektiert Pflicht-eCodes auch ohne Section-Match", () => {
    const r = greedySetCover({
      sections: [{ id: "s1" }],
      candidates: [{ ecode: "E0001", score: 0.9, coversSections: ["s1"] }],
      pflichtEcodes: ["E9999"], // nicht in candidates
    });
    expect(r.selected).toContain("E9999");
    expect(r.selectionTrace[0].reason).toBe("pflicht");
  });

  it("waehlt cost-effective set-cover", () => {
    const r = greedySetCover({
      sections: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      candidates: [
        { ecode: "E_BIG", score: 0.8, coversSections: ["s1", "s2", "s3"] }, // 1 ecode -> 3 sections
        { ecode: "E_SMALL_A", score: 0.95, coversSections: ["s1"] },
        { ecode: "E_SMALL_B", score: 0.95, coversSections: ["s2"] },
      ],
      pflichtEcodes: [],
    });
    expect(r.selected).toEqual(["E_BIG"]);
    expect(r.uncoveredSections).toEqual([]);
  });

  it("filtert Kandidaten unter minScoreForCoverage", () => {
    const r = greedySetCover({
      sections: [{ id: "s1" }],
      candidates: [{ ecode: "E0001", score: 0.4, coversSections: ["s1"] }],
      pflichtEcodes: [],
      minScoreForCoverage: 0.5,
    });
    expect(r.selected).toEqual([]);
    expect(r.uncoveredSections).toEqual(["s1"]);
  });

  it("ist deterministisch bei tie", () => {
    const inp = {
      sections: [{ id: "s1" }],
      candidates: [
        { ecode: "E_B", score: 0.8, coversSections: ["s1"] },
        { ecode: "E_A", score: 0.8, coversSections: ["s1"] },
      ],
      pflichtEcodes: [],
    };
    const r1 = greedySetCover(inp);
    const r2 = greedySetCover(inp);
    expect(r1.selected).toEqual(r2.selected);
    // Lex tie-break: E_A < E_B → E_A gewinnt
    expect(r1.selected).toEqual(["E_A"]);
  });
});
