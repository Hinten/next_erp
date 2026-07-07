/**
 * Size-chart CRUD sync (Step 5b / M2) — ports the legacy "Enviar Tabela de
 * Medidas ao Mercado Livre" flow (`medidasCadastro.dart
 * enviarTabelaMercadoLivre` + the payload builders in tabelaMedidas
 * models.dart) to a per-integração server operation:
 *
 *  - a chart with no ML `id` → `POST /catalog/charts` (create);
 *  - an existing chart → PUT the name when it changed, then per-row diffs
 *    (index-based vs the STORED doc, the role of the legacy `instance.old`
 *    snapshot): changed row with an ML id → PUT row, without → POST row;
 *  - every response is a FULL chart — `applyChartResponse` writes back the
 *    chart id, `main_attribute_id` and the per-INDEX `rows[].id` (legacy
 *    `updateFromMercadoLivreResponse`);
 *  - ML chart-validation errors (`{error: 'chart_validation_error',
 *    errors: [{code, message}]}`) do NOT abort: they're collected, the chart
 *    keeps its previous state (a rejected rename reverts the nome), remaining
 *    rows of that chart are skipped and the flow continues — exactly the
 *    legacy behavior so one bad chart never blocks the others;
 *  - the write-back merges ONLY `tabelasDeMedidasMercadoLivre.<integracaoId>`
 *    (Firestore deep merge), preserving other contas' entries and the Shopee
 *    map the still-running Flutter app authors.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  type MlSizeChartApi,
} from '@delfrance/integrations-mercado-livre';
import type { MlAttributeWire, MlSizeChart, MlSizeChartRow } from '@delfrance/schemas';
import { mlSizeChartSchema, mlSizeChartsForConta } from '@delfrance/schemas';
import { z } from 'zod';
import { tabelaDeMedidasCollection } from '@delfrance/data/admin/collections';

/** The tabMedi doc referenced by the sync does not exist. */
export class TabelaDeMedidasNotFoundError extends Error {
  constructor(tabMediId: string) {
    super(`Tabela de medidas ${tabMediId} não encontrada.`);
    this.name = 'TabelaDeMedidasNotFoundError';
  }
}

/** One ML chart-validation error, surfaced per chart (never thrown). */
export interface ChartValidationError {
  /** Index of the offending chart in the submitted `tabelas` array. */
  chartIndex: number;
  code: string | null;
  message: string | null;
}

export interface SyncSizeChartsResult {
  /** The charts after the sync (ML ids written back). */
  tabelas: MlSizeChart[];
  /** Collected ML validation errors (empty = everything sent cleanly). */
  validationErrors: ChartValidationError[];
  /** True when at least one ML write succeeded (and the doc was updated). */
  updated: boolean;
}

/* ------------------------- pure payload builders ------------------------- */

/** A chart/row attribute counts as VALUED when it carries any value form. */
function isValued(a: MlAttributeWire): boolean {
  const valueList = (a as Record<string, unknown>).valueList;
  return a.value_id != null || a.value_name != null || valueList != null;
}

/**
 * Legacy `_attributeToMercadoLivre`: `{id, values: [{id?, name?}]}` — the
 * unit is FOLDED into the value name (`'62 cm'`), and a multivalued
 * `valueList` yields one entry per item.
 */
export function chartAttributeToMercadoLivre(attr: MlAttributeWire): Record<string, unknown> {
  const raw = attr as Record<string, unknown>;
  const unitId = attr.unit_id ?? null;
  const withUnit = (name: unknown): unknown => (unitId != null ? `${name} ${unitId}` : name);

  const valueList = Array.isArray(raw.valueList)
    ? (raw.valueList as Array<Record<string, unknown>>)
    : null;
  const values =
    valueList && valueList.length > 0
      ? valueList.map((e) => ({
          ...(e.value_id != null ? { id: e.value_id } : {}),
          ...(e.value_name != null ? { name: withUnit(e.value_name) } : {}),
        }))
      : [
          {
            ...(attr.value_id != null ? { id: attr.value_id } : {}),
            ...(attr.value_name != null ? { name: withUnit(attr.value_name) } : {}),
          },
        ];
  return { id: attr.id, values };
}

/** The chart's `site_id` — the prefix of the FULL domain id (`'MLB-PANTS'`). */
export function chartSiteId(chart: MlSizeChart): string {
  return (chart.domain_id ?? 'MLB').split('-')[0] ?? 'MLB';
}

/**
 * Legacy `TabelaDeMedidasMercadoLivre.toMercadoLivre()` — the
 * `POST /catalog/charts` body. `domain_id` is sent WITHOUT the site prefix;
 * when no `main_attribute` entry is valued, a synthetic SIZE main attribute
 * is built from the rows' SIZE values (legacy fallback; rows without a SIZE
 * are skipped defensively — legacy crashed on them).
 */
export function chartCreatePayload(chart: MlSizeChart): Record<string, unknown> {
  const siteId = chartSiteId(chart);
  const domain = (chart.domain_id ?? '').split('-').pop() ?? '';
  const rows = chart.rows ?? [];

  const principal = (chart.main_attribute ?? [])
    .filter(isValued)
    .map((a) => ({ site_id: siteId, ...chartAttributeToMercadoLivre(a) }));

  let mainAttributes: Array<Record<string, unknown>> = principal;
  if (principal.length === 0) {
    const rowSizes = rows
      .map((r) => (r.attributes ?? []).find((a) => a.id === 'SIZE') ?? null)
      .filter((a): a is MlAttributeWire => a != null);
    if (rowSizes.length > 0) {
      mainAttributes = [
        {
          site_id: siteId,
          id: 'SIZE',
          values: rowSizes.map((a) => {
            const valueList = (a as Record<string, unknown>).valueList;
            return Array.isArray(valueList) && valueList.length > 0
              ? valueList
              : { id: a.value_id ?? null, name: a.value_name ?? null };
          }),
        },
      ];
    } else {
      mainAttributes = [];
    }
  }

  return {
    names: { [siteId]: chart.nome ?? '' },
    domain_id: domain,
    site_id: siteId,
    ...(chart.tipo != null ? { measure_type: chart.tipo } : {}),
    main_attribute: { attributes: mainAttributes },
    attributes: (chart.attributes ?? []).filter(isValued).map(chartAttributeToMercadoLivre),
    rows: rows.map((r) => ({
      attributes: (r.attributes ?? []).filter(isValued).map(chartAttributeToMercadoLivre),
    })),
  };
}

/**
 * Legacy `RowTabelaMedidasML.toMercadoLivre(tabela)` — the row create/update
 * body. Row UPDATES (the row already has an ML id) exclude the chart's main
 * attribute (immutable on ML); NEW rows include it.
 */
export function chartRowPayload(chart: MlSizeChart, row: MlSizeChartRow): Record<string, unknown> {
  return {
    sites: [chartSiteId(chart)],
    attributes: (row.attributes ?? [])
      .filter(isValued)
      .filter((a) => row.id == null || a.id !== chart.main_attribute_id)
      .map(chartAttributeToMercadoLivre),
  };
}

/**
 * Legacy `updateFromMercadoLivreResponse`: the API echoes the FULL chart —
 * write back the chart id, `main_attribute_id` and each row's ML id BY INDEX
 * (extra local rows keep their state).
 */
export function applyChartResponse(chart: MlSizeChart, response: MlSizeChartApi): MlSizeChart {
  const responseRows = response.rows ?? [];
  const rows = (chart.rows ?? []).map((row, index) => {
    const respRow = responseRows[index];
    if (!respRow || respRow.id == null) return row;
    return { ...row, id: String(respRow.id) };
  });
  return {
    ...chart,
    id: String(response.id),
    ...(response.main_attribute_id != null
      ? { main_attribute_id: response.main_attribute_id }
      : {}),
    rows,
  };
}

/* ------------------------------ diff helpers ----------------------------- */

/** Structural equality on plain JSON data (legacy `DeepCollectionEquality`). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

/* ------------------------------ orchestrator ----------------------------- */

/** ML chart-validation body: `{error, errors: [{code, message}]}`. */
const chartValidationBodySchema = z
  .object({
    errors: z.array(
      z
        .object({
          code: z.string().nullable().optional(),
          message: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * Extract the per-chart validation list from an ML 4xx body — or null when
 * the error isn't a chart-validation response (those keep propagating).
 */
function chartValidationErrors(err: unknown, chartIndex: number): ChartValidationError[] | null {
  if (!(err instanceof MercadoLivreHttpError)) return null;
  if (err.status >= 500) return null;
  const parsed = chartValidationBodySchema.safeParse(err.body);
  if (!parsed.success) return null;
  return parsed.data.errors.map((e) => ({
    chartIndex,
    code: e.code ?? null,
    message: e.message ?? null,
  }));
}

export interface SizeChartSyncDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
}

const editedTabelasSchema = z.array(mlSizeChartSchema);

/**
 * Sync the EDITED chart list of one integração against ML and persist the
 * result on the tabMedi doc. `editedTabelas` is what the UI submits (the
 * desired state); the STORED doc plays the legacy `instance.old` role for
 * the name/row diffs.
 */
export async function syncSizeCharts(
  deps: SizeChartSyncDeps,
  tabMediId: string,
  editedTabelasInput: unknown,
): Promise<SyncSizeChartsResult> {
  const { db, api, integracaoId } = deps;
  const editedTabelas = editedTabelasSchema.parse(editedTabelasInput);

  const snap = await tabelaDeMedidasCollection.docRef(db, {}, tabMediId).get();
  if (!snap.exists) throw new TabelaDeMedidasNotFoundError(tabMediId);
  const doc = tabelaDeMedidasCollection.parseRead(
    snap.data(),
    tabelaDeMedidasCollection.docPath({}, tabMediId),
  );
  const stored = mlSizeChartsForConta(doc.tabelasDeMedidasMercadoLivre ?? null, integracaoId);

  const validationErrors: ChartValidationError[] = [];
  const resultTabelas: MlSizeChart[] = [];
  let updated = false;

  for (let chartIndex = 0; chartIndex < editedTabelas.length; chartIndex += 1) {
    let chart = editedTabelas[chartIndex]!;

    if (chart.id == null || chart.id === '') {
      // ---- Create --------------------------------------------------------
      try {
        const response = await api.createSizeChart(chartCreatePayload(chart));
        chart = applyChartResponse(chart, response);
        updated = true;
      } catch (err) {
        const errors = chartValidationErrors(err, chartIndex);
        if (errors === null) throw err;
        validationErrors.push(...errors);
      }
      resultTabelas.push(chart);
      continue;
    }

    // ---- Update: name first, then per-row diffs (legacy order) -----------
    const chartId = chart.id;
    const storedChart = stored.find((c) => c.id === chartId) ?? null;
    let chartFailed = false;

    if (storedChart == null || storedChart.nome !== chart.nome) {
      try {
        const response = await api.updateSizeChartName(chartId, {
          [chartSiteId(chart)]: chart.nome ?? '',
        });
        chart = applyChartResponse(chart, response);
        updated = true;
      } catch (err) {
        const errors = chartValidationErrors(err, chartIndex);
        if (errors === null) throw err;
        validationErrors.push(...errors);
        // Legacy: a rejected rename reverts to the stored nome and the
        // chart's remaining changes are skipped this round.
        if (storedChart?.nome != null) chart = { ...chart, nome: storedChart.nome };
        chartFailed = true;
      }
    }

    if (!chartFailed) {
      const rows = chart.rows ?? [];
      const storedRows = storedChart?.rows ?? [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const storedRow = storedRows[index] ?? null;
        if (storedRow != null && deepEqual(row, storedRow)) continue;

        try {
          const response =
            row.id != null && row.id !== ''
              ? await api.updateSizeChartRow(chartId, row.id, chartRowPayload(chart, row))
              : await api.addSizeChartRow(chartId, chartRowPayload(chart, row));
          chart = applyChartResponse(chart, response);
          updated = true;
        } catch (err) {
          const errors = chartValidationErrors(err, chartIndex);
          if (errors === null) throw err;
          validationErrors.push(...errors);
          break; // legacy: stop this chart's rows, continue with the next chart
        }
      }
    }

    resultTabelas.push(chart);
  }

  if (updated) {
    // Deep merge writes ONLY this integração's key — other contas' charts and
    // `tabelasMedidasShopee` (Flutter-authored) survive untouched.
    await tabelaDeMedidasCollection.merge(db, {}, tabMediId, {
      tabelasDeMedidasMercadoLivre: { [integracaoId]: { tabelas: resultTabelas } },
      ultimaModificacao: Date.now(),
    });
  }

  return { tabelas: resultTabelas, validationErrors, updated };
}
