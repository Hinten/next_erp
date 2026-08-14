import type { MercadoLivreMedidaColumn, MercadoLivreMedidaRow } from './client';
import type { ChartColumn } from './chartSpec';
import type { ChartRowDraft } from './chartRows';

/**
 * The editor's grid, as the AI request describes it.
 *
 * ⚠️ **One derivation, two call sites.** The editor's "Preencher com IA" button
 * and the request body it sends must agree on what "there is a grid to fill"
 * means, and they used to not: the button enabled on `rows.length > 0 &&
 * columns.length > 0` while the payload filtered deleted rows out and dropped
 * the main-attribute column. A guia with every row marked for deletion, or one
 * showing only its size column, enabled the button and came back
 * *"Monte a grade da guia antes de pedir sugestões"* over a grid the operator
 * could see. Keeping the rule in a function both sides call is what makes that
 * disagreement unrepresentable rather than merely fixed.
 */
export interface ChartAiGrid {
  rows: MercadoLivreMedidaRow[];
  columns: MercadoLivreMedidaColumn[];
}

export function buildChartAiGrid(input: {
  rows: ChartRowDraft[];
  columns: ChartColumn[];
  /** The unit the operator chose per column key, when the column offers a choice. */
  units: Record<string, string | null>;
  mainAttributeId: string;
}): ChartAiGrid {
  const rows = input.rows
    // Deletion is staged in this editor (apps/web rule 7): a row marked for
    // deletion is still rendered, dimmed, until the guia is saved. Asking the
    // model to measure it would spend tokens on a row that is on its way out and
    // put suggestions on cells the operator has already given up on.
    .filter((row) => !row.deleted)
    .map((row) => ({
      key: row.key,
      size: row.cells[input.mainAttributeId]?.value_name ?? '',
    }));

  const columns = input.columns.flatMap((column) =>
    column.parts
      // ⚠️ The main attribute is NOT a fillable column. `columns` keeps it
      // because the grid must render the size cell, but `rows[].size` already
      // carries that exact value — so sending it burns one of the 15 schema
      // columns to ask for something we supplied, and a model that answers
      // differently would rewrite the row's size label if the operator hit
      // "Marcar todas". That label is the row's identity: ML freezes it on a
      // sent row, so an accepted suggestion there earns a validation error at
      // send time and desyncs the row from its `varianteUid` binding in the
      // meantime.
      .filter((part) => part.attributeId !== input.mainAttributeId)
      .map((part) => ({
        attributeId: part.attributeId,
        label: column.parts.length > 1 ? `${column.label} — ${part.label}` : column.label,
        kind: part.kind,
        values: part.values,
        unitId: input.units[column.key] ?? column.unit.default,
        required: column.required,
      })),
  );

  return { rows, columns };
}

/** Whether there is anything for the agent to do — the button's enable-guard. */
export function chartAiGridIsFillable(grid: ChartAiGrid): boolean {
  return grid.rows.length > 0 && grid.columns.length > 0;
}
