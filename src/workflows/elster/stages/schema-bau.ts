import { createHash } from 'node:crypto';
import { defineStage } from '../../../core/stage.ts';
import {
  getIndices,
  pruneSchemaAufBelegt,
  entferneGrosseEnums,
  sammlePflichtfelder,
  sammleCodesAusSchema,
  type JsonSchemaNode,
} from '../lib/helpers.ts';

// ─── Typen ────────────────────────────────────────────────────────────────

export interface SchemaBauFinalCode {
  code: string;
  anlage: string;
  wert: unknown;
  quelle: string;
  /** Optionaler Personen-Kontext — nötig für Multi-Person-Array-Wrapper. */
  personen_ctx?: 'A' | 'B' | null;
}

export interface SchemaBauInput {
  /** Eindeutige Codes aus der Regel-Engine (anlage + code + wert + quelle). */
  finalCodes: SchemaBauFinalCode[];
  /** Optional: Codes die Opus-Kurator bereits als belegt markiert hat. */
  kuratorBelegtSet?: string[];
}

export interface SchemaBauMeta {
  basis_codes: number;
  kurator_codes: number;
  gesamt_codes: number;
  anlagen_betroffen: string[];
  gepruned_auf_bytes: number;
  leaf_count?: number;
  elster_code_count?: number;
  personen_pro_anlage?: Record<string, string[]>;
}

export interface SchemaBauOutput {
  basisSchema: Record<string, unknown>;
  schemaMeta: SchemaBauMeta;
  schemaHash: string;
}

// ─── Lokaler Helper (Port von server.mjs:1923-1975) ──────────────────────
// baueKuratiertesSchema: minimal-invasive Variante fuer den Fall, dass nur der
// Opus-Kurator das Schema treibt (nicht die Regel-Engine). Wird vom aktuellen
// Schema-Bau-Pfad nicht benoetigt — die Pipeline nutzt pruneSchemaAufBelegt
// direkt mit belegtProAnlage. Bleibt als Utility-Funktion fuer spaetere Stages
// oder alternative Flows erhalten. Verwendet NUR exportierte Helpers.
export function baueKuratiertesSchema(kurator: {
  anlagen?: string[];
  belegte_codes?: Array<{ code: string; anlage: string }>;
}): JsonSchemaNode {
  const { elsterCatalog } = getIndices();
  if (!elsterCatalog) throw new Error('ELSTER-Katalog nicht geladen');

  const anlagen = kurator.anlagen ?? [];
  const belegtProAnlage = new Map<string, Set<string>>();
  for (const b of kurator.belegte_codes ?? []) {
    if (!belegtProAnlage.has(b.anlage)) belegtProAnlage.set(b.anlage, new Set());
    belegtProAnlage.get(b.anlage)!.add(b.code);
  }

  if (anlagen.length === 1) {
    const a = elsterCatalog.anlagen[anlagen[0]];
    if (!a) throw new Error(`Anlage ${anlagen[0]} nicht im Katalog`);
    const belegt = belegtProAnlage.get(anlagen[0]) ?? new Set<string>();
    return pruneSchemaAufBelegt(a.json_schema, belegt) ?? a.json_schema;
  }

  const props: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const code of anlagen) {
    const a = elsterCatalog.anlagen[code];
    if (!a) continue;
    const belegt = belegtProAnlage.get(code) ?? new Set<string>();
    const pruned = pruneSchemaAufBelegt(a.json_schema, belegt);
    if (pruned) {
      props[code] = pruned;
      required.push(code);
    }
  }
  return {
    type: 'object',
    title: `ELSTER_kuratiert_${anlagen.join('_')}`,
    description: 'Von Opus kuratiert aus Mistral+Vision — nur belegte Felder',
    properties: props,
    required,
    additionalProperties: false,
  };
}

// ─── Stage ────────────────────────────────────────────────────────────────

/**
 * Baut das tight JSON-Schema fuer den zweiten Mistral-Kuratoren-Lauf.
 * Port aus legacy/elster-mvp/server.mjs:2626-2696.
 *
 * Strategie:
 *  - Sammle belegte Codes pro Anlage (Regel-Engine + optional Opus-Kurator).
 *  - Prune den Katalog-Schema-Teilbaum auf nur die belegten Codes.
 *  - Wenn eine max_occurs>1-Anlage Daten zu mehreren Personen hat → Array-Wrapper
 *    mit Person-Marker-Property, sonst ueberschreibt Person B Person A.
 *  - Grosse Enums (>8 Werte) werden entfernt → Klartext statt Default-Raten.
 *  - SHA-256 Hash ueber das Schema als Cache-Key.
 */
export const schemaBauStage = defineStage<SchemaBauInput, SchemaBauOutput>({
  id: 'elster-schema-bau',
  name: 'Schema-Bau',
  description: 'Baut tight JSON-Schema aus belegten ELSTER-Codes',

  async run(input, ctx) {
    const { elsterCatalog } = getIndices();
    if (!elsterCatalog) throw new Error('ELSTER-Katalog nicht geladen');

    const finalCodes = input?.finalCodes ?? [];
    const kuratorCodes = new Set(input?.kuratorBelegtSet ?? []);

    if (!finalCodes.length && !kuratorCodes.size) {
      throw new Error('Schema-Bau: keine belegten Codes');
    }

    // Sammle belegte Codes + Personen pro Anlage.
    const belegtProAnlage = new Map<string, Set<string>>();
    const personenProAnlage = new Map<string, Set<'A' | 'B'>>();

    for (const c of finalCodes) {
      if (!c?.code || !c?.anlage) continue;
      if (!belegtProAnlage.has(c.anlage)) belegtProAnlage.set(c.anlage, new Set());
      belegtProAnlage.get(c.anlage)!.add(c.code);
      if (!personenProAnlage.has(c.anlage)) personenProAnlage.set(c.anlage, new Set());
      if (c.personen_ctx === 'A' || c.personen_ctx === 'B') {
        personenProAnlage.get(c.anlage)!.add(c.personen_ctx);
      }
    }

    // Opus-Kurator-Codes in die jeweilige Anlage einpflegen (falls vorhanden).
    // Ohne Anlage-Info legen wir sie zur jeweils ersten existierenden Anlage des
    // Codes im Katalog — nur wenn noch nicht anders belegt.
    if (kuratorCodes.size) {
      const { codeIndex } = getIndices();
      for (const code of kuratorCodes) {
        const anlagenFuerCode = codeIndex?.get(code);
        if (!anlagenFuerCode) continue;
        for (const a of anlagenFuerCode) {
          if (!belegtProAnlage.has(a)) belegtProAnlage.set(a, new Set());
          belegtProAnlage.get(a)!.add(code);
        }
      }
    }

    const anlagenFinal = [...belegtProAnlage.keys()].filter(a => elsterCatalog.anlagen[a]);
    if (!anlagenFinal.length) {
      throw new Error('Schema-Bau: keine kuratierbaren Anlagen im Katalog');
    }

    // Pro Anlage: Schema prunen, ggf. Array-Wrapper fuer Multi-Person.
    const props: Record<string, JsonSchemaNode> = {};
    const required: string[] = [];

    for (const a of anlagenFinal) {
      const catAnl = elsterCatalog.anlagen[a];
      const pruned = pruneSchemaAufBelegt(catAnl.json_schema, belegtProAnlage.get(a)!);
      if (!pruned) continue;

      const maxOcc = catAnl.max_occurs ?? 1;
      const personen = personenProAnlage.get(a) ?? new Set<'A' | 'B'>();

      if (maxOcc > 1 && personen.size > 1) {
        // Array-Wrapper: eine Instanz pro Person. Person-Property wird
        // zurueckgefuegt (Prune hat sie als Nicht-E-Code entfernt), damit Mistral
        // pro Instanz explizit PersonA/PersonB setzen MUSS.
        const personenValues = [...personen].map(c => (c === 'A' ? 'PersonA' : 'PersonB'));
        const itemMitPerson: JsonSchemaNode = {
          ...pruned,
          properties: {
            Person: { type: 'string', enum: personenValues, description: 'Person-Instanz-Marker' },
            ...(pruned.properties ?? {}),
          },
          required: ['Person', ...(pruned.required ?? [])],
        };
        props[a] = {
          type: 'array',
          minItems: personen.size,
          maxItems: Math.max(maxOcc, personen.size),
          items: itemMitPerson,
          description: (pruned.description || `Anlage ${a}`) + ` — ${personen.size} Instanzen`,
        };
      } else {
        props[a] = pruned;
      }
      required.push(a);
    }

    // Schema zusammenbauen — bei genau einer Anlage den Teilbaum direkt zurueckgeben.
    let basisSchema: JsonSchemaNode;
    if (anlagenFinal.length === 1) {
      basisSchema = props[anlagenFinal[0]];
    } else {
      basisSchema = {
        type: 'object',
        title: `ELSTER_V2_${anlagenFinal.join('_')}`,
        description: `V2-Hybrid kuratiert: ${finalCodes.length} Codes aus ${anlagenFinal.length} Anlagen`,
        properties: props,
        required,
        additionalProperties: false,
      };
    }

    // Grosse Enums entschaerfen → Mistral liefert Klartext statt Default.
    const schemaEntschaerft = entferneGrosseEnums(basisSchema, 8) ?? basisSchema;

    // SHA-256 Hash ueber das entschaerfte Schema.
    const schemaString = JSON.stringify(schemaEntschaerft);
    const schemaHash = createHash('sha256').update(schemaString).digest('hex');
    const bytes = Buffer.byteLength(schemaString, 'utf8');

    const gesamtCodes = new Set<string>();
    for (const set of belegtProAnlage.values()) {
      for (const c of set) gesamtCodes.add(c);
    }

    const schemaMeta: SchemaBauMeta = {
      basis_codes: finalCodes.length,
      kurator_codes: kuratorCodes.size,
      gesamt_codes: gesamtCodes.size,
      anlagen_betroffen: anlagenFinal,
      gepruned_auf_bytes: bytes,
      leaf_count: sammlePflichtfelder(schemaEntschaerft).length,
      elster_code_count: sammleCodesAusSchema(schemaEntschaerft).size,
      personen_pro_anlage: Object.fromEntries(
        [...personenProAnlage.entries()].map(([k, s]) => [k, [...s]]),
      ),
    };

    ctx.emit('schema_bytes', { bytes, hash: schemaHash });
    ctx.logger.info('Schema-Bau fertig', {
      anlagen: anlagenFinal,
      bytes,
      codes: gesamtCodes.size,
    });

    return {
      basisSchema: schemaEntschaerft as Record<string, unknown>,
      schemaMeta,
      schemaHash,
    };
  },
});
