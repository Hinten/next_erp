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
import { mlSizeChartWriteSchema, mlSizeChartsForConta } from '@delfrance/schemas';
import { z } from 'zod';
import { tabelaDeMedidasCollection } from '@delfrance/data/admin/collections';

/** The tabMedi doc referenced by the sync does not exist. */
export class TabelaDeMedidasNotFoundError extends Error {
  constructor(tabMediId: string) {
    super(`Tabela de medidas ${tabMediId} não encontrada.`);
    this.name = 'TabelaDeMedidasNotFoundError';
  }
}

/**
 * The `cell` ML attaches to a row-level validation error — the whole reason the
 * editor can point at the offending input instead of printing a bullet list.
 */
export interface ChartValidationCell {
  attribute_id?: string | null;
  row?: {
    id?: string | number | null;
    main_attribute?: { id?: string | null; value?: string | null } | null;
  } | null;
}

/** One ML chart-validation error, surfaced per chart (never thrown). */
export interface ChartValidationError {
  /** Index of the offending chart in the submitted `tabelas` array. */
  chartIndex: number;
  code: string | null;
  message: string | null;
  /**
   * Index of the offending row in that chart's `rows`, or null for a
   * chart-level problem (`chart_name_unavailable`,
   * `main_attribute_missing_error`, `invalid_main_attribute_id`, …).
   */
  rowIndex: number | null;
  /**
   * The attribute ids the cell covers. ML sends ONE `attribute_id`, which for a
   * combined column arrives as `'A - B'`; splitting it is what lets both halves
   * of a FROM/TO pair light up (legacy `getErrorForTableCell` split it the same
   * way). Empty for a chart-level problem.
   */
  attributeIds: string[];
  /**
   * The row's main-attribute value as ML echoed it, kept for display when
   * `rowIndex` could not be resolved (a renamed size, a reordered chart).
   */
  rowMainValue: string | null;
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
 * The `struct` ML expects next to a `number_unit` value name, or null when the
 * attribute carries no unit or the value is not numeric (a free-text size like
 * `'M'` has none). ML's docs are explicit that omitting it "pode causar
 * inconsistências ao salvar os valores"; the legacy Dart builder never sent
 * one, so this is a deliberate departure from byte parity.
 *
 * Values reach us as the operator typed them, which in pt-BR means `'10,5'`.
 * Anything that does not parse cleanly yields null — the `name` still goes out,
 * so a value we cannot classify degrades to exactly the legacy behaviour.
 */
export function measureStruct(
  value: unknown,
  unitId: string | null,
): { number: number; unit: string } | null {
  if (unitId == null || unitId === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (normalized === '') return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return { number: parsed, unit: unitId };
}

/**
 * Legacy `_attributeToMercadoLivre`: `{id, values: [{id?, name?}]}` — the
 * unit is FOLDED into the value name (`'62 cm'`), and a multivalued
 * `valueList` yields one entry per item. Each unit-carrying numeric value also
 * gets its `struct` (see `measureStruct`).
 */
export function chartAttributeToMercadoLivre(attr: MlAttributeWire): Record<string, unknown> {
  const raw = attr as Record<string, unknown>;
  const unitId = attr.unit_id ?? null;
  const withUnit = (name: unknown): unknown => (unitId != null ? `${name} ${unitId}` : name);
  const structFor = (name: unknown): Record<string, unknown> => {
    const struct = measureStruct(name, unitId);
    return struct ? { struct } : {};
  };

  const valueList = Array.isArray(raw.valueList)
    ? (raw.valueList as Array<Record<string, unknown>>)
    : null;
  const values =
    valueList && valueList.length > 0
      ? valueList.map((e) => ({
          ...(e.value_id != null ? { id: e.value_id } : {}),
          ...(e.value_name != null
            ? { name: withUnit(e.value_name), ...structFor(e.value_name) }
            : {}),
        }))
      : [
          {
            ...(attr.value_id != null ? { id: attr.value_id } : {}),
            ...(attr.value_name != null
              ? { name: withUnit(attr.value_name), ...structFor(attr.value_name) }
              : {}),
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
 * `POST /catalog/charts` body. `domain_id` is sent WITHOUT the site prefix.
 *
 * The main attribute is resolved in three steps, most explicit first:
 *  1. a VALUED `main_attribute` entry (nothing in this repo writes one, but a
 *     Flutter-authored chart may);
 *  2. `main_attribute_id` — what the editor's picker records. ML documents this
 *     entry as bare `{site_id, id}` with no `values`, which is also why it
 *     cannot ride the `isValued` path above;
 *  3. the legacy fallback: a synthetic SIZE built from the rows' SIZE values
 *     (rows without a SIZE are skipped defensively — legacy crashed on them).
 *
 * Step 2 is what makes footwear domains reachable: they expose
 * `MANUFACTURER_SIZE` / `EU_SIZE` / `US_SIZE` as candidates and have no plain
 * SIZE column, so step 3 alone can never build a valid chart for them.
 */
export function chartCreatePayload(chart: MlSizeChart): Record<string, unknown> {
  const siteId = chartSiteId(chart);
  // Strip ONLY the leading site prefix ('MLB-BABY_CAR' → 'BABY_CAR'). The
  // legacy `split('-').last` would mangle a domain containing extra dashes;
  // for every single-dash domain (all known real ones) both are identical.
  const domain = (chart.domain_id ?? '').split('-').slice(1).join('-');
  const rows = chart.rows ?? [];

  const principal = (chart.main_attribute ?? [])
    .filter(isValued)
    .map((a) => ({ site_id: siteId, ...chartAttributeToMercadoLivre(a) }));

  let mainAttributes: Array<Record<string, unknown>> = principal;
  if (principal.length === 0 && chart.main_attribute_id != null && chart.main_attribute_id !== '') {
    mainAttributes = [{ site_id: siteId, id: chart.main_attribute_id }];
  } else if (principal.length === 0) {
    const rowSizes = rows
      .map((r) => (r.attributes ?? []).find((a) => a.id === 'SIZE') ?? null)
      .filter((a): a is MlAttributeWire => a != null);
    if (rowSizes.length > 0) {
      // Every value normalized through the shared attribute mapper (flat
      // `{id?, name?}` entries). The legacy fallback pushed the RAW
      // `valueList` here — nested arrays with `value_id`/`value_name` keys ML
      // can't read; a legacy bug not worth porting.
      mainAttributes = [
        {
          site_id: siteId,
          id: 'SIZE',
          values: rowSizes.flatMap(
            (a) => chartAttributeToMercadoLivre(a).values as Array<Record<string, unknown>>,
          ),
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
  // '' counts as "no ML id" everywhere in this module — a NEW row (POST) must
  // INCLUDE the main attribute (ML requires it), only updates exclude it.
  const isNewRow = row.id == null || row.id === '';
  return {
    sites: [chartSiteId(chart)],
    attributes: (row.attributes ?? [])
      .filter(isValued)
      .filter((a) => isNewRow || a.id !== chart.main_attribute_id)
      .map(chartAttributeToMercadoLivre),
  };
}

/**
 * ML's response attribute shape (`{id, name, values: [{id?, name?, struct?}]}`)
 * → the stored wire shape. `unit_id` is deliberately NOT set: ML's `name`
 * already carries the unit (`'8,5 US'`), and a stored `unit_id` would make the
 * next send append it a second time.
 */
function responseAttributeToWire(raw: Record<string, unknown>): MlAttributeWire | null {
  const id = raw.id;
  if (typeof id !== 'string' || id === '') return null;
  const values = Array.isArray(raw.values) ? raw.values : [];
  const first = values.find(
    (v): v is Record<string, unknown> => v != null && typeof v === 'object',
  );
  const valueId = first?.id;
  const valueName = first?.name;
  return {
    id,
    value_id: typeof valueId === 'string' || typeof valueId === 'number' ? String(valueId) : null,
    value_name:
      typeof valueName === 'string' || typeof valueName === 'number' ? String(valueName) : null,
  };
}

/** ML's computed `SIZE` for one response row, or null when it sent none. */
function responseRowSize(respRow: { attributes?: unknown }): MlAttributeWire | null {
  const attributes = Array.isArray(respRow.attributes) ? respRow.attributes : [];
  for (const raw of attributes) {
    if (raw == null || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.id !== 'SIZE') continue;
    const wire = responseAttributeToWire(candidate);
    if (wire != null) return wire;
  }
  return null;
}

/**
 * Legacy `updateFromMercadoLivreResponse`: the API echoes the FULL chart —
 * write back the chart id, `main_attribute_id` and each row's ML id BY INDEX
 * (extra local rows keep their state).
 *
 * Beyond legacy, each row also caches ML's computed `SIZE` as `sizeCalculado`
 * — the value the listing's variation has to match, and for a footwear chart
 * the only place it exists. See the field's doc on `mlSizeChartRowSchema` for
 * why it is kept out of `attributes`.
 */
export function applyChartResponse(chart: MlSizeChart, response: MlSizeChartApi): MlSizeChart {
  const responseRows = response.rows ?? [];
  const rows = (chart.rows ?? []).map((row, index) => {
    const respRow = responseRows[index];
    if (!respRow) return row;
    const withId = respRow.id == null ? row : { ...row, id: String(respRow.id) };
    const size = responseRowSize(respRow);
    return size == null ? withId : { ...withId, sizeCalculado: size };
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

/**
 * Drop null/undefined object keys recursively — the legacy diff compared
 * `toJson()` on BOTH sides, and every optional attribute key is
 * `includeIfNull: false`, so `{value_id: null}` and an absent `value_id` are
 * the SAME row. Without this, a UI that emits explicit nulls (this repo's
 * form convention) would see every Flutter-stored row as "changed" and
 * re-PUT the whole chart on every sync.
 */
export function stripNullsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = stripNullsDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * The row as the diff sees it. `sizeCalculado` is dropped: it is an ERP-only
 * cache written BY this sync from ML's own response, so a UI that round-trips
 * a row without it would otherwise look "changed" on every round and re-PUT
 * the entire chart.
 */
function rowDiffShape(row: MlSizeChartRow): unknown {
  const copy: Record<string, unknown> = { ...row };
  delete copy.sizeCalculado;
  return stripNullsDeep(copy);
}

/** Legacy row diff: id-less rows are ALWAYS "changed" (never yet on ML). */
function rowNeedsSend(row: MlSizeChartRow, storedRow: MlSizeChartRow | null): boolean {
  if (row.id == null || row.id === '') return true;
  if (storedRow == null) return true;
  return !deepEqual(rowDiffShape(row), rowDiffShape(storedRow));
}

/* ------------------------------ orchestrator ----------------------------- */

/** ML chart-validation body: `{error, errors: [{code, message, cell?}]}`. */
const chartValidationCellSchema = z
  .object({
    attribute_id: z.string().nullable().optional(),
    row: z
      .object({
        id: z.union([z.string(), z.number()]).nullable().optional(),
        main_attribute: z
          .object({
            id: z.string().nullable().optional(),
            value: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const chartValidationBodySchema = z
  .object({
    errors: z.array(
      z
        .object({
          code: z.string().nullable().optional(),
          message: z.string().nullable().optional(),
          cell: chartValidationCellSchema.nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** The ids one `cell.attribute_id` covers — `'A - B'` names a combined column. */
export function cellAttributeIds(attributeId: string | null | undefined): string[] {
  if (attributeId == null) return [];
  return attributeId
    .split(' - ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Which row a `cell` points at.
 *
 * ML answers `cell.row.id: null` on a create, so the join key is the row's MAIN
 * ATTRIBUTE VALUE: find the row carrying an attribute with `main_attribute.id`
 * whose `value_name` OR `value_id` equals `main_attribute.value` (legacy
 * `getErrorForTableCell`, medidasCadastro.dart:274-317 — it accepted either,
 * because a list-valued main attribute stores the id). A row id, when ML does
 * send one, wins; it may arrive bare (`'1'`) or full (`'1594439:1'`), so the
 * comparison tolerates both. Unresolvable ⇒ null, and the editor shows the
 * problem at chart level rather than pinning it to the wrong cell.
 */
export function resolveErrorRowIndex(
  chart: MlSizeChart,
  cell: ChartValidationCell | null | undefined,
): number | null {
  const rows = chart.rows ?? [];

  const rawRowId = cell?.row?.id;
  if (rawRowId != null && String(rawRowId) !== '') {
    const target = String(rawRowId);
    const targetSuffix = target.split(':').pop();
    const byId = rows.findIndex(
      (r) =>
        r.id != null && r.id !== '' && (r.id === target || r.id.split(':').pop() === targetSuffix),
    );
    if (byId >= 0) return byId;
  }

  const main = cell?.row?.main_attribute;
  if (main?.id == null || main.value == null) return null;
  const byMainValue = rows.findIndex((r) =>
    (r.attributes ?? []).some(
      (a) => a.id === main.id && (a.value_name === main.value || a.value_id === main.value),
    ),
  );
  return byMainValue >= 0 ? byMainValue : null;
}

/**
 * Extract the per-chart validation list from an ML chart-validation response
 * — or null when the error is anything else (those keep propagating). Only a
 * **400** with an `errors` array qualifies (ML's `chart_validation_error`
 * shape): a 429/403/404 that happens to carry an `errors` field is an
 * infrastructure failure and must abort the sync, not read as "your chart is
 * invalid".
 *
 * `knownRowIndex` is passed by the row endpoints, where the offending row is
 * whichever one we were sending and no `cell` lookup can beat that.
 */
function chartValidationErrors(
  err: unknown,
  chartIndex: number,
  chart: MlSizeChart,
  knownRowIndex?: number,
): ChartValidationError[] | null {
  if (!(err instanceof MercadoLivreHttpError)) return null;
  if (err.status !== 400) return null;
  const parsed = chartValidationBodySchema.safeParse(err.body);
  if (!parsed.success) return null;
  return parsed.data.errors.map((e) => ({
    chartIndex,
    code: e.code ?? null,
    message: e.message ?? null,
    rowIndex: knownRowIndex ?? resolveErrorRowIndex(chart, e.cell),
    attributeIds: cellAttributeIds(e.cell?.attribute_id),
    rowMainValue: e.cell?.row?.main_attribute?.value ?? null,
  }));
}

export interface SizeChartSyncDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
}

const editedTabelasSchema = z.array(mlSizeChartWriteSchema);

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
  // `working` starts as the submitted list and is updated IN PLACE after every
  // successful ML call — so a hard mid-sync error (429/5xx/network) can still
  // persist every chart/row id obtained so far. Losing a created chart's id
  // orphans it on ML and every retry then dies on `chart_name_unavailable`
  // (the orphan owns the name) — a hole the legacy flow shared, closed here.
  const working: MlSizeChart[] = [...editedTabelas];
  let updated = false;

  // Deep merge writes ONLY this integração's key — other contas' charts and
  // `tabelasMedidasShopee` (Flutter-authored) survive untouched.
  const persistProgress = async (): Promise<void> => {
    if (!updated) return;
    await tabelaDeMedidasCollection.merge(db, {}, tabMediId, {
      tabelasDeMedidasMercadoLivre: { [integracaoId]: { tabelas: working } },
      ultimaModificacao: Date.now(),
    });
  };

  try {
    for (let chartIndex = 0; chartIndex < working.length; chartIndex += 1) {
      let chart = working[chartIndex]!;

      if (chart.id == null || chart.id === '') {
        // ---- Create ------------------------------------------------------
        try {
          const response = await api.createSizeChart(chartCreatePayload(chart));
          chart = applyChartResponse(chart, response);
          working[chartIndex] = chart;
          updated = true;
        } catch (err) {
          const errors = chartValidationErrors(err, chartIndex, chart);
          if (errors === null) throw err;
          validationErrors.push(...errors);
        }
        continue;
      }

      // ---- Update: name first, then per-row diffs (legacy order) ---------
      const chartId = chart.id;
      const storedChart = stored.find((c) => c.id === chartId) ?? null;
      let chartFailed = false;

      if (storedChart == null || storedChart.nome !== chart.nome) {
        try {
          const response = await api.updateSizeChartName(chartId, {
            [chartSiteId(chart)]: chart.nome ?? '',
          });
          chart = applyChartResponse(chart, response);
          working[chartIndex] = chart;
          updated = true;
        } catch (err) {
          const errors = chartValidationErrors(err, chartIndex, chart);
          if (errors === null) throw err;
          validationErrors.push(...errors);
          // Legacy: a rejected rename reverts to the stored nome and the
          // chart's remaining changes are skipped this round.
          if (storedChart?.nome != null) chart = { ...chart, nome: storedChart.nome };
          working[chartIndex] = chart;
          chartFailed = true;
        }
      }

      if (!chartFailed) {
        const rows = chart.rows ?? [];
        const storedRows = storedChart?.rows ?? [];
        for (let index = 0; index < rows.length; index += 1) {
          const row = chart.rows![index]!;
          const storedRow = storedRows[index] ?? null;
          if (!rowNeedsSend(row, storedRow)) continue;

          try {
            const response =
              row.id != null && row.id !== ''
                ? await api.updateSizeChartRow(chartId, row.id, chartRowPayload(chart, row))
                : await api.addSizeChartRow(chartId, chartRowPayload(chart, row));
            chart = applyChartResponse(chart, response);
            working[chartIndex] = chart;
            updated = true;
          } catch (err) {
            const errors = chartValidationErrors(err, chartIndex, chart, index);
            if (errors === null) throw err;
            validationErrors.push(...errors);
            break; // legacy: stop this chart's rows, continue with the next chart
          }
        }
      }
    }
  } catch (err) {
    // A hard error (429/5xx/network) aborts the sync, but the ids already
    // obtained MUST land on the doc first — otherwise a created chart is
    // orphaned on ML and every retry dies on `chart_name_unavailable`.
    await persistProgress();
    throw err;
  }

  await persistProgress();
  return { tabelas: working, validationErrors, updated };
}
