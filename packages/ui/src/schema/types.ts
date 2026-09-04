import type { ReactNode } from 'react';
import type { MantineColor } from '@mantine/core';
import type { z, ZodTypeAny } from 'zod';
import type { PipelineFilterOp } from '@delfrance/data';
import type { SnapshotRow } from '@delfrance/data/hooks';

/**
 * Discrete renderer "kind" a field maps to. Drives both cell renderers in
 * the TableView and input renderers in the ObjectView.
 */
export type FieldKind =
  | 'string'
  | 'longText'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'integer'
  | 'currency'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'datetime'
  | 'reference'
  | 'array'
  | 'object'
  | 'unknown';

export interface FieldDescriptor {
  /** Top-level key inside the Zod object. */
  key: string;
  kind: FieldKind;
  optional: boolean;
  nullable: boolean;
  /** Human label (from `.describe()` JSON, plain string, or humanized key). */
  label: string;
  hint?: string;
  /** Populated when `kind === 'enum'`. */
  enumValues?: Array<{ value: string; label: string }>;
  /**
   * Epoch unit for `kind === 'datetime'` (numeric-epoch fields built with
   * `millisSinceEpoch()` / `microsSinceEpoch()`). Drives the ×/÷1000 the date
   * picker and cell renderer apply when converting to/from a `Date`.
   */
  dateUnit?: 'ms' | 'us';
  /** Collection name for references (parsed from describe JSON). */
  referenceCollection?: string;
  /** Original Zod type (unwrapped — not the optional/nullable wrapper). */
  zodType: ZodTypeAny;
}

/**
 * The subset of a `FieldDescriptor` the per-column filter UI + URL parser
 * actually read. A full `FieldDescriptor` satisfies it structurally, and a
 * virtual column can synthesize one (e.g. for a nested path like
 * `freteInicial.estado`) without a real Zod descriptor.
 */
export type FilterableField = Pick<
  FieldDescriptor,
  'key' | 'kind' | 'label' | 'enumValues' | 'dateUnit'
>;

/**
 * A single column filter — the value emitted by a ColumnFilter / virtual
 * filter and pushed to the Pipeline `where` (or applied client-side on the
 * fallback path). Subcollection-lookup filters (e.g. the pedido NF column)
 * encode their chosen child field inside `value` as `"<subfield>:<term>"` so
 * the whole filter round-trips through the URL sync unchanged.
 *
 * The LIST form is exclusively for `array-contains-any` (membership of a
 * document array against several candidates) — the same contract
 * `PipelineFieldFilter.value` states, so a filter entry spreads straight into
 * the pipeline `where`. Every other op takes a scalar, and an EMPTY list means
 * "no rows": `buildPipeline` throws on it rather than querying, so a caller
 * emitting one must short-circuit (see the TableView guard) or, better, emit
 * `undefined` and drop the filter entirely.
 */
export interface ColumnFilterValue {
  op: PipelineFilterOp;
  value: string | number | boolean | null | ReadonlyArray<string>;
}

/**
 * Props passed to a custom `renderInput`. The form integration is opaque to
 * the consumer: receive `value`/`onChange`/`error` and render any widget.
 */
export interface FieldRenderProps {
  name: string;
  label: string;
  hint?: string;
  value: unknown;
  onChange: (next: unknown) => void;
  onBlur: () => void;
  disabled?: boolean;
  error?: string;
  /**
   * Raw RHF error node for this field. For array fields it is a sparse array
   * of per-row error maps (`errorTree[i].cepInicial.message`, plus an
   * optional `root`); for object fields a map of per-key errors. The flat
   * `error` string above only carries the field's OWN message — custom
   * editors of composite values read row/child messages from here.
   */
  errorTree?: unknown;
  descriptor: FieldDescriptor;
}

export interface FieldConfig<TValue = unknown> {
  label?: string;
  hint?: string;
  /** Override the inferred kind. Useful for `z.string()` that is actually a URL. */
  kind?: FieldKind;
  /** Override or supply enum options (overrides `descriptor.enumValues`). */
  options?: Array<{ value: string; label: string }>;
  /** ObjectView section/tab grouping. */
  section?: string;
  /**
   * Drop this field from the RENDERED surface — the value itself is untouched.
   * In `ObjectView` it renders no input but is still validated (its errors
   * surface through `hiddenErrors`) and still SAVED, `prepareForSave` included;
   * in `TableView` it is neither rendered NOR offered by the ColumnPicker —
   * "not a column at all", not "off by default" (use
   * `meta.defaultQuery.columns` / `defaultColumns` for that). The two
   * TableView lists that must agree on it are `visibleColumns` and
   * `pickerFields`; honouring it in only one of them is a checkbox that ticks,
   * persists and renders nothing.
   *
   * ⚠️ It does NOT narrow the query, so it is the wrong tool for COST.
   * `selectFields` derives the Pipelines `select()` projection from
   * `visibleKeys`, which still carries the hidden key — the field is fetched
   * and billed while rendering nowhere. To stop paying for a heavy field, drop
   * it from `defaultQuery.columns` / `defaultColumns` as well (root
   * `CLAUDE.md` rule 1: Enterprise bills data SCANNED).
   */
  hidden?: boolean;
  editable?: boolean;
  renderCell?: (value: TValue, row: unknown) => ReactNode;
  renderInput?: (props: FieldRenderProps) => ReactNode;
  /**
   * Transform this field's value immediately before it is written on save
   * (create or update). The app convention is staged deletion: an editor field
   * marks items for removal in-place (see `DELETE_MARK`) and `prepareForSave`
   * (e.g. `stripMarkedForDeletion`) drops them + strips the transient marker at
   * save time, so nothing is destroyed until the user saves. Must be pure.
   *
   * Honoured at any depth: declared on a sub-field under `fields`, it runs for
   * that sub-field's value (#870). A parent's transform runs BEFORE its own
   * descendants', so the more specific config wins for its own key. On update
   * the dirty gate is per TOP-LEVEL key — Firestore replaces a nested object
   * wholesale, so a dirty parent normalizes ALL of its sub-fields, and a
   * pristine parent normalizes none. A `null` parent (a nullable object whose
   * Switch is off) is skipped, never materialized.
   */
  prepareForSave?: (value: TValue) => unknown;
  /**
   * Per-field overrides for the sub-fields of a `kind: 'object'` field.
   * Keyed by the nested key (e.g. `sede.cpf_cnpj` → `{ cpf_cnpj: {...} }`).
   * Lets callers hide/relabel address fields without flattening the schema.
   *
   * What a nested entry actually does: `label`, `hint`, `kind`, `options`,
   * `hidden`, `editable` and `renderInput` are honoured by `FieldRenderer`, and
   * `prepareForSave` by `ObjectView`'s save + resolver pipeline. `defaultValue`
   * is honoured only when the nested entry is ITSELF a nullable
   * `kind: 'object'` field — its one consumer repo-wide is the Switch's
   * `seedObject`, so on a leaf it is inert. `section` and `renderCell` are
   * top-level-only: the first groups TOP-LEVEL fields into tabs, the second
   * belongs to `TableView`, which has no nested surface.
   *
   * ⚠️ One asymmetry, in the opposite direction to the one #870 fixed. When the
   * PARENT declares a `renderInput`, `FieldRenderer` skips its nested branch
   * entirely (`kind === 'object' && !config?.renderInput`) and never reads
   * `fields` — the custom widget owns the whole subtree. The `prepareForSave`
   * walk has no such gate, so under such a parent a nested transform still runs
   * while every rendering key above is ignored. That is deliberate: the
   * transform is about the VALUE being written, which the widget edits either
   * way, and gating it would silently drop it — the exact failure mode this
   * type's `prepareForSave` doc exists to rule out. Nothing in the repo pairs a
   * parent `renderInput` with `fields` today.
   */
  fields?: Record<string, FieldConfig>;
  /**
   * Seed merged over the schema's empty defaults when a NULLABLE
   * `kind: 'object'` field is toggled on (see the FieldRenderer nullable-object
   * Switch). Lets callers preset hidden sub-fields — e.g. a freight origin
   * address that should default to Brazil (`cPais: '1058'`, `pais: 'Brasil'`).
   * Ignored for non-nullable objects.
   */
  defaultValue?: Record<string, unknown>;
}

/**
 * Action declared by the TableView consumer. `requiresSelection: true`
 * disables the action until rows are checked. `refreshOnComplete: true`
 * marks a data-mutating action (e.g. delete) — the TableView re-runs its
 * query once after the action finishes.
 */
export interface ActionConfig<T> {
  id: string;
  label: string;
  color?: MantineColor;
  /**
   * Optional icon — rendered as the Menu.Item's leftSection when the
   * ActionBar collapses into the overflow menu. Ignored in inline layout
   * (inline buttons render label-only to keep the toolbar compact).
   */
  icon?: ReactNode;
  requiresSelection?: boolean;
  /**
   * When true and nothing is selected, if the table currently shows **exactly
   * one** visible row, treat that row as the selection (button stays enabled
   * and `run` receives it). Port of the Flutter InfiniteScrollingTableAction
   * perk used by Download Anexos (`intent.selected` empty + `intent.data.length
   * == 1`). Other bulk actions leave this off.
   */
  fallbackToSingleVisibleRow?: boolean;
  /**
   * Cap on how many checked rows the action accepts. Above it the button
   * disables and its `title` says why, so an over-wide selection is refused
   * up front instead of being silently truncated at `run` time.
   *
   * Set `1` for an action that is only meaningful one record at a time — e.g.
   * the Mercado Livre bulk jobs, which are minutes-long and quota-consuming
   * per account (#816). Leave unset for a genuine bulk action.
   */
  maxSelection?: number;
  refreshOnComplete?: boolean;
  run: (rows: SnapshotRow<T>[]) => Promise<void> | void;
  confirm?: { title: string; message: string };
}

/**
 * Helper alias used by call sites that need to type narrowing on a known
 * schema; mirrors `z.infer` semantics on the descriptor's payload.
 */
export type InferRow<T extends ZodTypeAny> = z.infer<T>;

/**
 * Filter backing for a virtual column. A virtual column has no Zod descriptor,
 * so it declares here the (possibly nested) document field it filters on plus
 * how to render the input. Provide EITHER `kind` (the generic ColumnFilter
 * input) OR `renderFilter` (a fully custom popover body, e.g. a picker).
 */
export interface VirtualColumnFilter {
  /** (Possibly nested) document path used in the server-side `where()`. */
  readonly field: string;
  /** Popover/affordance label (defaults to the column label). */
  readonly label?: string;
  /** Declarative input kind — drives the generic ColumnFilter + URL coercion. */
  readonly kind?: FieldKind;
  /** Enum choices when `kind === 'enum'`. */
  readonly options?: Array<{ value: string; label: string }>;
  /** Epoch unit when `kind === 'datetime'` (drives the date picker conversion). */
  readonly dateUnit?: 'ms' | 'us';
  /** Custom popover body — owns the filter UI and emits a `ColumnFilterValue`. */
  readonly renderFilter?: (props: {
    value: ColumnFilterValue | undefined;
    onChange: (next: ColumnFilterValue | undefined) => void;
  }) => ReactNode;
  /**
   * Render the CURRENT value as text, for the active-filter chip above the
   * table. Needed whenever the stored value is not self-describing — a
   * `renderFilter` that emits opaque ids (the produtos "Canais de venda"
   * filter stores bare integração ids) would otherwise be summarised as a bare
   * count. A `subcollectionLookup` filter gets a sensible default without
   * declaring this, from its own `fields` labels.
   */
  readonly formatValue?: (value: ColumnFilterValue['value']) => string;
  /**
   * Resolve this filter via a sibling subcollection (collection-group) lookup
   * rather than a direct `where()` on the listed collection: the emitted value's
   * `subfield` + `value` select which child field to match, the matching child
   * docs are mapped to their parent ids, and those ids constrain the main query.
   * Used by the pedido NF column (the `nfev4` subcollection holds `numeracao` /
   * `chave`, which are not on the pedido doc).
   */
  readonly subcollectionLookup?: {
    readonly subcollection: string;
    /**
     * Selectable child fields. `numeric: true` coerces the term to a number for
     * the equality match (e.g. `numeracao`); leave it off for string fields
     * like a 44-digit `chave`, which must NOT be parsed as a number.
     */
    readonly fields: ReadonlyArray<{ value: string; label: string; numeric?: boolean }>;
  };
}

/**
 * A column declared OUTSIDE the Zod schema — for cells whose value
 * is derived (computed from the row), async (subscribes to a sibling
 * subcollection), or dereferenced (follows an outer reference).
 *
 * Virtual columns interleave with schema-derived columns via the
 * TableView's `defaultColumns` prop: each key is resolved against
 * the schema first, then against `virtualColumns`. They appear in the
 * ColumnPicker so users can toggle visibility, and — when they declare
 * `sortField` / `filter` — render a sort handle and/or filter affordance
 * backed by a (possibly nested) document field.
 */
export interface VirtualColumn<T> {
  /** Stable identifier, used in `defaultColumns` ordering + ColumnPicker. */
  readonly key: string;
  readonly label: string;
  readonly tooltip?: string;
  /** Receives the full row (id + data) so renderers can subscribe / dereference. */
  readonly renderCell: (row: SnapshotRow<T>) => ReactNode;
  /** Optional width hint (CSS units or px number). */
  readonly width?: number | string;
  /**
   * Schema fields this cell reads from `row.data`. When every visible virtual
   * column declares `dependsOn`, TableView keeps Pipeline projection enabled
   * (`select` = visible schema columns ∪ all `dependsOn`), cutting payload.
   * OMIT (or leave any visible virtual column without it) to force a
   * full-document fetch — the safe default when a renderer reads arbitrary
   * fields. An empty array means "reads no schema field" (e.g. uses only
   * `row.id`).
   */
  readonly dependsOn?: ReadonlyArray<string>;
  /**
   * (Possibly nested) document field path to order by server-side. When set,
   * the header renders a sort toggle that issues `orderBy(sortField)` through
   * the Pipeline. Omit for a non-sortable column.
   */
  readonly sortField?: string;
  /** Per-column filter backing (see {@link VirtualColumnFilter}). */
  readonly filter?: VirtualColumnFilter;
}
