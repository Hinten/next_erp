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
 * No chart resolved ⇒ the SIZE_GRID_* attributes are simply omitted (legacy
 * parity — ML rejects chart-required domains itself and the error lands on
 * the link doc via the estado 'E' flow).
 */
import type { MlAttributeWire, MlSizeChart } from '@delfrance/schemas';

/**
 * Minimal structural slice for the attribute-hit scoring — satisfied by both
 * the plugin's `MlAttribute` (the link doc's attributes) and the schema's
 * `MlAttributeWire` (the chart's attributes).
 */
export interface ScoringAttribute {
  id: string;
  value_id?: string | null;
  value_name?: string | null;
}

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

export function resolveSizeChart(
  tabelas: readonly MlSizeChart[],
  catalogDomain: string | null,
  linkAttributes: readonly ScoringAttribute[] | null,
): MlSizeChart | null {
  if (!catalogDomain) return null;
  const candidates = tabelas.filter(
    (t) => t.id != null && t.id !== '' && t.domain_id === catalogDomain,
  );
  if (candidates.length === 0) return null;

  // Legacy boundary (models.dart:91): the first-candidate fallback fires ONLY
  // when the RAW attribute list is null/empty. A non-empty list whose entries
  // are all unvalued (real stored data — ML-imported stubs, valueList-only
  // attrs) goes through the scoring loop, hits nothing, and binds NO chart —
  // falling back blindly there could bind the wrong gender's chart.
  const raw = linkAttributes ?? [];
  if (raw.length === 0) return candidates[0]!;

  // Only VALUED produto attributes can "hit" a chart in the scoring.
  const produtoAttrs = raw.filter((a) => a.value_id != null || a.value_name != null);

  let best: MlSizeChart | null = null;
  let bestHits = 0;
  for (const chart of candidates) {
    let hits = 0;
    for (const pa of produtoAttrs) {
      for (const ca of chart.attributes ?? []) {
        if (ca.id !== pa.id) continue;
        if (
          (pa.value_id != null && ca.value_id === pa.value_id) ||
          (pa.value_name != null && ca.value_name === pa.value_name)
        ) {
          hits += 1;
        }
      }
    }
    if (hits > bestHits) {
      best = chart;
      bestHits = hits;
    }
  }
  // Zero hits everywhere ⇒ null (legacy: a valued-attribute produto must
  // actually match a chart; falling back blindly could bind a wrong gender).
  return best;
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
