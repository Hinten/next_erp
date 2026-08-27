/**
 * The JSON Schema an AI model must answer with when filling a Mercado Livre
 * size-chart grid from a photo of the supplier's measurement table.
 *
 * ## Same three prohibitions as `attributeSchema.ts`, for the same reason
 *
 * **No `required`, no `nullable`, no `anyOf`.** A schema that forces an answer
 * gets one, and here that is worse than for attributes: a hallucinated "Largura
 * do tórax: 52" is indistinguishable from a measured one, ships to buyers, and
 * comes back as a return. Omitting a cell it cannot read has to stay the
 * cheapest thing the model can do. `aiMedidasSchema.test.ts` walks the emitted
 * tree asserting all three are absent, exactly as the attribute suite does.
 *
 * ## Shape
 *
 * Two levels: row → column → string.
 *
 * ```jsonc
 * { "type": "object", "additionalProperties": false, "properties": {
 *     "P": { "type": "object", "additionalProperties": false, "properties": {
 *       "CHEST_CIRCUMFERENCE_FROM": { "type": "string", "description": "…" } } } } }
 * ```
 *
 * Rows are keyed by their **size label** (`P`, `M`, `42`) rather than by the
 * editor's internal row key, because that is what the model can actually see in
 * the photo — a column header or a leading cell. `applyAiMedidas` maps the label
 * back to the row.
 *
 * Every leaf is a **string** even for a numeric column: models emit `52` and
 * `"52"` interchangeably, and normalising one type downstream is simpler than
 * making the schema police it.
 */
import { normalizeLoose, type JsonSchemaNode } from '@delfrance/ai';

// ⚠️ Imported, not re-declared. `-1` is a Mercado Livre PLATFORM constant, not
// an attribute-agent one, and two copies of a sentinel that must agree are one
// edit away from disagreeing silently.
import { NA_VALUE_ID } from './attributeApply';

/**
 * One grid column, reduced to what the schema and prompt need.
 *
 * ⚠️ Deliberately NOT `ChartColumn` from `apps/web`. That type is the editor's
 * render model (React keys, unit option lists, FROM/TO connectors); this is the
 * wire contract between the browser and the suggestion route. Keeping them
 * separate is what stops a UI-only field becoming part of a server API by
 * accident — `apps/web` maps one to the other explicitly.
 *
 * A `LINKED_BY_CONNECTOR_INPUT` column contributes **two** entries here, one per
 * part (`*_FROM` and `*_TO`), because the model answers per attribute id.
 */
export interface MedidaColumnSpec {
  attributeId: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'multiselect';
  /** Closed list for `select`/`multiselect`; empty otherwise. */
  values: Array<{ id: string; name: string }>;
  /** The unit the operator picked for this column (`cm`, `"`), or null. */
  unitId: string | null;
  /** ML rejects a row missing this column. */
  required: boolean;
  /**
   * ML's size-EQUIVALENCE column (`FILTRABLE_SIZE`, and its per-domain
   * spellings): which standard Mercado Livre size(s) this row corresponds to.
   *
   * ⚠️ It is the one column in the grid that is **not** transcribed. Every other
   * cell is read off the supplier's photo, and the system instruction is written
   * to keep it that way — "OMITA qualquer medida que você não conseguir
   * determinar", "NUNCA invente, estime, interpole ou extrapole". An equivalence
   * is *derived* from the row's own size label and measurements, so under those
   * rules alone a model correctly answers nothing at all. {@link describe} is
   * what carves it out, and it lives there rather than only in the instruction
   * because the instruction is overridable per-install and the schema is not.
   */
  sizeEquivalence?: boolean;
}

/** One grid row, identified by the editor and labelled by its main attribute. */
export interface MedidaRowSpec {
  /** The editor's stable row key — round-tripped, never shown to the model. */
  key: string;
  /** The row's main-attribute value (`P`, `M`, `42`). What the model matches on. */
  size: string;
}

export interface BuildMedidasSchemaOptions {
  /** Cap on rows. Defaults to ML's own `ui_config.max_allowed`. */
  maxRows?: number;
  /** Cap on columns, and on enum members per column. */
  maxColumns?: number;
  maxEnumValues?: number;
}

/** ML's own row cap for a size chart (`ui_config.max_allowed`). */
const DEFAULT_MAX_ROWS = 75;
const DEFAULT_MAX_COLUMNS = 15;
const DEFAULT_MAX_ENUM_VALUES = 60;

export interface BuiltMedidasSchema {
  schema: JsonSchemaNode;
  /** The rows that made it in, in order — the prompt must name only these. */
  rows: MedidaRowSpec[];
  /** The columns that made it in, in order. */
  columns: MedidaColumnSpec[];
  /** True when a cap or a duplicate label dropped something. Never silent. */
  truncated: boolean;
}

/**
 * Build the response schema for a grid.
 *
 * Returns the surviving rows/columns alongside it because the prompt must name
 * **exactly** what the schema will accept: `additionalProperties: false` makes
 * constrained decoding reject anything else, so a prompt listing a dropped
 * column would be pulling against the schema. Same rule the attribute prompt
 * follows.
 */
export function buildMedidasSchema(
  rows: MedidaRowSpec[],
  columns: MedidaColumnSpec[],
  options: BuildMedidasSchemaOptions = {},
): BuiltMedidasSchema {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxEnumValues = options.maxEnumValues ?? DEFAULT_MAX_ENUM_VALUES;

  // ⚠️ Two rows sharing a size label would collide on one schema property, and
  // the answer could not be attributed to either. Dropping the later one is the
  // only safe read — writing a measurement to the wrong row is worse than not
  // writing it. `truncated` reports it; the UI says so.
  //
  // ⚠️ The key is `normalizeLoose`, NOT `trim()`. `applyAiMedidas` resolves the
  // answer with `normalizeLoose` (case-folded, diacritics stripped), so a
  // stricter key here does not prevent the collision — it hides it. `Único` and
  // `unico` would survive as two distinct schema properties, every answer for
  // either would resolve to the FIRST row, the second row would get nothing, and
  // `truncated` would stay false. Silent mis-attribution, which is the one
  // outcome this block exists to rule out. The two keys must be the same key.
  const seenSize = new Set<string>();
  const keptRows: MedidaRowSpec[] = [];
  let truncated = false;
  for (const row of rows) {
    const size = row.size.trim();
    // The property name keeps the ORIGINAL spelling — that is what the model
    // reads off the photo — while the dedupe key is the normalised form.
    const key = normalizeLoose(size);
    if (key === '' || seenSize.has(key)) {
      truncated = true;
      continue;
    }
    if (keptRows.length >= maxRows) {
      truncated = true;
      break;
    }
    seenSize.add(key);
    keptRows.push({ ...row, size });
  }

  const usable = columns.filter((c) => c.attributeId.trim() !== '');
  const keptColumns = usable.slice(0, maxColumns);
  if (keptColumns.length < usable.length) truncated = true;

  const properties: Record<string, JsonSchemaNode> = {};
  for (const row of keptRows) {
    // ⚠️ The cell nodes are BUILT per row, not shared and spread. A spread copies
    // the record but leaves every value — and every `enum` array inside it — one
    // object shared across all 75 rows, so a provider that edits
    // `properties.P.properties.FIT` edits every row at once. That is the exact
    // scenario this guards against, and the shallow version did not guard it.
    const cells: Record<string, JsonSchemaNode> = {};
    for (const column of keptColumns) {
      cells[column.attributeId] = buildCell(column, maxEnumValues);
    }
    properties[row.size] = {
      type: 'object',
      description: `Medidas do tamanho ${row.size}.`,
      properties: cells,
      additionalProperties: false,
    };
  }

  return {
    schema: {
      type: 'object',
      // NOTE: no `required`, at either level. Omission is how the model declines
      // to guess a measurement, and that has to be the cheapest path.
      properties,
      additionalProperties: false,
    },
    rows: keptRows,
    columns: keptColumns,
    truncated,
  };
}

/**
 * One cell's node.
 *
 * A `multiselect` column answers with an ARRAY. ML tags its equivalence
 * attribute `multivalued` on apparel domains and means it: their own docs map
 * one row ("Small") onto four standard sizes (34, 36, 38, 40), and that set is
 * what the listing's size filter is built from — collapsing it to one value
 * narrows who can find the anúncio. Every other column stays a scalar.
 *
 * ⚠️ Still no `required`, no `nullable`, no `anyOf`, and no `minItems`: omitting
 * the property has to stay the cheapest way for a model to decline.
 */
function buildCell(column: MedidaColumnSpec, maxEnumValues: number): JsonSchemaNode {
  const description = describe(column);
  const options = enumMembers(column, maxEnumValues);

  if (column.kind === 'multiselect') {
    const item: JsonSchemaNode = { type: 'string' };
    if (options != null) item.enum = options;
    return { type: 'array', description, items: item };
  }

  const node: JsonSchemaNode = { type: 'string', description };
  if (options != null) node.enum = options;
  return node;
}

/**
 * Allowed values for an enumerated column, by NAME — the model reasons about
 * "Algodão", not about `M1`, and `applyAiMedidas` resolves the name back to its
 * id accent- and case-insensitively.
 *
 * Returns null when the column is not a closed list, or when the list is long
 * enough that inlining it costs more than it saves; free text is then resolved
 * by the same matcher.
 */
function enumMembers(column: MedidaColumnSpec, maxEnumValues: number): string[] | null {
  if (column.kind !== 'select' && column.kind !== 'multiselect') return null;
  const names = column.values
    // ⚠️ Dropped by value **id**, not by name. `-1` is Mercado Livre's
    // platform-wide "does not apply" marker, and its NAME is whatever ML
    // localised it to — "N/A", "Não se aplica", "No aplica" — so a name-based
    // filter matches nothing and duly offers the sentinel as a legal enum
    // member. Unlike the attribute agent, this one does not re-offer it under a
    // fixed label: a size-chart cell reading "does not apply" is not a
    // measurement, and `-1` satisfies ML's required check, so accepting one
    // would silence the validation meant to catch a missing measurement.
    .filter((v) => v.id !== NA_VALUE_ID)
    .map((v) => v.name)
    .filter((n) => typeof n === 'string' && n.trim() !== '');
  // Counted AFTER the sentinel is removed, so a list holding nothing else falls
  // back to free text rather than emitting `enum: []` — a schema no answer can
  // satisfy, which turns "I cannot read this" into a hard validation failure.
  if (names.length === 0 || names.length > maxEnumValues) return null;
  return names;
}

function describe(column: MedidaColumnSpec): string {
  const parts: string[] = [column.label];
  // ⚠️ FIRST, and it REPLACES the measurement wording rather than adding to it.
  // This column is a size-system correspondence, not something printed on the
  // supplier's sheet — see `MedidaColumnSpec.sizeEquivalence`. Without this the
  // "never invent, omit what you cannot read" rules apply to it verbatim and the
  // model leaves the one column ML refuses the guia over empty.
  if (column.sizeEquivalence === true) {
    parts.push(
      column.kind === 'multiselect'
        ? 'Equivalência de tamanho: quais tamanhos padrão do Mercado Livre correspondem a este tamanho. NÃO é uma medida da tabela — deduza a partir do nome do tamanho e das medidas desta linha, e informe todos os tamanhos padrão que este tamanho cobre.'
        : 'Equivalência de tamanho: qual tamanho padrão do Mercado Livre corresponde a este tamanho. NÃO é uma medida da tabela — deduza a partir do nome do tamanho e das medidas desta linha.',
    );
    if (column.required) parts.push('Obrigatório no Mercado Livre.');
    return parts.join(' — ');
  }
  if (column.kind === 'number') {
    // ⚠️ Naming the unit and forbidding conversion in the same breath. A size
    // table printed in centimetres against a chart configured in inches is the
    // case that produces a plausible, wrong, unverifiable number — so the model
    // is told to report what it reads, and a mismatch surfaces to the operator
    // instead of being silently "helped".
    parts.push(
      column.unitId != null && column.unitId !== ''
        ? `Informe apenas o número, na unidade ${column.unitId}, exatamente como aparece na tabela. Não converta unidades.`
        : 'Informe apenas o número, exatamente como aparece na tabela.',
    );
  }
  if (column.required) parts.push('Obrigatório no Mercado Livre quando aplicável.');
  return parts.join(' — ');
}
