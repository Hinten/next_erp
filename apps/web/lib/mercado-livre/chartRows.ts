/**
 * Row and cell logic for the size-chart grid — the bridge between the columns
 * `chartSpec.ts` derives and the stored wire shape (`mlSizeChartRowSchema`).
 * No React and no IO, so every rule below is unit-testable on its own.
 *
 * The stored shape is the legacy Flutter one and stays that way: a row is
 * `{varianteUid, id, attributes: [{id, value_id?, value_name?, unit_id?, valueList?}]}`.
 * The editor works on a keyed `cells` map instead, because a grid indexes by
 * (row, column) and scanning an array per cell render does not.
 */
import type { MlSizeChart, MlSizeChartRow, Variante } from '@delfrance/schemas';
import { varianteFakePath } from '@delfrance/schemas';

import type { ChartColumn, ChartSpecValue } from './chartSpec';

/** ML's chart-name limit, and the charset it accepts. */
export const CHART_NAME_MAX = 60;

/** One cell's value. `valueList` is only used by a multivalued list column. */
export interface ChartCellValue {
  value_id: string | null;
  value_name: string | null;
  valueList: ChartSpecValue[] | null;
}

/** One editable row. `key` is stable across edits so React never remounts inputs. */
export interface ChartRowDraft {
  key: string;
  /** Fake path of the Variante this row measures — the publish-time join. */
  varianteUid: string | null;
  /** FULL ML row id (`'<chartId>:<n>'`); null while the row has never been sent. */
  id: string | null;
  /** Values by attribute id. */
  cells: Record<string, ChartCellValue>;
  /** Staged for removal — only ever settable on a row ML has not seen. */
  deleted: boolean;
}

export const EMPTY_CELL: ChartCellValue = { value_id: null, value_name: null, valueList: null };

/** A cell counts as filled when it carries any value form. */
export function isFilled(cell: ChartCellValue | undefined): boolean {
  if (!cell) return false;
  if (cell.value_id != null && cell.value_id !== '') return true;
  if (cell.valueList != null && cell.valueList.length > 0) return true;
  return typeof cell.value_name === 'string' && cell.value_name.trim().length > 0;
}

/* ------------------------------- seeding --------------------------------- */

function cellFromAttribute(attr: Record<string, unknown>): ChartCellValue {
  const rawList = attr.valueList;
  const valueList = Array.isArray(rawList)
    ? rawList
        .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
        .map((v) => ({
          id: typeof v.value_id === 'string' ? v.value_id : '',
          name: typeof v.value_name === 'string' ? v.value_name : '',
        }))
        .filter((v) => v.id !== '' || v.name !== '')
    : null;
  return {
    value_id: typeof attr.value_id === 'string' ? attr.value_id : null,
    value_name: typeof attr.value_name === 'string' ? attr.value_name : null,
    valueList: valueList && valueList.length > 0 ? valueList : null,
  };
}

/**
 * Editable rows for a stored chart. Attributes the current columns no longer
 * mention are dropped on purpose: the columns come from the domain's live ficha
 * técnica, and re-sending an attribute ML has retired earns an
 * `invalid_row_attribute`.
 */
export function seedRows(chart: MlSizeChart | null, columns: ChartColumn[]): ChartRowDraft[] {
  const known = new Set(columns.flatMap((c) => c.parts.map((p) => p.attributeId)));
  return (chart?.rows ?? []).map((row, index) => {
    const cells: Record<string, ChartCellValue> = {};
    for (const attr of row.attributes ?? []) {
      if (!known.has(attr.id)) continue;
      cells[attr.id] = cellFromAttribute(attr as unknown as Record<string, unknown>);
    }
    return {
      key: row.id ?? row.varianteUid ?? `row-${String(index)}`,
      varianteUid: row.varianteUid ?? null,
      id: row.id ?? null,
      cells,
      deleted: false,
    };
  });
}

/**
 * One row per size variante, with the main attribute seeded from the variante's
 * nome and every measurement left blank for the operator.
 *
 * `varianteUid` is what binds the row to the variation at publish time
 * (`findChartRow` matches on the last path segment), so it is not optional.
 */
export function rowsFromVariantes(
  grupoId: string,
  variantes: readonly Variante[],
  mainAttributeId: string,
): ChartRowDraft[] {
  return variantes.map((v) => ({
    key: varianteFakePath(grupoId, v.id),
    varianteUid: varianteFakePath(grupoId, v.id),
    id: null,
    cells: { [mainAttributeId]: { value_id: null, value_name: v.nome, valueList: null } },
    deleted: false,
  }));
}

/** The column unit each measurement column starts on. */
export function seedUnits(
  columns: ChartColumn[],
  chart: MlSizeChart | null,
): Record<string, string | null> {
  const stored = new Map<string, string>();
  for (const row of chart?.rows ?? []) {
    for (const attr of row.attributes ?? []) {
      if (typeof attr.unit_id === 'string' && attr.unit_id !== '' && !stored.has(attr.id)) {
        stored.set(attr.id, attr.unit_id);
      }
    }
  }
  const out: Record<string, string | null> = {};
  for (const column of columns) {
    out[column.key] = stored.get(column.key) ?? column.unit.default;
  }
  return out;
}

/* ------------------------------- writing --------------------------------- */

/**
 * The stored `attributes` array for one row. Empty cells are omitted entirely
 * (ML validates presence, not emptiness), and `unit_id` rides only on numeric
 * parts of a column that actually has a unit — the backend folds it into the
 * value name and derives ML's `struct` from the pair.
 */
export function toWireAttributes(
  row: ChartRowDraft,
  columns: ChartColumn[],
  units: Record<string, string | null>,
): NonNullable<MlSizeChartRow['attributes']> {
  const out: NonNullable<MlSizeChartRow['attributes']> = [];
  for (const column of columns) {
    const unit = units[column.key] ?? null;
    for (const part of column.parts) {
      const cell = row.cells[part.attributeId];
      if (!isFilled(cell)) continue;
      const useUnit = part.kind === 'number' && unit != null && unit !== '';
      out.push({
        id: part.attributeId,
        ...(cell!.value_id != null ? { value_id: cell!.value_id } : {}),
        ...(cell!.value_name != null ? { value_name: cell!.value_name } : {}),
        ...(useUnit ? { unit_id: unit } : {}),
        ...(cell!.valueList != null
          ? {
              valueList: cell!.valueList.map((v) => ({ value_id: v.id, value_name: v.name })),
            }
          : {}),
      } as NonNullable<MlSizeChartRow['attributes']>[number]);
    }
  }
  return out;
}

/**
 * Assemble the chart to submit. Rows staged for deletion are dropped here —
 * only ever rows without an ML id, since ML cannot delete a row it has seen.
 * `sizeCalculado` rides through untouched: it is ML's own computed value and
 * the sync excludes it from the row diff.
 */
export function toChartRows(
  rows: readonly ChartRowDraft[],
  columns: ChartColumn[],
  units: Record<string, string | null>,
  stored: MlSizeChart | null,
): MlSizeChartRow[] {
  const cachedSizes = new Map<string, MlSizeChartRow['sizeCalculado']>();
  for (const row of stored?.rows ?? []) {
    if (row.id != null && row.sizeCalculado != null) cachedSizes.set(row.id, row.sizeCalculado);
  }
  return rows
    .filter((r) => !r.deleted)
    .map((r) => {
      const cached = r.id == null ? undefined : cachedSizes.get(r.id);
      return {
        varianteUid: r.varianteUid,
        id: r.id,
        attributes: toWireAttributes(r, columns, units),
        ...(cached != null ? { sizeCalculado: cached } : {}),
      };
    });
}

/* ------------------------------ duplication ------------------------------ */

/**
 * A fresh, unsent copy of a chart — the ONLY way to change something ML froze
 * (gender, domain, measure type, a row's size). The legacy screen's *Copiar*
 * button existed for exactly this reason and used the same `(Cópia)` prefix.
 *
 * Every ML identity is cleared: the chart id, each row id, `main_attribute_id`
 * (ML re-derives it), and both ERP-only caches. Keeping any of them would make
 * the sync try to PATCH the ORIGINAL chart.
 */
export function duplicateChart(chart: MlSizeChart): MlSizeChart {
  const prefix = '(Cópia) ';
  const base = (chart.nome ?? '').trim();
  return {
    ...chart,
    id: null,
    main_attribute_id: chart.main_attribute_id ?? null,
    nome: `${prefix}${base}`.slice(0, CHART_NAME_MAX).trim(),
    exclusaoSolicitadaEm: null,
    rows: (chart.rows ?? []).map((r) => ({
      varianteUid: r.varianteUid ?? null,
      id: null,
      attributes: r.attributes ?? [],
      sizeCalculado: null,
    })),
  };
}

/* -------------------------------- errors --------------------------------- */

/** Key for one cell in the error index. */
export function cellErrorKey(rowIndex: number, attributeId: string): string {
  return `${String(rowIndex)}:${attributeId}`;
}

/** One validation problem as the editor consumes it. */
export interface ChartCellErrors {
  /** Messages per `cellErrorKey`. */
  byCell: Map<string, string[]>;
  /** Messages with no cell to pin them to (a rejected name, a bad main attribute). */
  chartLevel: string[];
  /** True when at least one problem mentions the chart's NAME specifically. */
  nameRejected: boolean;
}

/** ML codes that are about the chart's name, so the name input owns them. */
const NAME_CODES = new Set(['chart_name_unavailable']);

/**
 * Index one chart's validation errors for the grid.
 *
 * A problem whose row could not be resolved deliberately lands at chart level
 * rather than on a guessed cell: the legacy screen pinned by row VALUE, and a
 * size renamed between sends would otherwise light up the wrong row.
 */
export function indexCellErrors(
  errors: ReadonlyArray<{
    chartIndex: number;
    code: string | null;
    message: string | null;
    rowIndex: number | null;
    attributeIds: string[];
    rowMainValue: string | null;
  }>,
  chartIndex: number,
): ChartCellErrors {
  const byCell = new Map<string, string[]>();
  const chartLevel: string[] = [];
  let nameRejected = false;

  for (const err of errors) {
    if (err.chartIndex !== chartIndex) continue;
    const text = err.message ?? err.code ?? 'Erro de validação';
    if (err.code != null && NAME_CODES.has(err.code)) {
      nameRejected = true;
      chartLevel.push(text);
      continue;
    }
    if (err.rowIndex == null || err.attributeIds.length === 0) {
      // Keep the row ML named, if any — "linha M" beats an unplaceable message.
      chartLevel.push(err.rowMainValue == null ? text : `${err.rowMainValue}: ${text}`);
      continue;
    }
    for (const attributeId of err.attributeIds) {
      const key = cellErrorKey(err.rowIndex, attributeId);
      const list = byCell.get(key) ?? [];
      list.push(text);
      byCell.set(key, list);
    }
  }

  return { byCell, chartLevel, nameRejected };
}

/* ------------------------------ name rules ------------------------------- */

/**
 * ML's rule for `names`: at most 60 characters, "não aceita caracteres
 * especiais como `(`, `)` nem `-`. Use apenas letras, números e espaços."
 * Returns the problem, or null when the name is acceptable.
 *
 * ⚠️ This is why `duplicateChart` cannot simply keep `(Cópia)` in the SENT
 * name — the operator has to clean it up, and telling them here beats an
 * opaque ML rejection after the round trip.
 */
export function validateChartName(nome: string): string | null {
  const trimmed = nome.trim();
  if (trimmed.length === 0) return 'Informe o nome da guia.';
  if (trimmed.length > CHART_NAME_MAX) {
    return `O nome deve ter no máximo ${String(CHART_NAME_MAX)} caracteres.`;
  }
  if (/[^\p{L}\p{N} ]/u.test(trimmed)) {
    return 'O Mercado Livre aceita apenas letras, números e espaços no nome da guia.';
  }
  return null;
}
