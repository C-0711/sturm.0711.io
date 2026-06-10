/**
 * authoritative — MCP-autoritative Steuerberechnung mit In-Process-Vorschau.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  „Es muss für JEDEN Steuerfall funktionieren." → die verbindliche Zahl
 *  kommt IMMER aus der BMF-MCP (ctaxv1-lane1-bmf, :12010): sie akzeptiert
 *  beliebige E-Code-Sätze und rechnet den vollständigen Tarif-/Abzugs-
 *  apparat (jeder Fall, BMF-konform, stored procedures). Der In-Process-
 *  Rechenkern (engine.ts) liefert NUR die Sofort-Vorschau (<1 ms) und einen
 *  Konformitäts-Abgleich — er ist niemals die bindende Quelle, außer als
 *  ausdrücklich markierter Fallback, wenn die MCP nicht erreichbar ist.
 *
 *  Reihenfolge:
 *    1. Felder → elster_felder (Dedup je E-Code, Konflikte werden GELOGGT).
 *    2. In-Process-Vorschau (immer, schnell).
 *    3. MCP-Aufruf (verbindlich). Erfolg → quelle='mcp'; Fehler → Fallback
 *       auf Vorschau mit quelle='in-process-fallback' + mcpFehler.
 *    4. Erstattung/Nachzahlung = bindende Festsetzung − angerechnete Abzüge.
 * ════════════════════════════════════════════════════════════════════════
 */
import { BmfMcpClient, type BmfSteuerErgebnis } from '../../../../lib/bmf-mcp-client.ts';
import { bausteineAusFelder, parseEuro, type SteuerFeld } from './adapter.ts';
import { berechneSteuerfall, type SteuerbescheidErgebnis } from './engine.ts';
import { einkommensteuer, kirchensteuer, solidaritaetszuschlag, type Veranlagungsart } from './tarif.ts';
import type { NormalisierterFall } from './fallnormalizer.ts';

export interface SteuerfallAuthInput {
  /** Gemappte E-Code-Felder EINES Steuerpflichtigen (bzw. einer
   *  Ehegatten-Zusammenveranlagung). Gemischte Steuerpflichtige müssen
   *  vorher getrennt werden — siehe steuerfall-demo.ts. */
  felder: SteuerFeld[];
  vz: number;
  art?: Veranlagungsart;
  /** Kirchensteuer-Hebesatz (0 | 0.08 | 0.09). */
  kirchensteuerHebesatz?: number;
  /** Injizierbarer MCP-Client (Default: neue Instanz auf :12010). */
  mcp?: BmfMcpClient;
  /** MCP-Timeout; bei Überschreitung greift der Fallback. Default 4000 ms. */
  mcpTimeoutMs?: number;
}

export interface BindendeFestsetzung {
  zve: number;
  einkommensteuer: number;
  solidaritaetszuschlag: number;
  /** In-Process aus Festsetzungs-ESt × Hebesatz abgeleitet (§51a). */
  kirchensteuer: number;
  /** ESt + Soli + KiSt. */
  gesamtsteuer: number;
  grenzsteuersatz?: number;
  durchschnittssteuersatz?: number;
}

export interface Abgleich {
  zveDelta: number;
  estDelta: number;
  gesamtDelta: number;
  /** true wenn In-Process und MCP innerhalb der Toleranz übereinstimmen. */
  konform: boolean;
}

export interface SteuerfallAuthResult {
  vz: number;
  /** Welche Quelle ist verbindlich. `mcp-splitting`: zvE autoritativ aus der
   *  MCP, Tarif als §32a-Splitting (Abs. 5) im sturm-Kern (konformitätsgeprüft
   *  deckungsgleich), weil die MCP-v2 selbst keinen Splittingtarif rechnet. */
  quelle: 'mcp' | 'in-process-fallback' | 'mcp-splitting';
  bindend: BindendeFestsetzung;
  /** Summe der angerechneten Abzugsteuern (LSt, Soli, KiSt, KapESt). */
  angerechnet: number;
  /** > 0 = Erstattung, < 0 = Nachzahlung. */
  erstattung: number;
  /** Roh-Antwort der MCP (wenn erreichbar). */
  mcp: BmfSteuerErgebnis['daten'] | null;
  mcpFehler?: string;
  /** In-Process-Sofortvorschau (immer vorhanden). */
  vorschau: SteuerbescheidErgebnis;
  /** Abgleich Vorschau↔MCP (nur wenn quelle='mcp'). */
  abgleich?: Abgleich;
  /** Dedup-Konflikte (transparent für HiTL). */
  konflikte: string[];
  latenzMs: { vorschau: number; mcp: number | null };
}

/** Toleranz für den Konformitäts-Abgleich: ≤ 1 € (statutarische
 *  Euro-Abrundung, siehe engine.test.ts). */
const KONFORM_TOLERANZ_EUR = 1;

/** Felder → `elster_felder` (ein Wert je E-Code). Bei Mehrfachwerten:
 *  größter Betrag bei rein numerischen Duplikaten, sonst erster; alle
 *  Konflikte werden zurückgegeben. */
/** Extraktions-E-Codes → MCP-module_mappings-Vokabular — NUR noch für die Fälle,
 *  die die DB-SSOT (lane1_bmf_calculator.module_mappings.elster_code_quelle)
 *  nicht selbst auflöst. E1800301 (→rente_brutto) und E2000601 (→rv_beitraege)
 *  sind dort inzwischen direkt als Quell-Codes registriert, daher wurde ihre
 *  Hand-Übersetzung entfernt (die MCP kanonisiert die Rohcodes selbst). Es
 *  bleiben: die Renten-Brutto-Variante E1803102 sowie der Rentenbeginn
 *  (E1800501/E1803202), der zusätzlich eine Wert-Coercion Datum→Jahr braucht
 *  (siehe emit() / RENTENBEGINN_MCP) — das kann die reine Code-SSOT nicht. */
const EXTRACTION_TO_MCP: Record<string, string> = {
  E1803102: 'E2400203',                          // gesetzliche Rente (Brutto, Variante)
  E1800501: 'E2400107', E1803202: 'E2400207',   // Rentenbeginn (Datum → Jahr)
};
const RENTENBEGINN_MCP = new Set(['E2400107', 'E2400207']);

export function feldateToElsterFelder(
  felder: SteuerFeld[],
): { elsterFelder: Record<string, string>; konflikte: string[] } {
  const byCode = new Map<string, string[]>();
  for (const f of felder) {
    const w = (f.wert ?? '').trim();
    if (!w) continue;
    const arr = byCode.get(f.eCode);
    if (arr) arr.push(w);
    else byCode.set(f.eCode, [w]);
  }
  const elsterFelder: Record<string, string> = {};
  const konflikte: string[] = [];
  const emit = (code: string, val: string) => {
    const mcp = EXTRACTION_TO_MCP[code] ?? code;
    let out = val;
    if (RENTENBEGINN_MCP.has(mcp)) {
      const yr = (val.match(/(?:19|20)\d{2}/) ?? [])[0];
      if (yr) out = yr;          // MCP renteneintritt_jahr erwartet das Jahr
    }
    elsterFelder[mcp] = out;
  };
  for (const [code, vals] of byCode) {
    // Interne Anrechnungs-Codes (Vorauszahlungen) sind KEINE ELSTER-Deklarations-
    // felder → nie an den BMF-MCP senden (sie betreffen nur die Anrechnung).
    if (code.startsWith('VZ_')) continue;
    if (vals.length === 1) { emit(code, vals[0]); continue; }
    const parsed = vals.map((v) => ({ v, n: parseEuro(v) }));
    const allNum = parsed.every((p) => p.n !== null);
    if (allNum) {
      const best = parsed.reduce((a, b) => (Math.abs(b.n!) > Math.abs(a.n!) ? b : a));
      emit(code, best.v);
      konflikte.push(`${code}: ${vals.length} Werte ${JSON.stringify(vals)} → größter (${best.v})`);
    } else {
      emit(code, vals[0]);
      konflikte.push(`${code}: ${vals.length} Werte ${JSON.stringify(vals)} → erster (${vals[0]})`);
    }
  }
  return { elsterFelder, konflikte };
}

/**
 * Verbindliche Steuerberechnung für einen Fall — MCP-autoritativ, mit
 * In-Process-Vorschau und Fallback.
 */
export async function berechneSteuerfallAuthoritativ(
  input: SteuerfallAuthInput,
): Promise<SteuerfallAuthResult> {
  const hebesatz = input.kirchensteuerHebesatz ?? 0;

  // 1. In-Process-Vorschau (immer, schnell).
  const tV0 = process.hrtime.bigint();
  const { eingabe, anrechnung, haushaltsnahe35aBasis } = bausteineAusFelder(input.felder, {
    vz: input.vz, art: input.art, kirchensteuerHebesatz: hebesatz,
  });
  const vorschau = berechneSteuerfall({ ...eingabe, anrechnung, kirchensteuerHebesatz: hebesatz, haushaltsnahe35aBasis });
  const tV1 = process.hrtime.bigint();
  const vorschauMs = Number(tV1 - tV0) / 1e6;

  const angerechnet = vorschau.angerechnet;
  const { elsterFelder, konflikte } = feldateToElsterFelder(input.felder);

  // 2. MCP-Aufruf (verbindlich).
  const client = input.mcp ?? new BmfMcpClient({ timeoutMs: input.mcpTimeoutMs ?? 4000 });
  let mcpDaten: BmfSteuerErgebnis['daten'] | null = null;
  let mcpFehler: string | undefined;
  let mcpMs: number | null = null;
  try {
    const tM0 = process.hrtime.bigint();
    const res = await client.berechneVollstaendigeSteuerV2({
      erklaerungsjahr: input.vz,
      elster_felder: elsterFelder,
    });
    mcpMs = Number(process.hrtime.bigint() - tM0) / 1e6;
    if (!res.erfolg) throw new Error(`MCP erfolg=false (${JSON.stringify(res.fehler ?? {}).slice(0, 120)})`);
    mcpDaten = res.daten;
  } catch (e) {
    mcpFehler = (e as Error).message;
  }

  // 3. Bindende Festsetzung zusammensetzen.
  if (mcpDaten) {
    const est = mcpDaten.einkommensteuer;
    const soli = mcpDaten.solidaritaetszuschlag;
    const kist = kirchensteuer(est, hebesatz);
    const gesamt = round2(est + soli + kist);
    const bindend: BindendeFestsetzung = {
      zve: mcpDaten.zve,
      einkommensteuer: est,
      solidaritaetszuschlag: soli,
      kirchensteuer: kist,
      gesamtsteuer: gesamt,
      grenzsteuersatz: mcpDaten.grenzsteuersatz,
      durchschnittssteuersatz: mcpDaten.durchschnittssteuersatz,
    };
    const abgleich: Abgleich = {
      zveDelta: round2(vorschau.einkommen.zvE - mcpDaten.zve),
      estDelta: round2(vorschau.steuer.einkommensteuer - est),
      gesamtDelta: round2(vorschau.steuer.gesamtsteuer - gesamt),
      konform: Math.abs(vorschau.steuer.einkommensteuer - est) <= KONFORM_TOLERANZ_EUR,
    };
    return {
      vz: input.vz, quelle: 'mcp', bindend, angerechnet,
      erstattung: round2(angerechnet - gesamt),
      mcp: mcpDaten, vorschau, abgleich, konflikte,
      latenzMs: { vorschau: vorschauMs, mcp: mcpMs },
    };
  }

  // 4. Fallback: In-Process ist (ausdrücklich markiert) bindend.
  return {
    vz: input.vz, quelle: 'in-process-fallback',
    bindend: {
      zve: vorschau.einkommen.zvE,
      einkommensteuer: vorschau.steuer.einkommensteuer,
      solidaritaetszuschlag: vorschau.steuer.solidaritaetszuschlag,
      kirchensteuer: vorschau.steuer.kirchensteuer,
      gesamtsteuer: vorschau.steuer.gesamtsteuer,
      grenzsteuersatz: vorschau.steuer.grenzsteuersatz,
      durchschnittssteuersatz: vorschau.steuer.durchschnittssteuersatz,
    },
    angerechnet, erstattung: vorschau.erstattung,
    mcp: null, mcpFehler, vorschau, konflikte,
    latenzMs: { vorschau: vorschauMs, mcp: mcpMs },
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Kombiniertes `elster_felder` für die Zusammenveranlagung: Person-A-Codes
 *  unverändert, Person-B-Codes mit `__B`-Suffix (MCP-Konvention für den
 *  zweiten Ehegatten). */
function elsterFelderZusammen(
  felderA: SteuerFeld[],
  felderB: SteuerFeld[],
): { elsterFelder: Record<string, string>; konflikte: string[] } {
  const a = feldateToElsterFelder(felderA);
  const b = feldateToElsterFelder(felderB);
  const elsterFelder: Record<string, string> = { ...a.elsterFelder };
  for (const [k, v] of Object.entries(b.elsterFelder)) elsterFelder[`${k}__B`] = v;
  // Verheiratet-Kennzeichen (E0101201) — der DURABLE married-Pfad der MCP
  // (baue_canonical_params → canonical "verheiratet", überlebt Container-
  // recreate). Damit splittet die MCP nativ UND setzt den §10c-SA-Pauschbetrag
  // auf 72 € (Zusammenveranlagung) statt 36 €. Unabhängig vom StKl-married-
  // Patch; sturm rechnet den Splittingtarif ohnehin selbst (Doppelabsicherung).
  elsterFelder.E0101201 = 'X';
  return { elsterFelder, konflikte: [...a.konflikte, ...b.konflikte.map((c) => `B: ${c}`)] };
}

/**
 * Zusammenveranlagung (§26b EStG) — EIN Bescheid für das Ehepaar.
 *
 * zvE kommt autoritativ aus der MCP (kombinierter Call A + B`__B`). Den
 * SPLITTINGTARIF rechnet die MCP-v2 NICHT (sie wendet immer den Grundtarif
 * auf das zvE an) — deshalb wird die tarifliche ESt hier nach §32a Abs. 5 als
 * `2 × Grundtarif(zvE/2)` über den konformitätsgeprüften sturm-Kern gebildet
 * (dessen Grundtarif deckungsgleich mit der MCP ist). Soli/KiSt folgen auf die
 * Splitting-ESt; angerechnet = Summe der Abzugsteuern BEIDER Ehegatten.
 */
export async function berechneZusammenveranlagung(
  felderA: SteuerFeld[],
  felderB: SteuerFeld[],
  opts: { vz: number; kirchensteuerHebesatz?: number; kistAnteil?: number; mcp?: BmfMcpClient; mcpTimeoutMs?: number },
): Promise<SteuerfallAuthResult> {
  const hebesatz = opts.kirchensteuerHebesatz ?? 0;
  const vz = opts.vz;

  // In-Process-Vorschau auf dem kombinierten Fall (Splittingtarif + Abzugsteuer-Summe).
  const tV0 = process.hrtime.bigint();
  const alle = [...felderA, ...felderB.map((f) => ({ ...f, person: 'A' as const }))];
  const { eingabe, anrechnung } = bausteineAusFelder(alle, { vz, art: 'zusammen', kirchensteuerHebesatz: hebesatz });
  const vorschau = berechneSteuerfall({ ...eingabe, anrechnung, kirchensteuerHebesatz: hebesatz });
  const vorschauMs = Number(process.hrtime.bigint() - tV0) / 1e6;
  const angerechnet = vorschau.angerechnet;

  const { elsterFelder, konflikte } = elsterFelderZusammen(felderA, felderB);

  // MCP-Call → autoritatives gemeinsames zvE.
  const client = opts.mcp ?? new BmfMcpClient({ timeoutMs: opts.mcpTimeoutMs ?? 4000 });
  let mcpDaten: BmfSteuerErgebnis['daten'] | null = null;
  let mcpFehler: string | undefined;
  let mcpMs: number | null = null;
  try {
    const tM0 = process.hrtime.bigint();
    const res = await client.berechneVollstaendigeSteuerV2({ erklaerungsjahr: vz, elster_felder: elsterFelder });
    mcpMs = Number(process.hrtime.bigint() - tM0) / 1e6;
    if (!res.erfolg) throw new Error(`MCP erfolg=false (${JSON.stringify(res.fehler ?? {}).slice(0, 120)})`);
    mcpDaten = res.daten;
  } catch (e) {
    mcpFehler = (e as Error).message;
  }

  // zvE autoritativ (MCP) oder Fallback (In-Process-Vorschau).
  const zve = mcpDaten ? mcpDaten.zve : vorschau.einkommen.zvE;
  const est = round2(einkommensteuer(zve, vz, 'zusammen'));
  const soli = round2(solidaritaetszuschlag(est, vz, 'zusammen'));
  // KiSt-Halbteilung bei glaubensverschiedener Ehe: kistAnteil ∈ {0, 0.5, 1}.
  const kist = round2(kirchensteuer(est, hebesatz) * (opts.kistAnteil ?? 1));
  const gesamt = round2(est + soli + kist);

  const bindend: BindendeFestsetzung = {
    zve,
    einkommensteuer: est,
    solidaritaetszuschlag: soli,
    kirchensteuer: kist,
    gesamtsteuer: gesamt,
    grenzsteuersatz: vorschau.steuer.grenzsteuersatz,
    durchschnittssteuersatz: zve > 0 ? round2(est / zve) : 0,
  };
  const abgleich: Abgleich | undefined = mcpDaten
    ? {
        zveDelta: round2(vorschau.einkommen.zvE - zve),
        estDelta: round2(vorschau.steuer.einkommensteuer - est),
        gesamtDelta: round2(vorschau.steuer.gesamtsteuer - gesamt),
        konform: Math.abs(vorschau.einkommen.zvE - zve) <= KONFORM_TOLERANZ_EUR,
      }
    : undefined;

  return {
    vz,
    quelle: mcpDaten ? 'mcp-splitting' : 'in-process-fallback',
    bindend,
    angerechnet,
    erstattung: round2(angerechnet - gesamt),
    mcp: mcpDaten,
    mcpFehler,
    vorschau,
    abgleich,
    konflikte,
    latenzMs: { vorschau: vorschauMs, mcp: mcpMs },
  };
}

export interface HaushaltBescheid {
  /** Wen deckt dieser Bescheid ab: einzelne Person oder das gemeinsam
   *  veranlagte Ehepaar (`A+B`). */
  einheit: 'A' | 'B' | 'A+B';
  felder: number;
  res: SteuerfallAuthResult;
}

export interface HaushaltErgebnis {
  veranlagungsart: Veranlagungsart;
  /** Warum diese Veranlagungsart gewählt wurde (vom Fallnormalizer). */
  begruendung: string[];
  warnungen: string[];
  bescheide: HaushaltBescheid[];
}

/**
 * Verbindliche Berechnung für einen NORMALISIERTEN Haushalt: Einzelveranlagung
 * → ein Bescheid je Person (Grundtarif); Zusammenveranlagung → EIN gemeinsamer
 * Bescheid (Splittingtarif). Verbraucht die Ausgabe von `normalisiereSteuerfall`.
 */
export async function berechneHaushaltAuthoritativ(
  fall: NormalisierterFall,
  opts: { vz: number; kirchensteuerHebesatz?: number; mcp?: BmfMcpClient; mcpTimeoutMs?: number },
): Promise<HaushaltErgebnis> {
  const base = {
    vz: opts.vz,
    kirchensteuerHebesatz: opts.kirchensteuerHebesatz,
    mcp: opts.mcp,
    mcpTimeoutMs: opts.mcpTimeoutMs,
  };
  const bescheide: HaushaltBescheid[] = [];

  if (fall.veranlagungsart === 'zusammen') {
    const a = fall.personen.find((p) => p.rolle === 'A')?.felder ?? [];
    const b = fall.personen.find((p) => p.rolle === 'B')?.felder ?? [];
    const res = await berechneZusammenveranlagung(a, b, { ...base, kistAnteil: fall.kistAnteil });
    bescheide.push({ einheit: 'A+B', felder: a.length + b.length, res });
  } else {
    for (const p of fall.personen) {
      const felder = p.felder.map((f) => ({ ...f, person: 'A' as const }));
      const res = await berechneSteuerfallAuthoritativ({ felder, ...base });
      bescheide.push({ einheit: p.rolle, felder: felder.length, res });
    }
  }

  return {
    veranlagungsart: fall.veranlagungsart,
    begruendung: fall.begruendung,
    warnungen: fall.warnungen,
    bescheide,
  };
}
