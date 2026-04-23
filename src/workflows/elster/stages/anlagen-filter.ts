import { defineStage } from '../../../core/stage.ts';
import { getIndices } from '../lib/helpers.ts';

interface AnlagenFilterInput {
  /** Annotation vom Enum-OCR-Call. Enthält `erkannte_anlagen: string[]`. */
  rawAnnotation: unknown;
}

interface AnlagenFilterOutput {
  erkannte_anlagen: string[];
  unbekannte_codes: string[];
}

/**
 * Nimmt die rohe Annotation aus dem Enum-OCR-Pfad und filtert sie auf
 * gültige Anlagen-Codes (validiert gegen den ELSTER-Katalog). Codes, die
 * Mistral halluziniert hat und nicht im Katalog stehen, landen in
 * `unbekannte_codes`.
 */
export const anlagenFilterStage = defineStage<AnlagenFilterInput, AnlagenFilterOutput>({
  id: 'elster-anlagen-filter',
  name: 'Katalog-Filter',
  description: 'Filtert Mistral-Anlagen-Vorschläge gegen ELSTER-Katalog',

  async run(input, ctx) {
    const anno = input.rawAnnotation as { erkannte_anlagen?: unknown } | null;
    const rawList: unknown = anno?.erkannte_anlagen;
    const kandidaten = Array.isArray(rawList)
      ? rawList.filter((x): x is string => typeof x === 'string')
      : [];

    const { elsterCatalog } = getIndices();
    const gueltig = new Set(Object.keys(elsterCatalog?.anlagen ?? {}));

    const erkannte_anlagen: string[] = [];
    const unbekannte_codes: string[] = [];
    for (const c of kandidaten) {
      if (gueltig.has(c)) erkannte_anlagen.push(c);
      else unbekannte_codes.push(c);
    }

    ctx.emit('anlagen_gefunden', { erkannt: erkannte_anlagen, unbekannt: unbekannte_codes });
    return { erkannte_anlagen, unbekannte_codes };
  },
});

/** Mini-Schema für den Enum-OCR-Call (wird als Workflow-Stage-Config verwendet). */
export function anlagenDetectorSchema(): Record<string, unknown> {
  const { elsterCatalog } = getIndices();
  const codes = Object.keys(elsterCatalog?.anlagen ?? {});
  return {
    type: 'object',
    description: 'Klassifiziere das Dokument: welche ELSTER-Anlagen belegt es eindeutig? Nur Codes aus enum. Leeres Array wenn keine Anlage eindeutig zuordenbar.',
    properties: {
      erkannte_anlagen: {
        type: 'array',
        description: 'Liste der ELSTER-Anlagen-Codes, für die dieses Dokument eindeutige Daten liefert. Beispiele: Lohnsteuerbescheinigung → ["N"]; Kapitalertragsteuerbescheinigung → ["KAP"]; Rentenbezugsmitteilung → ["R"]; Vorsorgeaufwand → ["VOR"].',
        items: { type: 'string', enum: codes },
      },
    },
    required: ['erkannte_anlagen'],
    additionalProperties: false,
  };
}
