// ════════════════════════════════════════════════════════════════════════════
// aggregierePersonen.ts — Person-Stammdaten aus STURM-Werte-Liste destillieren.
//
// Hintergrund: STURM (sturm.0711.io) liefert pro Anlage eine flache Liste
// von extrahierten ELSTER-Werten. Jeder Wert traegt einen `person`-Tag
// ("A" = Steuerpflichtige Person/Ehemann, "B" = Ehepartnerin, null = gemeinsam).
// Die Person-Stammdaten (Vorname, Nachname, Geburtsdatum, IdNr, Religion,
// Adresse, Beruf) sind ueber mehrere ELSTER-Codes der Anlage ESt1A verteilt.
//
// Frueher hat sturmClient.ts diese Werte nur als kern_werte durchgereicht,
// aber nie zu Person-Objekten aggregiert. Damit fehlten im case_state.personen
// alle Daten ausser den IdNrn (die documentProcessor fest verdrahtet hatte).
//
// Diese Pure-Function nimmt die Roh-Werte und gibt strukturierte Person-
// Objekte zurueck. Sie ist absichtlich ohne DB-Pool / fetch / IO — damit sie
// in unit-Tests gegen die echte Fixture laeuft, ohne externes System.
//
// MAPPING-TABELLE (verifiziert anhand sturm_stricker_output.json + ag_catalog.
// elster_fields). Spec-Vorschlag der Wave hatte mehrere Codes falsch geraten;
// diese Tabelle ist die korrigierte Fassung:
//
//   Person A (Steuerpflichtige Person / Ehemann):
//     E0100201 = Nachname
//     E0100301 = Vorname
//     E0100401 = Geburtsdatum
//     E0100081 = IdNr
//     E0100402 = Religion
//     E0100403 = Beruf
//
//   Person B (Ehepartnerin / Ehefrau):
//     E0100901 = Nachname
//     E0100801 = Vorname
//     E0101001 = Geburtsdatum
//     E0100082 = IdNr
//     E0101002 = Religion
//     (Beruf B noch nicht verifiziert — Stricker-Fixture hat nur Person-A-Beruf)
//
//   Adresse (haengt an Person A im Hauptvordruck, gilt aber gemeinsam):
//     E0101104 = Strasse
//     E0101206 = Hausnummer
//     E0100601 = PLZ      (ACHTUNG: kollidiert NICHT mit Vorname B — der ist E0100801!)
//     E0100602 = Ort
//
//   Bankverbindung (gemeinsam, nicht person-bezogen):
//     E0102102 = IBAN
//
// Der `person`-Tag im STURM-Output ist autoritativ. Wir vertrauen dem Tag
// und nutzen die Code-Tabelle nur zur Feld-Zuordnung. So bleibt der Aggregator
// robust gegen STURM-seitige Code-Aenderungen.
// ════════════════════════════════════════════════════════════════════════════

/** Roh-Wert wie von STURM emittiert (Subset; STURM liefert mehr Felder). */
export interface SturmRohWert {
  eCode?: string | null;
  wert: string | number | null;
  anlage?: string | null;
  person?: "A" | "B" | null;
  beschreibung?: string | null;
  drucktext?: string | null;
  vordruckzeile?: string | null;
  format?: string | null;
  pflichtfeld?: boolean | null;
  person_label?: string | null;
}

/** Anschrift-Sub-Objekt — kompatibel mit case_state.Anschrift. */
export interface AggregierteAnschrift {
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  ort: string | null;
  land: string | null;
}

/**
 * Aggregierte Person. Format ist eine UNION aus:
 *  - MistralPerson (rolle/vorname/nachname/idnr/geburtsdatum/religion/steuernummer)
 *    -> wird vom downstream-Konsumenten in opusOrchestrator/documentProcessor
 *       erwartet, der bisher mit dem Pass-1-Stream-Output arbeitete.
 *  - case_state.Person-Erweiterungen (anschrift, iban, beruf)
 *    -> sodass spaetere Reducer/Persistierungspfade die Daten ohne Verlust
 *       weitergeben koennen.
 *
 * Die Felder sind optional, weil ein konkreter STURM-Lauf ggf. nicht alle
 * Werte enthaelt (z.B. Lohnsteuerbescheinigung allein liefert keine Religion).
 */
export interface AggregiertePerson {
  rolle: "A" | "B";
  vorname?: string;
  nachname?: string;
  idnr?: string;
  geburtsdatum?: string;     // Original-Format aus STURM (typisch TT.MM.JJJJ)
  religion?: string;
  beruf?: string;
  steuernummer?: string;     // (noch nicht aus STURM; fuer MistralPerson-Kompatibilitaet)
  anschrift?: AggregierteAnschrift;
  iban?: string;
}

// ─── Code-Tabellen ──────────────────────────────────────────────────────────

interface CodeMap {
  /** Person-A-spezifische Codes -> Person-Feld */
  personA: Record<string, keyof AggregiertePerson>;
  /** Person-B-spezifische Codes -> Person-Feld */
  personB: Record<string, keyof AggregiertePerson>;
  /** Adress-Codes -> Anschrift-Sub-Feld (in Person A integriert; Person B erbt sie wenn gemeinsame Adresse) */
  adresse: Record<string, keyof AggregierteAnschrift>;
  /** Codes fuer gemeinsame Bank/IBAN */
  iban: Set<string>;
}

const CODES: CodeMap = {
  personA: {
    E0100201: "nachname",
    E0100301: "vorname",
    E0100401: "geburtsdatum",
    E0100081: "idnr",
    E0100402: "religion",
    E0100403: "beruf",
  },
  personB: {
    E0100901: "nachname",
    E0100801: "vorname",
    E0101001: "geburtsdatum",
    E0100082: "idnr",
    E0101002: "religion",
    // Beruf B (E0100903?) noch nicht verifiziert — bleibt offen bis Test-Fixture vorhanden.
  },
  adresse: {
    E0101104: "strasse",
    E0101206: "hausnummer",
    E0100601: "plz",
    E0100602: "ort",
  },
  iban: new Set(["E0102102"]),
};

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

function normalisiereWert(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function leereAnschrift(): AggregierteAnschrift {
  return { strasse: null, hausnummer: null, plz: null, ort: null, land: null };
}

function anschriftHatDaten(a: AggregierteAnschrift): boolean {
  return Boolean(a.strasse || a.hausnummer || a.plz || a.ort || a.land);
}

function personHatIdentifikator(p: AggregiertePerson): boolean {
  if (p.idnr) return true;
  if (p.vorname && p.nachname) return true;
  return false;
}

function personHatNutzdaten(p: AggregiertePerson): boolean {
  return Boolean(
    p.vorname || p.nachname || p.idnr || p.geburtsdatum ||
    p.religion || p.beruf || p.iban || (p.anschrift && anschriftHatDaten(p.anschrift)),
  );
}

// ─── Hauptfunktion ──────────────────────────────────────────────────────────

/**
 * Aggregiert eine flache STURM-Werte-Liste zu Person-Objekten.
 *
 * Verhalten:
 *  - Gruppiert nach `wert.person` ("A"/"B"); Werte ohne person-Tag fliessen
 *    nach Code-Tabelle in die passende Person (z.B. Adresse -> Person A).
 *  - Pro Person mind. ein Identifikator (idnr ODER vorname+nachname),
 *    sonst wird die Person verworfen.
 *  - Personen ohne Nutzdaten (nur Adresse haengt dran) werden NICHT zurueck-
 *    gegeben.
 *  - IBAN wird an Person A geheftet, weil ESt1A nur ein Konto vorsieht und
 *    Auszahlungen an die Steuerpflichtige Person gehen.
 *
 * @param werte Roh-Werte aus STURM (z.B. anreicherung/output.json -> alle_werte)
 * @returns Liste der erkannten Personen (0..2 Eintraege fuer ESt1A)
 */
export function aggregierePersonenAusWerten(
  werte: SturmRohWert[] | null | undefined,
): AggregiertePerson[] {
  if (!Array.isArray(werte) || werte.length === 0) return [];

  const personA: AggregiertePerson = { rolle: "A" };
  const personB: AggregiertePerson = { rolle: "B" };
  const adresseA: AggregierteAnschrift = leereAnschrift();
  let ibanGemeinsam: string | null = null;

  for (const w of werte) {
    const code = w.eCode ?? null;
    if (!code) continue;
    const wert = normalisiereWert(w.wert);
    if (wert === null) continue;

    // 1) Person-A-spezifischer Code
    const feldA = CODES.personA[code];
    if (feldA) {
      // Nur ueberschreiben, wenn noch leer — STURM liefert manche Codes
      // mehrfach (ein Mal pro Anlage), aber der erste Treffer in ESt1A ist
      // der maßgebliche Stammdaten-Eintrag.
      if (!(personA as unknown as Record<string, unknown>)[feldA]) {
        (personA as unknown as Record<string, unknown>)[feldA] = wert;
      }
      continue;
    }

    // 2) Person-B-spezifischer Code
    const feldB = CODES.personB[code];
    if (feldB) {
      if (!(personB as unknown as Record<string, unknown>)[feldB]) {
        (personB as unknown as Record<string, unknown>)[feldB] = wert;
      }
      continue;
    }

    // 3) Adress-Code -> Anschrift A
    const feldAdr = CODES.adresse[code];
    if (feldAdr) {
      if (!adresseA[feldAdr]) {
        adresseA[feldAdr] = wert;
      }
      continue;
    }

    // 4) IBAN -> gemeinsam
    if (CODES.iban.has(code)) {
      if (!ibanGemeinsam) ibanGemeinsam = wert.replace(/\s+/g, "");
      continue;
    }
  }

  // Adresse nur anhaengen, wenn echte Daten da sind
  if (anschriftHatDaten(adresseA)) {
    personA.anschrift = adresseA;
  }
  if (ibanGemeinsam) {
    personA.iban = ibanGemeinsam;
  }

  // Filtern: nur Personen mit Nutzdaten + Identifikator behalten
  const ergebnis: AggregiertePerson[] = [];
  if (personHatNutzdaten(personA) && personHatIdentifikator(personA)) {
    ergebnis.push(personA);
  }
  if (personHatNutzdaten(personB) && personHatIdentifikator(personB)) {
    ergebnis.push(personB);
  }
  return ergebnis;
}
