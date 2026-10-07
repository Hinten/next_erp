/**
 * One immediately saved chart/version, diffed against Mercado Livre. The
 * operation journal serializes sends and retains every remote receipt; a
 * transaction guards only the target chart when progress is written back.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreValidationError,
  type MlSizeChartApi,
} from '@delfrance/integrations-mercado-livre';
import { localizarDecimal } from '@delfrance/core/decimal';
import { valuesEqual } from '@delfrance/core';
import { wireInt } from '@delfrance/core/wire';
import type { MlAttributeWire, MlSizeChart, MlSizeChartRow } from '@delfrance/schemas';
import { mlSizeChartSyncRequestSchema } from '@delfrance/schemas';
import { z } from 'zod';
import type { MlChartOperation } from '@delfrance/data/admin/collections';
import {
  acquireOperation,
  checkpointOperation,
  operationContext,
  operationCharts,
  chartConflict,
  chartUnconfirmed,
  SizeChartOperationError,
} from './sizeChartOperation';
export { TabelaDeMedidasNotFoundError } from './sizeChartOperation';

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
  operationId: string;
  chartIndex: number;
  status: MlChartOperation['status'];
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

const responseAttributesSchema = z.array(
  z
    .object({
      id: z.string(),
      values: z.array(
        z
          .object({
            id: z.union([z.string(), z.number()]).nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
);

/** Compare ONLY desired writable attributes; computed SIZE and ERP joins are not writes. */
export function remoteRowMatches(
  chart: MlSizeChart,
  row: MlSizeChartRow,
  remote: { attributes?: unknown },
): boolean {
  const desired = responseAttributesSchema.parse(chartRowPayload(chart, row).attributes);
  const parsed = responseAttributesSchema.safeParse(remote.attributes);
  if (!parsed.success) return desired.length === 0;
  return desired.every((attribute) => {
    const current = parsed.data.find((a) => a.id === attribute.id);
    return (
      current != null &&
      attribute.values.length === current.values.length &&
      attribute.values.every((value, index) => {
        const other = current.values[index]!;
        // ML can fill the display name for an id-only picker. Its ID is the value.
        if (value.id != null && String(value.id) !== String(other.id)) return false;
        const spelling = (name: string) => {
          const space = name.lastIndexOf(' ');
          return space < 0
            ? localizarDecimal(name)
            : `${localizarDecimal(name.slice(0, space))}${name.slice(space)}`;
        };
        return (
          value.name == null ||
          (other.name != null && spelling(value.name) === spelling(other.name))
        );
      })
    );
  });
}

function sameRowId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  const first = String(a);
  const second = String(b);
  return first.includes(':') && second.includes(':')
    ? first === second
    : first.split(':').pop() === second.split(':').pop();
}

/** Created rows join by their immutable main value, never response array position. */
export function reconcileChartResponse(chart: MlSizeChart, response: MlSizeChartApi): MlSizeChart {
  const rows = (chart.rows ?? []).map((row) => {
    const matching = (response.rows ?? []).filter((remote) => {
      if (row.id) return sameRowId(row.id, remote.id);
      const main = (row.attributes ?? []).find((a) => a.id === chart.main_attribute_id);
      if (!main) return false;
      const attributes = responseAttributesSchema.safeParse(remote.attributes);
      if (!attributes.success) return false;
      const values = attributes.data.find((a) => a.id === main.id)?.values ?? [];
      const desired = responseAttributesSchema.parse([chartAttributeToMercadoLivre(main)])[0]!
        .values;
      return (
        desired.length === values.length &&
        desired.every((v, i) =>
          v.id != null ? String(v.id) === String(values[i]!.id) : v.name === values[i]!.name,
        )
      );
    });
    if (matching.length !== 1 || matching[0]!.id == null) throw chartUnconfirmed();
    const remote = matching[0]!;
    if (String(remote.id).includes(':') && !String(remote.id).startsWith(`${response.id}:`))
      throw chartUnconfirmed();
    const id = String(remote.id).includes(':') ? String(remote.id) : `${response.id}:${remote.id}`;
    const computed = responseRowSize(remote);
    return { ...row, id, ...(computed ? { sizeCalculado: computed } : {}) };
  });
  return {
    ...chart,
    id: String(response.id),
    rows,
    main_attribute_id: response.main_attribute_id ?? chart.main_attribute_id ?? null,
  };
}

function assertRemoteChart(chart: MlSizeChart, response: MlSizeChartApi): void {
  if (chart.id && String(response.id) !== chart.id) throw chartUnconfirmed();
  if (response.site_id != null && response.site_id !== chartSiteId(chart)) throw chartUnconfirmed();
}

/** One guarded saved chart; local desired content is NEVER the remote diff baseline. */
export async function syncSizeCharts(
  deps: SizeChartSyncDeps,
  tabMediId: string,
  input: unknown,
): Promise<SyncSizeChartsResult> {
  const request = mlSizeChartSyncRequestSchema.parse(input);
  const ctx = operationContext(deps.db, tabMediId, deps.integracaoId);
  let op = await acquireOperation(ctx, request.operationId, request.chartIndex, request.chart);
  const result = async (): Promise<SyncSizeChartsResult> => {
    const tabelas = await operationCharts(ctx);
    if (!valuesEqual(tabelas[op.chartIndex], op.projected)) throw chartConflict();
    return {
      operationId: op.id,
      chartIndex: op.chartIndex,
      status: op.status,
      tabelas,
      validationErrors: op.validationErrors,
      updated: op.updated,
    };
  };
  if (op.status === 'completed' || op.status === 'validation') return result();
  if (op.status === 'conflict') throw chartConflict();

  async function receipt(response: MlSizeChartApi, created = false): Promise<void> {
    assertRemoteChart(op.projected, response);
    // Record the provider's receipt before interpretation or local write-back.
    // Even an incomplete 2xx response now retains the returned chart/row IDs.
    op = await checkpointOperation(
      ctx,
      op,
      { baseline: response as Record<string, unknown> },
      true,
    );
    if (op.status === 'conflict') throw chartConflict();
    // Existing id-less rows not yet posted must remain drafts. A create response
    // maps all rows, whereas an update maps only known IDs and the posted row.
    const chart = {
      ...op.projected,
      main_attribute_id: response.main_attribute_id ?? op.projected.main_attribute_id ?? null,
    };
    const selected = (chart.rows ?? []).filter(
      (row, index) => created || !!row.id || index === op.pending?.rowIndex,
    );
    const reconciled = reconcileChartResponse({ ...chart, rows: selected }, response);
    let cursor = 0;
    const rows = (chart.rows ?? []).map((row, index) =>
      created || !!row.id || index === op.pending?.rowIndex ? reconciled.rows![cursor++]! : row,
    );
    const confirmed = { ...reconciled, rows };
    if (
      created &&
      (!(confirmed.rows ?? []).every((row) =>
        remoteRowMatches(confirmed, row, response.rows!.find((r) => sameRowId(r.id, row.id))!),
      ) ||
        response.names?.[chartSiteId(chart)] !== chart.nome)
    )
      throw chartUnconfirmed();
    if (op.pending?.kind === 'rename' && response.names?.[chartSiteId(chart)] !== chart.nome)
      throw chartUnconfirmed();
    if (op.pending?.kind === 'row') {
      const row = confirmed.rows![op.pending.rowIndex!]!;
      const remote = response.rows!.find((r) => sameRowId(r.id, row.id));
      if (!remote || !remoteRowMatches(confirmed, row, remote)) throw chartUnconfirmed();
    }
    op = await checkpointOperation(
      ctx,
      op,
      {
        projected: confirmed,
        baseline: response as Record<string, unknown>,
        pending: null,
        updated: true,
      },
      true,
    );
    if (op.status === 'conflict') throw chartConflict();
  }

  try {
    // A pending step means the previous process may have died AFTER ML accepted
    // it. Never blindly replay a creation, including a failed receipt commit.
    if (op.pending != null) {
      if (op.pending.kind === 'create') {
        const knownId = op.baseline?.id;
        const recoveryId =
          request.recoveryChartId ??
          (typeof knownId === 'string' || typeof knownId === 'number' ? String(knownId) : null);
        if (!recoveryId) throw chartUnconfirmed();
        const remote = await deps.api.getSizeChart(recoveryId);
        const me = await deps.api.getMe();
        if (
          wireInt().safeParse(remote.seller_id).data !== me.id ||
          remote.names?.[chartSiteId(op.projected)] !== op.projected.nome ||
          remote.domain_id !== op.projected.domain_id?.split('-').slice(1).join('-') ||
          (remote.rows ?? []).length !== (op.projected.rows ?? []).length ||
          (op.projected.tipo != null && remote.measure_type !== op.projected.tipo) ||
          !remoteRowMatches(
            op.projected,
            { id: null, attributes: op.projected.attributes },
            { attributes: remote.attributes },
          )
        )
          throw chartUnconfirmed();
        const recovered = reconcileChartResponse(
          { ...op.projected, main_attribute_id: remote.main_attribute_id },
          remote,
        );
        if (
          !(recovered.rows ?? []).every((row) =>
            remoteRowMatches(recovered, row, remote.rows!.find((r) => sameRowId(r.id, row.id))!),
          )
        )
          throw chartUnconfirmed();
        await receipt(remote, true);
      } else {
        const remote = await deps.api.getSizeChart(op.projected.id!);
        assertRemoteChart(op.projected, remote);
        if (op.pending.kind === 'row' && !op.projected.rows?.[op.pending.rowIndex!]?.id) {
          // Unknown row POST: a unique main-value match can recover its ID.
          await receipt(remote);
        } else {
          op = await checkpointOperation(ctx, op, {
            pending: null,
            baseline: remote as Record<string, unknown>,
          });
        }
      }
    }

    if (op.projected.id) {
      await checkpointOperation(ctx, op, {});
      const remote = await deps.api.getSizeChart(op.projected.id);
      assertRemoteChart(op.projected, remote);
      op = await checkpointOperation(ctx, op, { baseline: remote as Record<string, unknown> });
    }

    async function send(
      kind: 'create' | 'rename' | 'row',
      rowIndex: number | null,
      call: () => Promise<MlSizeChartApi>,
    ) {
      op = await checkpointOperation(ctx, op, { pending: { kind, rowIndex } });
      // A transaction may itself have waited past the I/O budget. Do not
      // initiate a remote mutation based on a guard from before that wait.
      if (Date.now() >= ctx.deadlineMs || op.leaseUntilMs <= Date.now()) {
        op = await checkpointOperation(ctx, op, { pending: null }, false, true);
        throw new SizeChartOperationError(
          'CHART_BUSY',
          'O envio atingiu o limite de tempo. Tente novamente para retomar.',
        );
      }
      try {
        const response = await call();
        await receipt(response, kind === 'create');
      } catch (err) {
        const errors = chartValidationErrors(
          err,
          op.chartIndex,
          op.projected,
          rowIndex ?? undefined,
        );
        if (errors == null) {
          // A deterministic 4xx rejected the request. Network/5xx/invalid 2xx
          // leave the journal pending because their remote outcome is unknown.
          if (err instanceof MercadoLivreHttpError && err.status >= 400 && err.status < 500) {
            op = await checkpointOperation(ctx, op, { pending: null });
          }
          throw err;
        }
        op = await checkpointOperation(
          ctx,
          op,
          { pending: null, validationErrors: errors, status: 'validation' },
          false,
          true,
        );
      }
    }

    if (!op.projected.id) {
      await send('create', null, () => deps.api.createSizeChart(chartCreatePayload(op.projected)));
    } else {
      const remote = op.baseline as MlSizeChartApi;
      if (remote.names?.[chartSiteId(op.projected)] !== op.projected.nome) {
        await send('rename', null, () =>
          deps.api.updateSizeChartName(op.projected.id!, {
            [chartSiteId(op.projected)]: op.projected.nome ?? '',
          }),
        );
      }
      for (
        let index = 0;
        index < (op.projected.rows ?? []).length && op.status === 'pending';
        index++
      ) {
        const row = op.projected.rows![index]!;
        const baseline = op.baseline as MlSizeChartApi;
        const remoteRow = (baseline.rows ?? []).find((r) => sameRowId(r.id, row.id));
        if (row.id && remoteRow && remoteRowMatches(op.projected, row, remoteRow)) continue;
        if (row.id && !remoteRow) throw chartConflict();
        await send('row', index, () =>
          row.id
            ? deps.api.updateSizeChartRow(
                op.projected.id!,
                row.id,
                chartRowPayload(op.projected, row),
              )
            : deps.api.addSizeChartRow(op.projected.id!, chartRowPayload(op.projected, row)),
        );
      }
    }
    if (op.status === 'pending')
      op = await checkpointOperation(ctx, op, { status: 'completed' }, false, true);
    return result();
  } catch (err) {
    if (
      !(
        err instanceof MercadoLivreHttpError ||
        err instanceof MercadoLivreNetworkError ||
        err instanceof MercadoLivreValidationError ||
        err instanceof SizeChartOperationError
      )
    )
      throw err;
    // Always release the worker, but retain an uncertain creation's reservation.
    if (op.owner === ctx.owner)
      op = await checkpointOperation(
        ctx,
        op,
        { status: op.pending ? 'unconfirmed' : 'pending' },
        false,
        true,
      );
    throw err;
  }
}
