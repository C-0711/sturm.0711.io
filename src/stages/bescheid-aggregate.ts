import { defineStage } from '../core/stage.ts';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface BescheidAggregateInput {
  mandant: string;
  year: number;
  /** Optional: profile-source override. Default: same as mandant. Useful when uploading
   * to a fresh workspace but wanting to reuse a Demo-Profile's Stammdaten. */
  profileMandant?: string;
}

export interface BescheidAggregateOutput {
  elsterFelder: Record<string, string>;
  audit: {
    polar_n: number;
    mandanten_n: number;
    profil_n: number;
    union_n: number;
    dropped: Array<{ ecode: string; value: string }>;
    polar_source: 'cache' | 'missing';
    profile_path: string | null;
  };
}

// Stammdaten-eCodes (Lane-1 erlaubt hier Strings)
const STRING_ECODES = new Set([
  'E0100201', 'E0100301', 'E0100081', 'E0100082', 'E0100401', 'E0100402',
  'E0100403', 'E0100422', 'E0100601', 'E0100602', 'E0100702', 'E0100009',
  'E0100001', 'E0101001', 'E0101002', 'E0101104', 'E0101206', 'E0101301',
  'E0102102', 'E0102202', 'E0101201', 'E0102201', 'E0109402', 'E0109705',
  'E0109704', 'E0242401', 'E0823201', 'E0805703', 'E0200002', 'E2003904',
  'E0101081',
]);

function fmtValue(v: unknown, ecode: string): string | null {
  let s = String(v ?? '').trim();
  s = s.replace(/[€$]|EUR/g, '').trim();
  if (STRING_ECODES.has(ecode)) return s || null;
  const lower = s.toLowerCase();
  if (['ja', 'nein', 'yes', 'no', 'true', 'false', 'x'].includes(lower)) return s;
  if (/^-?[\d.]+,\d{1,2}$/.test(s)) return s;
  if (/^-?\d+\.\d{1,2}$/.test(s)) return s.replace('.', ',');
  if (/^-?\d+$/.test(s)) return s;
  return null;
}

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? '/app/workspaces';
const PROFILES_ROOT = process.env.PROFILES_ROOT ?? '/app/profiles';

/**
 * Aggregiert eCodes für Lane-1 aus drei Quellen:
 *   1. Polar canonical_layer (workspace/canonical-layer.json) — numerische Belegwerte
 *   2. Mandanten elsterExtract.values (workspace/meta/*.json) — Regex-Stammdaten
 *   3. Profil (profiles/<mandant>.json) — Mandantenakt-Stammdaten + §-Trigger
 *
 * Priorität: Profil > Mandanten > Polar.
 * Non-numerische Werte für Numerik-eCodes werden gedroppt und auditiert.
 */
export const bescheidAggregateStage = defineStage<BescheidAggregateInput, BescheidAggregateOutput>({
  id: 'bescheid-aggregate',
  name: 'Bescheid-Aggregate',
  description: 'eCode-Merge aus Polar + Mandanten + Profil mit Garbage-Filter',

  async run(input, _ctx) {
    const { mandant } = input;
    const ws = join(WORKSPACES_ROOT, mandant);

    // 1. Polar canonical_layer
    let polarEc: Record<string, string> = {};
    let polarSource: 'cache' | 'missing' = 'missing';
    try {
      const raw = await readFile(join(ws, 'canonical-layer.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      const cl = parsed.canonical_layer ?? {};
      for (const [ec, entry] of Object.entries<any>(cl)) {
        const vals = entry?.values ?? [];
        if (Array.isArray(vals) && vals.length > 0) {
          const v = vals[0];
          const val = typeof v === 'object' ? v.value : String(v);
          if (val) polarEc[ec] = String(val);
        }
      }
      polarSource = 'cache';
    } catch {
      // no canonical_layer cache — Polar muss extern gefahren werden
    }

    // 2. Mandanten meta
    const mandantenEc: Record<string, string> = {};
    try {
      const metaDir = join(ws, 'meta');
      const files = await readdir(metaDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(await readFile(join(metaDir, f), 'utf-8'));
          const values = d?.elsterExtract?.values ?? [];
          for (const v of values) {
            const ec = v?.elster_code ?? v?.ecode;
            const val = v?.value;
            if (ec && val && !mandantenEc[ec]) mandantenEc[ec] = String(val);
          }
        } catch { /* skip broken */ }
      }
    } catch {
      // kein meta-dir
    }

    // 3. Profil — Priorität: workspace/profile.json > profileMandant > mandant
    let profilEc: Record<string, string> = {};
    let profilePath: string | null = null;
    // Reject literal template strings (z.B. wenn input nicht-substituiert wurde)
    const cleanProfileMandant = input.profileMandant && !input.profileMandant.startsWith('${')
      ? input.profileMandant : null;
    const profileSlug = cleanProfileMandant || mandant;
    // 3a) Workspace-local override
    try {
      const wsLocal = join(ws, 'profile.json');
      const p = JSON.parse(await readFile(wsLocal, 'utf-8'));
      profilEc = p.ecodes ?? {};
      profilePath = wsLocal;
    } catch {
      // 3b) Globales profiles/<slug>.json
      try {
        const path = join(PROFILES_ROOT, `${profileSlug}.json`);
        const p = JSON.parse(await readFile(path, 'utf-8'));
        profilEc = p.ecodes ?? {};
        profilePath = path;
      } catch { /* kein Profil */ }
    }

    // 3b. Mandanten: zusätzlich classification.kpis (vom Upload-Path) als
    // grobe key-name Hints — wir mappen key→eCode via Substring-Match auf drucktext.
    // Quick-Win bis polarquant in mandanten verfügbar ist.
    try {
      const files = await readdir(join(ws, 'meta')).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const d = JSON.parse(await readFile(join(ws, 'meta', f), 'utf-8'));
        const kpis = d?.classification?.kpis ?? [];
        for (const kpi of kpis) {
          // Wenn der Key bereits wie ein eCode aussieht (z.B. "E0200201"): direkt nehmen
          const k = String(kpi?.key ?? '');
          const m = k.match(/^E\d{7}$/);
          if (m && !mandantenEc[k] && kpi?.value) {
            mandantenEc[k] = String(kpi.value);
          }
        }
      }
    } catch { /* skip */ }

    // Merge: Profil > Mandanten > Polar
    const merged: Record<string, string> = { ...polarEc, ...mandantenEc, ...profilEc };

    // Filter
    const elsterFelder: Record<string, string> = {};
    const dropped: Array<{ ecode: string; value: string }> = [];
    for (const [ec, v] of Object.entries(merged)) {
      const formatted = fmtValue(v, ec);
      if (formatted === null || formatted === '') {
        dropped.push({ ecode: ec, value: String(v).slice(0, 60) });
      } else {
        elsterFelder[ec] = formatted;
      }
    }

    return {
      elsterFelder,
      audit: {
        polar_n: Object.keys(polarEc).length,
        mandanten_n: Object.keys(mandantenEc).length,
        profil_n: Object.keys(profilEc).length,
        union_n: Object.keys(merged).length,
        dropped,
        polar_source: polarSource,
        profile_path: profilePath,
      },
    };
  },
});
