'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type FieldValues } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { z, ZodObject, ZodRawShape } from 'zod';
import {
  type CollectionHandle,
  type PathContext,
} from '@delfrance/data';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { extractFieldsFromSchema } from '../schema/derive';
import type { FieldConfig, FieldDescriptor } from '../schema/types';
import { FieldPicker } from './FieldPicker';
import { FieldRenderer } from './FieldRenderer';
import { RecordPager } from './RecordPager';
import { SectionTabs } from './SectionTabs';
import { NothingChangedError, saveRecord } from './saveRecord';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

export interface ObjectViewProps<S extends ZodObject<ZodRawShape>> {
  title?: ReactNode;
  description?: ReactNode;
  schema: S;
  collection: CollectionHandle<S>;
  db: Firestore;
  pathContext?: PathContext;

  /** undefined ⇒ create mode. */
  recordId?: string;
  defaultValues?: Partial<z.infer<S>>;

  /** Hide these field keys completely (e.g. embeddings). */
  excludedFields?: string[];
  /** Per-field overrides. */
  fields?: Record<string, FieldConfig>;
  /** Section names → renders a Mantine tabs view. Omit for a flat layout. */
  sections?: string[];

  /** Auth uid for the audit entry. */
  currentUserUid: string;

  /** Optional cross-record pager (caller owns the id list). */
  pager?: {
    ids: string[];
    current: string;
    onChange: (id: string) => void;
  };

  /** Called after a successful save with the doc's id. */
  onSaved?: (id: string) => void;
  saveLabel?: string;
  /** Show a secondary "Salvar e continuar" button. Default true. */
  showSaveAndContinue?: boolean;
}

/**
 * Generic ObjectView. Loads a doc via `useDocSnapshot`, drives RHF from the
 * schema, and saves through `saveRecord` (transaction + audit stub).
 *
 * Flow:
 *  - In update mode, only dirty fields are sent (Firestore-friendly).
 *  - "Salvar" without changes shows a yellow toast and skips the network.
 *  - Dirty form blocks tab close (beforeunload) and pager navigation.
 */
export function ObjectView<S extends ZodObject<ZodRawShape>>({
  title,
  description,
  schema,
  collection,
  db,
  pathContext = {},
  recordId,
  defaultValues,
  excludedFields = [],
  fields: fieldOverrides = {},
  sections,
  currentUserUid,
  pager,
  onSaved,
  saveLabel = 'Salvar',
  showSaveAndContinue = true,
}: ObjectViewProps<S>) {
  type Doc = z.infer<S>;

  const descriptors = useMemo(() => extractFieldsFromSchema(schema), [schema]);

  // Once a create-mode save lands, retain the new id so subsequent saves on
  // the same mount are treated as updates (partial patches).
  const [internalId, setInternalId] = useState<string | undefined>(recordId);
  useEffect(() => setInternalId(recordId), [recordId]);

  const docRef = useMemo(
    () => (internalId ? collection.docRef(db, pathContext, internalId) : null),
    // pathContext intentionally identity-tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, collection, internalId],
  );
  const docSnap = useDocSnapshot<Doc>(docRef);

  // FieldPicker visibility — local state, not persisted. Initialize once
  // from the descriptor list; consumers that need a re-derive can remount
  // the ObjectView with a different `key` prop.
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() =>
    new Set(
      descriptors
        .filter((d) => !excludedFields.includes(d.key))
        .filter((d) => !fieldOverrides[d.key]?.hidden)
        .map((d) => d.key),
    ),
  );

  const form = useForm<FieldValues>({
    resolver: zodResolver(schema as never),
    defaultValues: (defaultValues ?? {}) as FieldValues,
    mode: 'onBlur',
  });

  // When the doc loads (or the record id changes), reset the form to the
  // loaded values. RHF needs `reset()` to also zero out `dirtyFields`.
  useEffect(() => {
    if (docSnap.data) {
      form.reset(docSnap.data.data as FieldValues);
    } else if (!internalId) {
      form.reset((defaultValues ?? {}) as FieldValues);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSnap.data?.id]);

  const [submitError, setSubmitError] = useState<string | null>(null);
  useUnsavedChangesGuard(form.formState.isDirty);

  async function doSave(continueEditing: boolean) {
    setSubmitError(null);
    const values = form.getValues();
    try {
      const result = await saveRecord<S, Record<string, unknown>>({
        db,
        collection,
        pathContext,
        recordId: internalId,
        values: values as Record<string, unknown>,
        dirtyFields: form.formState.dirtyFields as Partial<Record<string, unknown>>,
        currentUserUid,
      });
      // Zero out dirty state while preserving current values.
      form.reset(values);
      // If we just created, retain the id so subsequent saves are updates.
      if (!internalId) setInternalId(result.id);
      if (continueEditing) {
        notifications.show({ color: 'green', message: 'Salvo.' });
      } else {
        onSaved?.(result.id);
      }
    } catch (err) {
      if (err instanceof NothingChangedError) {
        notifications.show({ color: 'yellow', message: err.message });
        return;
      }
      setSubmitError(err instanceof Error ? err.message : 'Falha ao salvar.');
    }
  }

  // RHF's handleSubmit runs validation first — we route both buttons through
  // it so zodResolver always gets to validate before saveRecord runs.
  const submitDefault = form.handleSubmit(() => doSave(false));
  const submitContinue = form.handleSubmit(() => doSave(true));

  function toggleField(key: string) {
    setVisibleKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visibleDescriptors = descriptors.filter((d) => visibleKeys.has(d.key));

  // Group visible descriptors by section. When the caller didn't supply a
  // `sections` prop, render them flat (no tabs).
  const grouped = useMemo(() => {
    const map: Record<string, FieldDescriptor[]> = {};
    for (const d of visibleDescriptors) {
      const section = fieldOverrides[d.key]?.section ?? sections?.[0] ?? 'default';
      (map[section] ??= []).push(d);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDescriptors, fieldOverrides, sections?.join('|')]);

  function fieldsBlock(descs: FieldDescriptor[]) {
    return (
      <Stack>
        {descs.map((d) => (
          <FieldRenderer
            key={d.key}
            control={form.control as never}
            descriptor={d}
            config={fieldOverrides[d.key]}
          />
        ))}
      </Stack>
    );
  }

  const loading = internalId && docSnap.loading;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submitDefault(); }}
    >
      <Stack>
        {(title || description) && (
          <Stack gap={2}>
            {title && (typeof title === 'string' ? <Title order={2}>{title}</Title> : title)}
            {description && <Text c="dimmed" size="sm">{description}</Text>}
          </Stack>
        )}

        <Group justify="space-between">
          {pager ? (
            <RecordPager
              ids={pager.ids}
              current={pager.current}
              onChange={pager.onChange}
              confirmNavigation={form.formState.isDirty ? () => false : undefined}
            />
          ) : <span />}
          <FieldPicker
            fields={descriptors.filter((d) => !excludedFields.includes(d.key))}
            visibleKeys={visibleKeys}
            onToggle={toggleField}
          />
        </Group>

        {loading && <Stack><Skeleton height={42} /><Skeleton height={42} /></Stack>}

        {!loading && (
          sections && sections.length > 0 ? (
            <SectionTabs
              sections={sections}
              contents={Object.fromEntries(
                sections.map((s) => [s, fieldsBlock(grouped[s] ?? [])]),
              )}
            />
          ) : fieldsBlock(grouped['default'] ?? visibleDescriptors)
        )}

        {submitError && <Alert color="red">{submitError}</Alert>}

        <Group justify="flex-end">
          {showSaveAndContinue && (
            <Button
              type="button"
              variant="default"
              loading={form.formState.isSubmitting}
              onClick={() => void submitContinue()}
            >
              Salvar e continuar
            </Button>
          )}
          <Button type="submit" loading={form.formState.isSubmitting}>
            {saveLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
