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
 */
export interface ColumnFilterValue {
  op: PipelineFilterOp;
  value: string | number | boolean | null;
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
   */
  prepareForSave?: (value: TValue) => unknown;
  /**
   * Per-field overrides for the sub-fields of a `kind: 'object'` field.
   * Keyed by the nested key (e.g. `sede.cpf_cnpj` → `{ cpf_cnpj: {...} }`).
   * Lets callers hide/relabel address fields without flattening the schema.
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
