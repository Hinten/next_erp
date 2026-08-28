/**
 * Pure size-chart binding logic (Step 5 / M2) — ports the old Flutter chart
 * selection + row matching used at publish time:
 *
 *  - `resolveSizeChart` = `TabelaDeMedidas.getTabelaDeMedidasMercadoLivre`
 *    (tabelaMedidas models.dart:64-126): candidates are the conta's charts
 *    with an ML id and a `domain_id` equal to the category's
 *    `settings.catalog_domain` (FULL form, `'MLB-PANTS'`); when the link doc
 *    carries no attributes the first candidate wins, otherwise the chart with
 *    the most attribute hits (same id + equal value_id OR equal value_name)
 *    wins — and zero hits means NO chart (legacy behavior).
 *  - `findChartRow` = `_findRowTabelaMedidas` (exportarProdutos.dart:21-26):
 *    the first row with an ML id whose `varianteUid` LAST PATH SEGMENT is
 *    among the child's `variacoesUid` last segments — matching is by variant
 *    identity, never by size name (a chart row's SIZE label may legitimately
 *    differ from the variante's nome; the row's SIZE then REPLACES the
 *    variation's SIZE combination, see `assemblePublishInput`).
 *
 * ⚠️ **`resolveSizeChart` answers WHY it bound nothing, and that is the point**
 * (#1087). It used to return a bare `MlSizeChart | null`, so four structurally
 * different outcomes — the category has no domain, the tabela's guias are in
 * another domain, its guia in the right domain was never sent to ML, the
 * scoring hit nothing — collapsed into one `null` that publish then turned into
 * a silent omission. ML answered with `Attribute [SIZE_GRID_ID] is missing`,
 * a message naming neither domain, and the operator had nothing to act on.
 * The reason travels out with the chart; the MATCHING RULES below are unchanged.
 */
import type { MlAttributeWire, MlSizeChart } from '@delfrance/schemas';

/**
 * ⚠️ `resolveSizeChart` and its result types now live in `@delfrance/schemas`
 * (#1087). They were hand-mirrored in `apps/web` and the copies drifted twice,
 * so there is one implementation and both surfaces import it. Re-exported here
 * so this module stays the size-chart entry point for the publish flow.
 */
export {
  resolveSizeChart,
  type ScoringAttribute,
  type SizeChartMiss,
  type SizeChartResolution,
} from '@delfrance/schemas';

export interface SizeChartRowBinding {
  /** FULL ML row id (`'<chartId>:<n>'`) — the `SIZE_GRID_ROW_ID` wire value. */
  rowId: string;
  /** The row's SIZE attribute — replaces the variation's SIZE combination. */
  size: MlAttributeWire | null;
}

export interface ResolvedSizeChart {
  chartId: string;
  /** Child produto id → its matched chart row (unmatched children absent). */
  rowByChildId: Record<string, SizeChartRowBinding>;
}

/** Last path segment of a (fake or doc) path — the legacy join key. */
function lastSegment(path: string): string {
  const segs = path.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? '';
}

export function findChartRow(
  chart: MlSizeChart,
  variacoesUid: readonly string[],
): SizeChartRowBinding | null {
  const childVariantIds = new Set(variacoesUid.map(lastSegment));
  for (const row of chart.rows ?? []) {
    if (row.id == null || row.id === '' || row.varianteUid == null) continue;
    if (childVariantIds.has(lastSegment(row.varianteUid))) {
      // `sizeCalculado` first: ML COMPUTES each row's SIZE from the chart's
      // main attribute, and on a footwear chart (main attribute `EU_SIZE`,
      // `M_US_SIZE`, …) the row carries no SIZE of its own, so ML's computed
      // value is the only one that will match the listing. An apparel chart —
      // and every chart written before the cache existed, Flutter's included —
      // falls through to the row's own SIZE, exactly as before.
      const size = row.sizeCalculado ?? (row.attributes ?? []).find((a) => a.id === 'SIZE') ?? null;
      return { rowId: row.id, size };
    }
  }
  return null;
}
