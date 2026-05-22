import { defineStage } from '../core/stage.ts';

export interface BescheidRenderInput {
  mandant: string;
  year: number;
  daten?: Record<string, any>;
  audit: {
    polar_n: number;
    mandanten_n: number;
    profil_n: number;
    union_n: number;
    dropped: Array<{ ecode: string; value: string }>;
    polar_source: string;
    profile_path: string | null;
  };
  ecodes_sent: number;
  lane1_ms: number;
  ok: boolean;
  error?: unknown;
}

export interface BescheidRenderOutput {
  markdown: string;
  zusammenfassung: {
    zve: number;
    einkommensteuer: number;
    solidaritaetszuschlag: number;
    gesamtsteuer: number;
    vorauszahlungen: number;
    erstattung_oder_nachzahlung: number;
    label: 'Erstattung' | 'Nachzahlung' | '—';
    grenzsteuersatz: number;
    durchschnittssteuersatz: number;
    bmf_konform: boolean;
    fall_id: string;
  };
  fehlende_belege: Array<Record<string, unknown>>;
}

function fmtEur(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * Rendert Lane-1 Output als Markdown-Bescheid + strukturierte Zusammenfassung.
 */
export const bescheidRenderStage = defineStage<BescheidRenderInput, BescheidRenderOutput>({
  id: 'bescheid-render',
  name: 'Bescheid-Render',
  description: 'Markdown-Bescheid + strukturierte Zusammenfassung',

  async run(input, _ctx) {
    const { mandant, year, daten, audit, ecodes_sent, lane1_ms, ok, error } = input;
    const lines: string[] = [];

    lines.push(`# Steuerbescheid-Vorschau ${year} — ${mandant}`);
    lines.push(`*Pipeline: bescheid-pipeline · sturm-rc · ${new Date().toISOString()}*`);
    if (audit.profile_path) lines.push(`*Profil: \`${audit.profile_path}\`*`);
    lines.push(`*Polar-Source: \`${audit.polar_source}\`*`);

    if (!ok || !daten) {
      lines.push(`\n## ❌ FEHLER\n`);
      lines.push('```');
      lines.push(JSON.stringify(error, null, 2).slice(0, 1500));
      lines.push('```');
      const empty = { zve: 0, einkommensteuer: 0, solidaritaetszuschlag: 0, gesamtsteuer: 0,
                     vorauszahlungen: 0, erstattung_oder_nachzahlung: 0, label: '—' as const,
                     grenzsteuersatz: 0, durchschnittssteuersatz: 0, bmf_konform: false, fall_id: '—' };
      return { markdown: lines.join('\n'), zusammenfassung: empty, fehlende_belege: [] };
    }

    const eo = Number(daten.erstattung_oder_nachzahlung ?? 0);
    const label: 'Erstattung' | 'Nachzahlung' = eo < 0 ? 'Erstattung' : 'Nachzahlung';

    lines.push(`\n## Ergebnis\n`);
    lines.push(`| Position | Betrag |\n|---|---:|`);
    lines.push(`| zu versteuerndes Einkommen | **${fmtEur(Number(daten.zve ?? 0))}** |`);
    lines.push(`| Einkommensteuer §32a | **${fmtEur(Number(daten.einkommensteuer ?? 0))}** |`);
    lines.push(`| Solidaritätszuschlag | ${fmtEur(Number(daten.solidaritaetszuschlag ?? 0))} |`);
    lines.push(`| Gesamtsteuerschuld | ${fmtEur(Number(daten.gesamtsteuer ?? 0))} |`);
    lines.push(`| − Vorauszahlungen | ${fmtEur(Number(daten.steuervorauszahlungen ?? 0))} |`);
    lines.push(`| **${label}** | **${fmtEur(Math.abs(eo))}** |`);
    lines.push(`| Grenzsteuersatz | ${(Number(daten.grenzsteuersatz ?? 0) * 100).toFixed(2)} % |`);
    lines.push(`| Ø-Steuersatz | ${(Number(daten.durchschnittssteuersatz ?? 0) * 100).toFixed(2)} % |`);

    const bd = daten.berechnungsdetails ?? {};
    const steps = bd.rechenschritte ?? [];
    if (Array.isArray(steps) && steps.length > 0) {
      lines.push(`\n## Rechenschritte (§-konform)\n`);
      lines.push(`| # | Schritt | Betrag |\n|---|---|---:|`);
      for (const s of steps) {
        lines.push(`| ${s.schritt ?? '?'} | ${s.bezeichnung ?? '?'} | ${fmtEur(Number(s.wert ?? 0))} |`);
      }
    }

    lines.push(`\n## Aggregation\n`);
    lines.push(`- Polar Tier-1+2 (cache): **${audit.polar_n}** eCodes`);
    lines.push(`- Mandanten elsterExtract: **${audit.mandanten_n}** eCodes`);
    lines.push(`- Profil-Stammdaten: **${audit.profil_n}** eCodes`);
    lines.push(`- Union: **${audit.union_n}** eCodes`);
    lines.push(`- An Lane-1 gesendet: **${ecodes_sent}** eCodes`);
    lines.push(`- Gefiltert: **${audit.dropped.length}** (non-numeric in Numerik-Slots)`);

    const fehl = (daten.fehlende_belege ?? []) as any[];
    if (fehl.length > 0) {
      lines.push(`\n## Fehlende Belege\n`);
      for (const f of fehl) {
        lines.push(`- **${f.category}**: ${f.betrag} € — ${f.begruendung} (${f.legal_reference})`);
      }
    }

    lines.push(`\n## Timing\n`);
    lines.push(`- Lane-1 Compute: **${lane1_ms} ms**`);

    return {
      markdown: lines.join('\n'),
      zusammenfassung: {
        zve: Number(daten.zve ?? 0),
        einkommensteuer: Number(daten.einkommensteuer ?? 0),
        solidaritaetszuschlag: Number(daten.solidaritaetszuschlag ?? 0),
        gesamtsteuer: Number(daten.gesamtsteuer ?? 0),
        vorauszahlungen: Number(daten.steuervorauszahlungen ?? 0),
        erstattung_oder_nachzahlung: eo,
        label,
        grenzsteuersatz: Number(daten.grenzsteuersatz ?? 0),
        durchschnittssteuersatz: Number(daten.durchschnittssteuersatz ?? 0),
        bmf_konform: Boolean(daten.bmf_konform),
        fall_id: String(daten.fall_id ?? '—'),
      },
      fehlende_belege: fehl,
    };
  },
});
