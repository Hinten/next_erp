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
