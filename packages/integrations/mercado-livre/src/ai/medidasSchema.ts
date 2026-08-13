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
import type { JsonSchemaNode } from '@delfrance/ai';

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
  const seenSize = new Set<string>();
  const keptRows: MedidaRowSpec[] = [];
  let truncated = false;
  for (const row of rows) {
    const size = row.size.trim();
    if (size === '' || seenSize.has(size)) {
      truncated = true;
      continue;
    }
    if (keptRows.length >= maxRows) {
      truncated = true;
      break;
    }
    seenSize.add(size);
    keptRows.push({ ...row, size });
  }

  const usable = columns.filter((c) => c.attributeId.trim() !== '');
  const keptColumns = usable.slice(0, maxColumns);
  if (keptColumns.length < usable.length) truncated = true;

  const columnProperties: Record<string, JsonSchemaNode> = {};
  for (const column of keptColumns) {
    columnProperties[column.attributeId] = buildCell(column, maxEnumValues);
  }

  const properties: Record<string, JsonSchemaNode> = {};
  for (const row of keptRows) {
    properties[row.size] = {
      type: 'object',
      description: `Medidas do tamanho ${row.size}.`,
      // A fresh copy per row: the tree is handed to a provider that may mutate
      // or serialise it, and sharing one object across 75 rows makes any such
      // edit apply to all of them at once.
      properties: { ...columnProperties },
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

function buildCell(column: MedidaColumnSpec, maxEnumValues: number): JsonSchemaNode {
  const node: JsonSchemaNode = { type: 'string', description: describe(column) };
  const options = enumMembers(column, maxEnumValues);
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
    .map((v) => v.name)
    .filter((n) => typeof n === 'string' && n.trim() !== '');
  if (names.length === 0 || names.length > maxEnumValues) return null;
  return names;
}

function describe(column: MedidaColumnSpec): string {
  const parts: string[] = [column.label];
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
