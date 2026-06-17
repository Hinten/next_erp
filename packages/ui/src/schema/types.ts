import type { ReactNode } from 'react';
import type { MantineColor } from '@mantine/core';
import type { z, ZodTypeAny } from 'zod';
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
 * A column declared OUTSIDE the Zod schema — for cells whose value
 * is derived (computed from the row), async (subscribes to a sibling
 * subcollection), or dereferenced (follows an outer reference).
 *
 * Virtual columns interleave with schema-derived columns via the
 * TableView's `defaultColumns` prop: each key is resolved against
 * the schema first, then against `virtualColumns`. They render no
 * ColumnFilter (no descriptor → nothing to filter on) but DO appear
 * in the ColumnPicker so users can toggle visibility.
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
}
