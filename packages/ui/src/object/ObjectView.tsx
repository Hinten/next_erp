'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Button,
  Group,
  Modal,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type FieldValues } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { z, ZodObject, ZodRawShape } from 'zod';
import { type CollectionHandle, type PathContext } from '@delfrance/data';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { buildEmptyDefaults, extractFieldsFromSchema } from '../schema/derive';
import type { FieldConfig, FieldDescriptor } from '../schema/types';
import { FieldRenderer } from './FieldRenderer';
import { RecordPager } from './RecordPager';
import { SectionTabs } from './SectionTabs';
import { NothingChangedError, saveRecord } from './saveRecord';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

/**
 * Fields dropped from a copied source document — the new record must get its
 * own creation/modification stamps, not inherit the source's.
 */
const COPY_STRIP_KEYS = ['timestamp', 'ultimaModificacao'];

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

  /**
   * Hide save buttons. Pair with `readOnly` to also disable fields. When
   * `canEdit === false` and `readOnly` is unset, the form is interactive
   * but the user can't persist — useful for previewing changes. Default
   * true.
   */
  canEdit?: boolean;
  /**
   * Disable every field. Implies `canEdit: false` for the save buttons.
   * Default false.
   */
  readOnly?: boolean;
  /**
   * Delete the current record. Receives the doc id. When omitted, no
   * delete button is rendered. The button is also hidden when
   * `canDelete === false` or there's no `internalId` (create mode).
   */
  onDelete?: (id: string) => Promise<void>;
  /** Default 'Excluir'. */
  deleteLabel?: string;
  /** Hide delete button. Default true. */
  canDelete?: boolean;
  /**
   * Optional confirmation message shown before invoking `onDelete`. When
   * omitted, falls back to `window.confirm` with a generic message.
   */
  deleteConfirmMessage?: string;
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
  canEdit = true,
  readOnly = false,
  onDelete,
  deleteLabel = 'Excluir',
  canDelete = true,
  deleteConfirmMessage,
}: ObjectViewProps<S>) {
  const editingAllowed = !readOnly && canEdit;
  const deleteVisible = !!onDelete && canDelete;
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

  // Copy mode: in create mode, `?copyFrom=<id>` pre-fills the form from an
  // existing document. The id is the only thing carried across the redirect
  // (TableView projects only visible columns, so the row data is partial) —
  // re-fetch the full source document here.
  const searchParams = useSearchParams();
  const copyFromId = recordId ? null : searchParams.get('copyFrom');
  const copyDocRef = useMemo(
    () => (copyFromId ? collection.docRef(db, pathContext, copyFromId) : null),
    // pathContext intentionally identity-tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, collection, copyFromId],
  );
  const copySnap = useDocSnapshot<Doc>(copyDocRef);

  // Nullable fields default to `null` (not `undefined`) so Firestore's
  // converter doesn't reject them on save and Mantine's controlled inputs
  // get a stable initial value.
  const emptyDefaults = useMemo(() => buildEmptyDefaults(descriptors), [descriptors]);

  const form = useForm<FieldValues>({
    resolver: zodResolver(schema as never),
    defaultValues: { ...emptyDefaults, ...(defaultValues ?? {}) } as FieldValues,
    mode: 'onBlur',
  });

  // When the doc loads (or the record id changes), reset the form to the
  // loaded values. RHF needs `reset()` to also zero out `dirtyFields`.
  // Merge with emptyDefaults so docs missing nullable fields still get null
  // (instead of undefined leaking back through the patch on the next save).
  useEffect(() => {
    if (docSnap.data) {
      form.reset({ ...emptyDefaults, ...(docSnap.data.data as FieldValues) });
    } else if (!internalId) {
      form.reset({ ...emptyDefaults, ...(defaultValues ?? {}) } as FieldValues);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSnap.data?.id]);

  // Copy mode: once the source doc loads, seed the form with its values. The
  // document id never lives in the schema data, so it's already excluded;
  // creation/modification stamps are stripped so the new record gets fresh
  // ones. The page's `defaultValues` lose to the source (it's a clone).
  useEffect(() => {
    if (!copySnap.data || internalId) return;
    const source = { ...(copySnap.data.data as Record<string, unknown>) };
    for (const key of COPY_STRIP_KEYS) delete source[key];
    form.reset({
      ...emptyDefaults,
      ...(defaultValues ?? {}),
      ...source,
    } as FieldValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copySnap.data?.id]);

  const [submitError, setSubmitError] = useState<string | null>(null);
  // Delete confirmation modal: the user must type "excluir" to enable the
  // destructive button — guards against accidental clicks.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const deleteConfirmed = deleteText.trim().toLowerCase() === 'excluir';
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

  // Field visibility is a design-time decision (excludedFields / hidden in
  // fieldOverrides) — end users don't get a toggle. Build the list once.
  const visibleDescriptors = descriptors.filter(
    (d) => !excludedFields.includes(d.key) && !fieldOverrides[d.key]?.hidden,
  );

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
        {descs.map((d) => {
          // When the view is read-only, force `editable: false` regardless
          // of per-field config. Per-field `editable: false` still wins
          // when the caller marks a single column non-editable while the
          // rest of the form is editable.
          const override = fieldOverrides[d.key];
          const config: FieldConfig | undefined = readOnly
            ? { ...override, editable: false }
            : override;
          return (
            <FieldRenderer
              key={d.key}
              control={form.control as never}
              descriptor={d}
              config={config}
            />
          );
        })}
      </Stack>
    );
  }

  async function confirmDelete() {
    if (!onDelete || !internalId || !deleteConfirmed) return;
    setDeleteOpen(false);
    try {
      await onDelete(internalId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Falha ao excluir.');
    }
  }

  const loading = internalId && docSnap.loading;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submitDefault();
      }}
    >
      <Stack>
        {(title || description) && (
          <Stack gap={2}>
            {title && (typeof title === 'string' ? <Title order={2}>{title}</Title> : title)}
            {description && (
              <Text c="dimmed" size="sm">
                {description}
              </Text>
            )}
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
          ) : (
            <span />
          )}
        </Group>

        {copyFromId && copySnap.data && (
          <Alert color="blue">
            Registro pré-preenchido a partir de uma cópia. Revise os campos e clique em {saveLabel}{' '}
            para criar um novo registro.
          </Alert>
        )}

        {loading && (
          <Stack>
            <Skeleton height={42} />
            <Skeleton height={42} />
          </Stack>
        )}

        {!loading &&
          (sections && sections.length > 0 ? (
            <SectionTabs
              sections={sections}
              contents={Object.fromEntries(sections.map((s) => [s, fieldsBlock(grouped[s] ?? [])]))}
            />
          ) : (
            fieldsBlock(grouped['default'] ?? visibleDescriptors)
          ))}

        {submitError && <Alert color="red">{submitError}</Alert>}

        <Group justify="space-between">
          {deleteVisible && internalId ? (
            <Button
              type="button"
              color="red"
              variant="light"
              onClick={() => {
                setDeleteText('');
                setDeleteOpen(true);
              }}
            >
              {deleteLabel}
            </Button>
          ) : (
            <span />
          )}
          <Group>
            {editingAllowed && showSaveAndContinue && (
              <Button
                type="button"
                variant="default"
                loading={form.formState.isSubmitting}
                onClick={() => void submitContinue()}
              >
                Salvar e continuar
              </Button>
            )}
            {editingAllowed && (
              <Button type="submit" loading={form.formState.isSubmitting}>
                {saveLabel}
              </Button>
            )}
          </Group>
        </Group>
      </Stack>

      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Excluir registro"
        centered
      >
        <Stack>
          <Text size="sm">{deleteConfirmMessage ?? 'Esta ação não pode ser desfeita.'}</Text>
          <TextInput
            label='Digite "excluir" para confirmar'
            value={deleteText}
            onChange={(e) => setDeleteText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && deleteConfirmed) {
                e.preventDefault();
                void confirmDelete();
              }
            }}
            autoFocus
          />
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={() => setDeleteOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              disabled={!deleteConfirmed}
              onClick={() => void confirmDelete()}
            >
              {deleteLabel}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </form>
  );
}
