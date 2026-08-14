/**
 * The JSON Schema an AI model must answer with when suggesting Mercado Livre
 * category attributes.
 *
 * ## Why a hand-built plain object and not a Zod schema
 *
 * Runtime-agnostic on purpose. A plain JSON Schema is what every candidate
 * runtime accepts directly — Genkit's `output.jsonSchema`, `@google/genai`'s
 * `responseSchema`, and Vertex's REST API alike — so the runtime decision this
 * repo has deferred does not reach into this file. It also sidesteps the fact
 * that no published Genkit speaks Zod 4, which this repo depends on heavily.
 *
 * ## The bug this exists to NOT re-introduce
 *
 * The legacy generator (`cadastroSlim.dart:301-412`) built its schema with
 * `Schema.object({properties})`, which marks **every** property required unless
 * `optionalProperties` is passed — and it never was. It then set
 * `nullable: catalog_required || required || hierarchy == 'FAMILY'`.
 *
 * Read those two together and the net effect is exactly backwards:
 *
 *  - an attribute ML **requires** was allowed to come back `null`;
 *  - an attribute ML treats as **optional** was mandatory, so the model had to
 *    invent a value for it.
 *
 * A generator that forces an answer gets one. That is a hallucination factory
 * pointed at a fiscal-adjacent payload, so this builder takes the opposite
 * stance at every turn: **no `required` array, no `nullable`, no `anyOf`**, and
 * a prompt that says to omit what cannot be determined. `attributeSchema.test.ts`
 * asserts all three, on every build, and that assertion is the point of the file.
 */

/** The subset of ML's attribute metadata the schema builder needs. */
export interface AiAttributeSpec {
  id: string;
  name: string | null;
  /** `string | number | number_unit | boolean | list`, or whatever ML adds. */
  valueType: string | null;
  values: Array<{ id: string | null; name: string | null }>;
  hint: string | null;
  valueMaxLength: number | null;
  defaultUnit: string | null;
  required: boolean;
}

/** A minimal JSON Schema node — only the keywords this builder ever emits. */
export interface JsonSchemaNode {
  type: 'object' | 'string';
  description?: string;
  enum?: string[];
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  /** Always ABSENT on purpose — declared so tests can assert it is not set. */
  required?: string[];
  additionalProperties?: false;
}

export interface BuildAttributeSchemaOptions {
  /**
   * Cap on properties, and on enum members per property. The response schema —
   * not the prompt — dominates the token bill for a rich category, so this is
   * the cost lever.
   */
  maxProperties?: number;
  maxEnumValues?: number;
}

const DEFAULT_MAX_PROPERTIES = 40;
const DEFAULT_MAX_ENUM_VALUES = 60;

/**
 * ML's platform-wide "does not apply" marker.
 *
 * ⚠️ The model IS allowed to produce it, under the fixed spelling below. It used
 * to be forbidden, on the reasoning that declaring an attribute inapplicable was
 * a human judgement — but a closed list without it leaves the model choosing
 * between inventing a value and omitting an attribute it correctly judged, and
 * plenty genuinely do not apply (voltage on a t-shirt, sole material on a
 * notebook). What stays reserved for the human is ACCEPTING it: an N/A
 * suggestion is staged unchecked (`preCheckedSuggestionIds`), because `-1`
 * satisfies ML's required check and would otherwise silence the validation that
 * exists to catch a missing value.
 */
const NA_VALUE_ID = '-1';

/**
 * The single spelling of "does not apply" the model is offered and the applier
 * recognises.
 *
 * ⚠️ Fixed on our side rather than taken from ML's own localised value name. ML
 * spells it differently per attribute and per site ("N/A", "Não se aplica",
 * "No aplica"), and an enum member the applier has to guess at is a member it
 * will eventually fail to map — silently, as a free-text value ML then rejects.
 */
export const NA_ENUM_LABEL = 'N/A';

/**
 * Build the response schema for a category's attributes.
 *
 * Every property is a **string** even for `number`/`number_unit`: models emit
 * `55` and `"55"` interchangeably, and normalising one type downstream is
 * simpler than making the schema police it. `attributeApply` does that
 * normalisation.
 */
export function buildAttributeSchema(
  attrs: AiAttributeSpec[],
  options: BuildAttributeSchemaOptions = {},
): JsonSchemaNode {
  const maxProperties = options.maxProperties ?? DEFAULT_MAX_PROPERTIES;
  const maxEnumValues = options.maxEnumValues ?? DEFAULT_MAX_ENUM_VALUES;

  const properties: Record<string, JsonSchemaNode> = {};
  // Required-first ordering is the server's (`projectCategoriaAtributos`), so
  // truncating from the tail drops the least important attributes rather than
  // an arbitrary set.
  for (const attr of attrs.slice(0, maxProperties)) {
    properties[attr.id] = buildProperty(attr, maxEnumValues);
  }

  return {
    type: 'object',
    // NOTE: no `required`. Omission is how the model declines to guess, and
    // that has to be the cheapest thing it can do.
    properties,
    additionalProperties: false,
  };
}

function buildProperty(attr: AiAttributeSpec, maxEnumValues: number): JsonSchemaNode {
  const node: JsonSchemaNode = { type: 'string', description: describe(attr) };

  const options = enumMembers(attr, maxEnumValues);
  if (options != null) node.enum = options;
  else if (attr.valueMaxLength != null && attr.valueMaxLength > 0) {
    node.maxLength = attr.valueMaxLength;
  }
  return node;
}

/**
 * The allowed values for an enumerated attribute, by NAME.
 *
 * Names rather than ML value ids because the model reasons about "Algodão", not
 * about `M1`, and because `attributeApply` resolves a name back to its id
 * accent- and case-insensitively — the legacy compared raw strings, so
 * `Algodao` fell through to free text and ML rejected the listing.
 *
 * Returns null when the attribute is not a closed list, or when the list is so
 * long that inlining it would cost more than it saves; a free-text answer is
 * then resolved by the same name matcher.
 */
function enumMembers(attr: AiAttributeSpec, maxEnumValues: number): string[] | null {
  if (attr.valueType !== 'list' && attr.valueType !== 'boolean') return null;
  const names = attr.values
    // ⚠️ The N/A sentinel is dropped HERE and re-added below under a fixed
    // spelling. Two reasons it cannot simply be left in place: it is identified
    // by its value **id** (`-1`) while its NAME is whatever ML localised it to,
    // so the enum would carry an unpredictable string the applier then has to
    // recognise; and a category that does NOT list it would offer no way to say
    // "não se aplica" at all.
    .filter((v) => v.id !== NA_VALUE_ID)
    .map((v) => v.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  // Counted BEFORE the sentinel is appended: the cap is about how many real
  // choices are worth inlining, and "N/A" is not one of them. Zero real values
  // falls back to free text rather than emitting an enum of nothing but N/A.
  if (names.length === 0 || names.length > maxEnumValues) return null;
  // Every closed list gets "N/A", whether or not ML enumerated it. `value_id:
  // '-1'` is ML's platform-wide "does not apply" marker (`attrNA` writes it for
  // any attribute id), and a closed list without it forces the model to choose
  // between inventing a value and omitting an attribute that genuinely does not
  // apply to the product — which is the situation this exists to fix.
  //
  // ⚠️ …unless the category already offers that spelling under some OTHER id.
  // The filter above only drops the option whose id is `-1`, so a category
  // listing "N/A" under a real id survives it, and appending would emit
  // `['N/A', 'Azul', 'N/A']` — a duplicate member, which JSON Schema requires to
  // be unique.
  if (names.some((n) => n.trim().toLocaleLowerCase() === NA_ENUM_LABEL.toLocaleLowerCase())) {
    return names;
  }
  return [...names, NA_ENUM_LABEL];
}

function describe(attr: AiAttributeSpec): string {
  const parts: string[] = [attr.name ?? attr.id];
  if (attr.hint != null && attr.hint.trim() !== '') parts.push(attr.hint.trim());
  if (attr.valueType === 'number_unit' && attr.defaultUnit != null) {
    parts.push(`Informe apenas o número; a unidade é ${attr.defaultUnit}.`);
  } else if (attr.valueType === 'number') {
    parts.push('Informe apenas o número.');
  }
  // The model is told an attribute matters, but NOT that it must answer — the
  // schema stays permissive and the prompt says to omit what it cannot
  // determine. Stating "obrigatório" without a `required` entry is deliberate:
  // it ranks effort, it does not force an answer.
  if (attr.required) parts.push('Atributo obrigatório no Mercado Livre quando aplicável.');
  return parts.join(' — ');
}
