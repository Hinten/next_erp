/**
 * The one already-filled size chart handed to the model as reference.
 *
 * A tabela de medidas is shared across contas, so the same physical size table
 * is often already typed out for another Mercado Livre account. Those are real
 * measurements a human entered — by far the strongest context available, and
 * the thing that keeps two accounts from drifting apart.
 *
 * ⚠️ **Exactly ONE chart, not all of them.** Each is a full grid of tokens for
 * diminishing return, and several near-identical references invite the model to
 * average them into a number that appears on none of the originals.
 *
 * ⚠️ **Never the chart being edited.** It lives in the same map, and feeding the
 * model the grid it is about to fill is circular — it would "confirm" whatever
 * is already there, including the blanks.
 */
/**
 * The subset of a stored `MlSizeChart` this module reads.
 *
 * ⚠️ Structural, not imported from `@delfrance/schemas`. This package stays
 * platform-neutral and does not depend on the schema package — the same reason
 * `MedidaColumnSpec` is its own wire contract instead of the web's
 * `ChartColumn`. Everything is optional because a stored chart is
 * Flutter-authored passthrough and any field may be absent.
 */
export interface MedidaReferenceChart {
  id?: string | null;
  nome?: string | null;
  rows?: MedidaReferenceChartRow[] | null;
}

export interface MedidaReferenceChartRow {
  attributes?: Array<{ id: string; value_name?: string | null }> | null;
  /** ML's computed SIZE — the only size a footwear row carries. */
  sizeCalculado?: { value_name?: string | null } | null;
}

/** One row of the reference, already flattened to what the prompt prints. */
export interface MedidaReferenceRow {
  size: string;
  /** `attributeId` → value, only the cells that carry one. */
  medidas: Record<string, string>;
}

export interface MedidaReference {
  /** The chart's own name, so the model can say which table it matched. */
  nome: string | null;
  rows: MedidaReferenceRow[];
}

export interface PickMedidaReferenceOptions {
  /** The chart being edited — excluded by ML id when it has one. */
  excludeChartId?: string | null;
  /** Cap on reference rows, so a 75-row chart cannot dominate the prompt. */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 30;

/**
 * Pick the richest usable chart and flatten it, or null when none qualifies.
 *
 * "Richest" = most filled measurement cells. Deterministic on purpose: the same
 * tabela must produce the same reference twice, or a re-run would silently
 * change the answer. Ties break on input order.
 */
export function pickMedidaReference(
  charts: readonly MedidaReferenceChart[],
  mainAttributeId: string,
  options: PickMedidaReferenceOptions = {},
): MedidaReference | null {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const excludeId = options.excludeChartId;

  let best: { chart: MedidaReferenceChart; rows: MedidaReferenceRow[]; cells: number } | null =
    null;

  for (const chart of charts) {
    // Identified by ML id. A chart with no id has never been sent, so it cannot
    // be the one being edited *and* already filled by someone else — but it can
    // still be a useful draft, so it is not excluded outright.
    if (excludeId != null && excludeId !== '' && chart.id === excludeId) continue;

    const rows = flattenRows(chart, mainAttributeId, maxRows);
    const cells = rows.reduce((n, row) => n + Object.keys(row.medidas).length, 0);
    // A chart whose rows carry only their size label is not a reference — it is
    // the same empty grid, at full token cost.
    if (cells === 0) continue;
    if (!best || cells > best.cells) best = { chart, rows, cells };
  }

  return best ? { nome: best.chart.nome ?? null, rows: best.rows } : null;
}

function flattenRows(
  chart: MedidaReferenceChart,
  mainAttributeId: string,
  maxRows: number,
): MedidaReferenceRow[] {
  const out: MedidaReferenceRow[] = [];
  for (const row of chart.rows ?? []) {
    if (out.length >= maxRows) break;
    const attributes = row.attributes ?? [];

    // The row's own label. `sizeCalculado` first for the same reason
    // `findChartRow` prefers it: on a footwear chart ML computes the row's SIZE
    // and the row carries none of its own.
    const size =
      valueOf(row.sizeCalculado) ??
      valueOf(attributes.find((a) => a.id === mainAttributeId)) ??
      valueOf(attributes.find((a) => a.id === 'SIZE'));
    if (size == null) continue;

    const medidas: Record<string, string> = {};
    for (const attr of attributes) {
      // The size label is the row's identity, not a measurement to copy — and
      // the caller already supplies it. Including it would invite the model to
      // "suggest" a size it was given.
      if (attr.id === mainAttributeId || attr.id === 'SIZE') continue;
      const value = valueOf(attr);
      if (value != null) medidas[attr.id] = value;
    }
    if (Object.keys(medidas).length === 0) continue;
    out.push({ size, medidas });
  }
  return out;
}

/**
 * The human-readable value of a stored wire attribute.
 *
 * `value_name` carries the unit already folded in by the sync path
 * (`toWireAttributes` + `measureStruct`), which is what makes a reference row
 * comparable to what the operator sees in the grid.
 */
function valueOf(attr: { value_name?: string | null } | null | undefined): string | null {
  const name = attr?.value_name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}
