/**
 * Beleg-API — Datentyp-Inferenz + Wert-Coercion.
 *
 * Bestimmt den ELSTER-Datentyp einer Position und bringt den Rohwert in die
 * typgerechte Form (`wert`). Eigenständig gehalten (kleine lokale Parser statt
 * Import aus src/lib), damit die Beleg-API liftbar bleibt.
 *
 * Datentypen (Teilmenge der ELSTER-Welt):
 *   idnr | date | bool_jax | int_euro | int_nn_euro | decimal_eur_cent | enum | string
 */

export type Datentyp =
  | 'idnr'
  | 'date'
  | 'bool_jax'
  | 'int_euro'
  | 'int_nn_euro'
  | 'decimal_eur_cent'
  | 'enum'
  | 'string';

/** Parst einen (ggf. deutsch formatierten) String zu einer Zahl. */
export function zuZahl(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[€$£\s]/g, '').replace(/[A-Za-z]+$/, '');
  if (cleaned === '') return null;
  // Deutsch: Punkt = Tausender, Komma = Dezimal → wenn Komma nach letztem Punkt.
  if (cleaned.includes(',')) {
    const us = cleaned.replace(/\./g, '').replace(',', '.');
    const n = Number(us);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Wandelt "01.02.2024" / "1.2.2024" / "2024-02-01" → ISO "2024-02-01". */
export function zuIsoDatum(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const RE_DATUM = /^\d{1,2}\.\d{1,2}\.\d{4}$|^\d{4}-\d{2}-\d{2}/;
const RE_JANEIN = /^(ja|nein|j|n|x|true|false|wahr|falsch)$/i;
const RE_HAT_CENT = /[.,]\d{2}\b/;

/** Sieht der String wie eine 11-stellige IdNr aus? */
function istIdNr(s: string): boolean {
  const d = s.replace(/\s/g, '');
  return /^\d{11}$/.test(d);
}

/**
 * Leitet den Datentyp aus Bezeichnung + Rohwert ab. Pragmatische Heuristik
 * (v1) — bei vorhandenem Katalog-Datentyp gewinnt dieser im Resolver.
 */
export function inferDatentyp(bezeichnung: string, rohwert: unknown): Datentyp {
  const s = rohwert == null ? '' : String(rohwert).trim();
  const b = bezeichnung.toLowerCase();

  if (istIdNr(s) || /identifikationsnummer|idnr|steuer-?id/.test(b)) return 'idnr';
  if (RE_DATUM.test(s) || /datum|tag der|geboren|vom\b/.test(b)) return 'date';
  if (RE_JANEIN.test(s)) return 'bool_jax';

  const n = zuZahl(s);
  if (n !== null) {
    const hatCent = RE_HAT_CENT.test(s);
    if (hatCent) return 'decimal_eur_cent';
    // Ganzzahliger Betrag
    return n >= 0 ? 'int_nn_euro' : 'int_euro';
  }
  // Kurzer Code (z. B. Religionsschlüssel "02") → enum
  if (/^\d{1,3}$/.test(s) && /religion|schlüssel|kennung|code|art\b/.test(b)) return 'enum';
  return 'string';
}

export interface CoerceErgebnis {
  /** Typgerechter Wert: number | string | boolean | null. */
  wert: number | string | boolean | null;
  /** Enum-Code, falls datentyp==='enum'. */
  wert_code?: string;
}

/** Bringt den Rohwert in die typgerechte Form gemäß Datentyp. */
export function coerce(rohwert: unknown, datentyp: Datentyp): CoerceErgebnis {
  const s = rohwert == null ? '' : String(rohwert).trim();
  if (s === '') return { wert: null };

  switch (datentyp) {
    case 'int_euro':
    case 'int_nn_euro': {
      const n = zuZahl(s);
      return { wert: n === null ? null : Math.round(n) };
    }
    case 'decimal_eur_cent': {
      const n = zuZahl(s);
      return { wert: n === null ? null : n };
    }
    case 'date': {
      const iso = zuIsoDatum(s);
      return { wert: iso ?? s };
    }
    case 'bool_jax': {
      const t = s.toLowerCase();
      return { wert: /^(ja|j|x|true|wahr)$/.test(t) };
    }
    case 'idnr': {
      return { wert: s.replace(/\s/g, '') };
    }
    case 'enum': {
      return { wert: s, wert_code: s };
    }
    case 'string':
    default:
      return { wert: s };
  }
}
