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
 * Minimal structural slice for the attribute-hit scoring — satisfied by both
 * the plugin's `MlAttribute` (the link doc's attributes) and the schema's
 * `MlAttributeWire` (the chart's attributes).
 */
export interface ScoringAttribute {
  /**
   * Optional because the plugin's `MlAttribute` allows an id-less entry (ML's
   * custom characteristic, which only ever appears in a variation's
   * combinations). One can never score: the chart's own attributes always carry
   * an id, so `ca.id !== pa.id` rejects it on every comparison.
   */
  id?: string;
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

/**
 * Why no chart bound — one code per structurally different cause, each carrying
 * the strings an operator needs to act on it.
 *
 * ⚠️ `guias-nao-enviadas` and `dominio-divergente` are a deliberate SPLIT of
 * what used to be one `candidates.length === 0` exit. A guia sitting in the
 * RIGHT domain with no ML id is an un-sent draft — telling that operator their
 * domain is wrong sends them to change the one field that is already correct.
 */
export type SizeChartResolution =
  | { chart: MlSizeChart; motivo: null }
  | { chart: null; motivo: 'categoria-sem-dominio' }
  | { chart: null; motivo: 'guias-nao-enviadas'; dominioDaCategoria: string }
  | {
      chart: null;
      motivo: 'dominio-divergente';
      /** Distinct domains of the guias that WERE sent — the only ones that could bind. */
      dominiosDaTabela: string[];
      dominioDaCategoria: string;
    }
  | { chart: null; motivo: 'sem-atributos-correspondentes'; dominioDaCategoria: string };

/**
 * The no-chart half of {@link SizeChartResolution}.
 *
 * ⚠️ A `motivo: null` resolution ALWAYS carries a usable chart: every return
 * path with one hands back a member of `candidates`, and `candidates` is
 * filtered on a non-blank `id`. So a caller that has excluded this type has a
 * chart id, and needs no second "but what if the id is blank" branch.
 */
export type SizeChartMiss = Exclude<SizeChartResolution, { motivo: null }>;

export function resolveSizeChart(
  tabelas: readonly MlSizeChart[],
  catalogDomain: string | null,
  linkAttributes: readonly ScoringAttribute[] | null,
): SizeChartResolution {
  if (!catalogDomain) return { chart: null, motivo: 'categoria-sem-dominio' };
  // A guia with no ML id was never sent, so it can never be bound — that is a
  // different fact from its domain, and the two are reported separately below.
  const enviadas = tabelas.filter((t) => t.id != null && t.id !== '');
  const candidates = enviadas.filter((t) => t.domain_id === catalogDomain);
  if (candidates.length === 0) {
    // Nothing sent at all, or the guia in this domain is exactly the un-sent
    // one: the domain is not the problem and must not be blamed.
    if (enviadas.length === 0 || tabelas.some((t) => t.domain_id === catalogDomain)) {
      return { chart: null, motivo: 'guias-nao-enviadas', dominioDaCategoria: catalogDomain };
    }
    return {
      chart: null,
      motivo: 'dominio-divergente',
      dominiosDaTabela: [
        ...new Set(
          enviadas.map((t) => t.domain_id).filter((d): d is string => d != null && d !== ''),
        ),
      ].sort(),
      dominioDaCategoria: catalogDomain,
    };
  }

  // Legacy boundary (models.dart:91): the first-candidate fallback fires ONLY
  // when the RAW attribute list is null/empty. A non-empty list whose entries
  // are all unvalued (real stored data — ML-imported stubs, valueList-only
  // attrs) goes through the scoring loop, hits nothing, and binds NO chart —
  // falling back blindly there could bind the wrong gender's chart.
  const raw = linkAttributes ?? [];
  if (raw.length === 0) return { chart: candidates[0]!, motivo: null };

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
  // Zero hits everywhere ⇒ no chart (legacy: a valued-attribute produto must
  // actually match a chart; falling back blindly could bind a wrong gender).
  if (best == null) {
    return {
      chart: null,
      motivo: 'sem-atributos-correspondentes',
      dominioDaCategoria: catalogDomain,
    };
  }
  return { chart: best, motivo: null };
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
