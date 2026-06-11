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
import { useForm, type FieldErrors, type FieldValues } from 'react-hook-form';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { ZodError, type z, type ZodObject, type ZodRawShape } from 'zod';
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
   * `FirebaseError` rejections surface in the form's error alert; any other
   * error propagates — catch domain errors inside the callback.
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
    // Apply per-field save-time transforms (e.g. the staged-deletion convention:
    // `prepareForSave: stripMarkedForDeletion` drops items marked for removal).
    // We reset the form to these transformed values on success so the UI
    // reflects what was actually persisted.
    const raw = form.getValues() as Record<string, unknown>;
    const values: Record<string, unknown> = { ...raw };
    const isUpdate = !!internalId;
    const dirty = form.formState.dirtyFields as Record<string, unknown>;
    for (const [key, cfg] of Object.entries(fieldOverrides)) {
      if (!cfg?.prepareForSave) continue;
      // Only transform fields that will actually be written — all fields on
      // create, just the dirty ones on update — so `form.reset(values)` can't
      // show a transformed value that never reached Firestore.
      if (isUpdate && !dirty[key]) continue;
      values[key] = cfg.prepareForSave(raw[key]);
    }
    try {
      const result = await saveRecord<S, Record<string, unknown>>({
        db,
        collection,
        pathContext,
        recordId: internalId,
        values,
        dirtyFields: form.formState.dirtyFields as Partial<Record<string, unknown>>,
        currentUserUid,
      });
      // Zero out dirty state while preserving the persisted (transformed) values.
      form.reset(values as typeof raw);
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
      if (err instanceof FirebaseError) {
        setSubmitError(err.message);
        return;
      }
      // Create mode runs the converter's `schema.parse` before the write —
      // e.g. unknown keys copied from a legacy doc.
      if (err instanceof ZodError) {
        setSubmitError(`Dados inválidos: ${err.issues.map((i) => i.message).join('; ')}`);
        return;
      }
      // Anything else is a bug, not a save failure — surface it loudly as an
      // unhandled rejection instead of masking it behind a generic message.
      throw err;
    }
  }

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

  // Reverse of `grouped`: top-level field key → section name, for mapping
  // validation errors to tabs. RHF nests sub-field errors under the
  // top-level key, so this level is enough.
  const sectionOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const [section, descs] of Object.entries(grouped)) {
      for (const d of descs) map.set(d.key, section);
    }
    return map;
  }, [grouped]);

  // Active tab is owned here (not by SectionTabs) so an invalid submit can
  // jump to the first erroring tab. Derived with a fallback instead of a
  // reset effect, so a `sections` prop change can't strand a stale value.
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const firstSection = sections?.[0];
  const effectiveSection =
    firstSection !== undefined
      ? activeSection && sections?.includes(activeSection)
        ? activeSection
        : firstSection
      : null;

  // Tabs containing invalid fields. Computed inline on purpose: RHF mutates
  // `formState.errors` in place, so it's not a usable memo dependency —
  // reading it during render subscribes via the formState proxy (the same
  // mechanism behind the `isDirty` / `isSubmitting` reads elsewhere).
  const errorSections = new Set<string>();
  if (firstSection !== undefined) {
    for (const key of Object.keys(form.formState.errors)) {
      const section = sectionOf.get(key);
      if (section) errorSections.add(section);
    }
  }

  // Invalid submit. Without this, an error on a non-active tab is silent:
  // RHF blocks the save and the inline message sits in a hidden panel. Jump
  // to the first erroring tab and name the offenders in a toast. RHF's
  // `shouldFocusError` runs before the tab switch renders, so focusing a
  // field in a still-hidden panel is a no-op — cosmetic, accepted.
  function onInvalid(errors: FieldErrors) {
    const errorKeys = Object.keys(errors);
    if (!sections || sections.length === 0) {
      notifications.show({
        color: 'red',
        message: 'Corrija os campos inválidos antes de salvar.',
      });
      return;
    }
    // Erroring sections in display order. zodResolver reports the full error
    // set, so fields hidden or excluded from the form can error too — they
    // have no tab to point at and are named separately.
    const erroring = sections.filter((s) => errorKeys.some((k) => sectionOf.get(k) === s));
    const outside = errorKeys.filter((k) => !sectionOf.has(k));
    const first = erroring[0];
    if (first === undefined) {
      notifications.show({
        color: 'red',
        message: `Não foi possível salvar: campos inválidos fora do formulário (${outside.join(', ')}).`,
      });
      return;
    }
    if (!effectiveSection || !erroring.includes(effectiveSection)) {
      setActiveSection(first);
    }
    const inTabs =
      erroring.length === 1
        ? `Corrija os campos inválidos na aba "${first}".`
        : `Corrija os campos inválidos nas abas: ${erroring.join(', ')}.`;
    notifications.show({
      color: 'red',
      message:
        outside.length > 0
          ? `${inTabs} Há também campos inválidos fora do formulário (${outside.join(', ')}).`
          : inTabs,
    });
  }

  // RHF's handleSubmit runs validation first — we route both buttons through
  // it so zodResolver always gets to validate before saveRecord runs.
  const submitDefault = form.handleSubmit(() => doSave(false), onInvalid);
  const submitContinue = form.handleSubmit(() => doSave(true), onInvalid);

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
      if (err instanceof FirebaseError) {
        setSubmitError(err.message);
        return;
      }
      // `onDelete` is caller-supplied — domain errors belong to the caller.
      throw err;
    }
  }

  const loading = internalId && docSnap.loading;

  // In genuine edit mode (a `recordId` was supplied) surface load errors and
  // missing documents instead of rendering an empty, un-saveable form — saving
  // would throw on `tx.update` for a non-existent doc. Gated on `recordId`, not
  // `internalId`, so a freshly-created record (whose snapshot may briefly be
  // empty right after the create save) never flashes "não encontrado".
  const editingExisting = recordId !== undefined;
  const loadError = editingExisting ? docSnap.error : null;
  const notFound = editingExisting && !docSnap.loading && !docSnap.data;
  const blocked = Boolean(loadError) || notFound;

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

        {!loading && loadError && <Alert color="red">{loadError.message}</Alert>}

        {!loading && !loadError && notFound && (
          <Alert color="yellow">Registro não encontrado.</Alert>
        )}

        {!loading &&
          !blocked &&
          (sections && sections.length > 0 ? (
            <SectionTabs
              sections={sections}
              contents={Object.fromEntries(sections.map((s) => [s, fieldsBlock(grouped[s] ?? [])]))}
              value={effectiveSection}
              onChange={setActiveSection}
              errorSections={errorSections}
            />
          ) : (
            fieldsBlock(grouped['default'] ?? visibleDescriptors)
          ))}

        {submitError && <Alert color="red">{submitError}</Alert>}

        <Group justify="space-between">
          {deleteVisible && internalId && !blocked ? (
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
            {editingAllowed && !blocked && showSaveAndContinue && (
              <Button
                type="button"
                variant="default"
                loading={form.formState.isSubmitting}
                onClick={() => void submitContinue()}
              >
                Salvar e continuar
              </Button>
            )}
            {editingAllowed && !blocked && (
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
