'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
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
import {
  FormProvider,
  useForm,
  type FieldErrors,
  type FieldValues,
  type Resolver,
} from 'react-hook-form';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { ZodError, type z, type ZodObject, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { CollectionHandle, PathContext } from '@delfrance/data';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { buildEmptyDefaults, extractFieldsFromSchema } from '../schema/derive';
import type { FieldConfig, FieldDescriptor } from '../schema/types';
import { AfterSaveBlockedError } from './afterSaveBlocked';
import { ConflictModal } from './ConflictModal';
import { buildConflictFields, labelFromShape } from './conflictFields';
import { valuesEqual } from './diff';
import { FieldRenderer } from './FieldRenderer';
import { ObjectViewSectionsProvider, type ObjectViewSections } from './ObjectViewSectionsContext';
import { RecordPager } from './RecordPager';
import { SectionTabs } from './SectionTabs';
import { resolveStampFields, type StampFieldOverride } from './resolveStampFields';
import {
  NothingChangedError,
  RecordConflictError,
  saveRecord,
  type TransactionWrite,
} from './saveRecord';
import { useServerTruthSeed } from './useServerTruthSeed';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

export type { TransactionWrite };

/**
 * Synthetic error key for key-less (form-level / cross-field) validation
 * issues that have no field path. The `@` guarantees it can't collide with a
 * Zod field name (those are identifiers), and it's deliberately NOT RHF's
 * reserved `root` key, which RHF excludes from its submit-blocking validity
 * check. `describeOutside` / `hiddenErrors` surface it by its message.
 */
const FORM_LEVEL_ERROR_KEY = '@form';

/** A cross-document validation problem, keyed by a dotted field path. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ObjectViewProps<S extends ZodObject<ZodRawShape>, C extends ZodTypeAny = S> {
  title?: ReactNode;
  description?: ReactNode;
  /**
   * The schema that drives the FORM: the resolver, the field descriptors, and
   * the empty defaults. Usually the same as the collection's schema, but it may
   * be a wider **aggregate** (a page model) whose extra fields are validated and
   * rendered here yet persisted elsewhere — see `transientFields`. In that case
   * pass the collection's own (narrower) schema as `C` via `collection`.
   */
  schema: S;
  /**
   * The document collection this view writes. Its schema (`C`) governs the
   * converter + path; when `schema` (`S`) is a wider aggregate, only the keys
   * that belong to `C` (i.e. everything except `transientFields`) reach the doc.
   * Defaults to the same schema as the form (`C = S`).
   */
  collection: CollectionHandle<C>;
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
  /**
   * Sections whose content must stay FULLY mounted — effects included — while
   * another tab is active (see `SectionTabs`). Every other section keeps the
   * default: rendered but with its effects suspended until it is opened, so an
   * unvisited tab costs no listener and no fetch. Opt a section in only when it
   * holds work that a tab switch would destroy — an unsaved sub-form, an
   * in-flight request, a registered flush closure.
   */
  persistentSections?: readonly string[];

  /**
   * Derive additional top-level fields from the (already per-field
   * `prepareForSave`-transformed) values, immediately before save — e.g. a
   * denormalized array such as `variacoesIds` computed from `variacoes`. The
   * returned keys are merged into the written values; on update each is marked
   * dirty only when its value actually changed (structural comparison), so a
   * pristine save still skips via `NothingChangedError`. Keys whose derived
   * value is `undefined` are ignored — yield `null` to clear a field, never
   * `undefined` (Firestore rejects it). Must be pure.
   */
  deriveOnSave?: (values: Record<string, unknown>) => Record<string, unknown>;

  /**
   * Cross-document validation run alongside the schema resolver (after each
   * field's `prepareForSave`). Returns issues keyed by a dotted field path;
   * each is merged into the resolver errors at its path's first segment, so a
   * cross-document problem blocks the save and surfaces in the same per-tab
   * error UI as a schema error (route it to a tab by giving that key a
   * `section` in `fields`). The hook reads what's about to be saved plus any
   * page-held state the closure captures (e.g. subcollection editors), so the
   * whole page model can validate in one place. Must be pure; a real shape
   * error on a key always wins over a cross-document one. */
  validate?: (values: Record<string, unknown>) => readonly ValidationIssue[];

  /**
   * Top-level form keys that are validated + rendered like any field but are
   * NOT written to the document. They are stripped from the patch before
   * `saveRecord` (and from the dirty set, so a save that touched ONLY transient
   * fields still routes through `onAfterSave` via `NothingChangedError`), while
   * the FULL values — transient fields included — are handed to `onAfterSave`
   * so a sibling write can persist them (e.g. an aggregate page model whose
   * `extraData`/`estoques`/`impostos` live in their own subcollections). Use
   * with a wider `schema` (`S`) over a narrower `collection` (`C`).
   */
  transientFields?: string[];

  /**
   * Sibling documents to write ATOMICALLY with the main record, in the same
   * transaction (one commit, all-or-nothing). Called with the resolved record
   * id (the minted id on create) + the full post-transform values, so a
   * transient field's persistence (e.g. the `extraData` singleton) can ride the
   * produto-doc save instead of being a separate write that a flaky connection
   * could drop. Return converter-bound refs (built from a `defineCollection`
   * handle). Pairs with `transientFields`: those keys stay off the main doc but
   * are persisted here.
   */
  transactionWrites?: (id: string, values: Record<string, unknown>) => TransactionWrite[];

  /**
   * Turn the ADR 0011 **tier 3** concurrency guard off for this screen.
   *
   * On by default. Every ERP record has at least two writers — another operator
   * in another tab, and for many of them a trigger, a webhook or a scheduled
   * sweep — so a save that loses should say so rather than silently
   * revert the winner. When it fires, the operator gets the diff and chooses.
   *
   * Reach for this only when a screen genuinely cannot express its write as a
   * disjoint patch and the false conflicts outweigh the real ones. Prefer
   * {@link concurrencyIgnoreFields}, which silences a specific server-written
   * field instead of the whole screen.
   */
  disableConcurrencyGuard?: boolean;

  /**
   * Fields whose remote change must not raise a conflict — values the operator
   * could not have authored, so interrupting them over one is noise.
   *
   * The last-modified/creation stamps are handled already. Pass the domain's
   * server-written keys: a `<domain>Meta.serverOwnedFields`, or anything a
   * trigger writes back onto the record (`onProdutoChanged`'s `precos`
   * propagation onto a variation child is the motivating case).
   */
  concurrencyIgnoreFields?: string[];

  /**
   * Extra unsaved state OUTSIDE this form that the leave-guard must also
   * protect.
   *
   * A self-contained tab (one rendered through a `renderInput` that owns its
   * own editor and its own document) is invisible to `form.formState.isDirty`,
   * so without this the operator can navigate away from real pending edits and
   * lose them silently — the guard would report the page as clean because the
   * produto form is.
   *
   * ⚠️ The tab must NOT call `useUnsavedChangesGuard` itself. Two live guards
   * means two `confirm()` prompts and two sentinel history entries, because the
   * hook's document-level listener uses `stopPropagation`, which does not stop
   * other listeners on the same node.
   */
  extraDirty?: boolean;

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
  /**
   * Awaited after a successful save (both "Salvar" and "Salvar e continuar"),
   * before `onSaved`/the toast — the hook for sibling writes that belong to
   * the same user action (e.g. flushing staged child documents). A rejection
   * is shown in the form alert and skips `onSaved`; the main record is already
   * persisted at that point. It also runs when the record itself had nothing
   * to write (sibling edits don't dirty the form), in which case the action
   * still counts as a save instead of the "nothing changed" toast.
   *
   * Receives the transformed values heading into the save (post-`prepareForSave`
   * / `deriveOnSave`), so sibling writes can read exactly what was persisted
   * without a re-read race — e.g. the produto editor diffs `values.precos` for
   * its history records and child propagation.
   */
  onAfterSave?: (id: string, values: Record<string, unknown>) => Promise<void> | void;
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

  /**
   * Override auto-detect of the creation stamp field (`timestamp` /
   * `dataCadastro` / …). `false` disables create stamping. Default: first
   * candidate present on the schema descriptors.
   */
  createdAtField?: StampFieldOverride;
  /**
   * Override auto-detect of the last-modified stamp field
   * (`ultimaModificacao`). `false` disables. Default: auto from schema.
   */
  modifiedAtField?: StampFieldOverride;
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
export function ObjectView<S extends ZodObject<ZodRawShape>, C extends ZodTypeAny = S>({
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
  persistentSections,
  deriveOnSave,
  validate,
  transientFields = [],
  transactionWrites,
  disableConcurrencyGuard = false,
  concurrencyIgnoreFields,
  extraDirty = false,
  currentUserUid,
  pager,
  onSaved,
  onAfterSave,
  saveLabel = 'Salvar',
  showSaveAndContinue = true,
  canEdit = true,
  readOnly = false,
  onDelete,
  deleteLabel = 'Excluir',
  canDelete = true,
  deleteConfirmMessage,
  createdAtField: createdAtFieldProp,
  modifiedAtField: modifiedAtFieldProp,
}: ObjectViewProps<S, C>) {
  const editingAllowed = !readOnly && canEdit;
  const deleteVisible = !!onDelete && canDelete;
  // The document loaded/saved is the COLLECTION's shape (`C`), which may be
  // narrower than the form schema (`S`) when an aggregate page model adds
  // transient fields persisted elsewhere.
  type Doc = z.infer<C>;

  const descriptors = useMemo(() => extractFieldsFromSchema(schema), [schema]);
  // Creation / last-modified field names + epoch unit for saveRecord stamps.
  // Auto-detect from the schema; props override (or disable with `false`).
  const stampFields = useMemo(
    () =>
      resolveStampFields(descriptors, {
        createdAtField: createdAtFieldProp,
        modifiedAtField: modifiedAtFieldProp,
      }),
    [descriptors, createdAtFieldProp, modifiedAtFieldProp],
  );
  const copyStripKeys = useMemo(() => {
    const keys: string[] = [];
    if (stampFields.createdAtField) keys.push(stampFields.createdAtField);
    if (stampFields.modifiedAtField) keys.push(stampFields.modifiedAtField);
    return keys;
  }, [stampFields.createdAtField, stampFields.modifiedAtField]);

  // Once a create-mode save lands, retain the new id so subsequent saves on
  // the same mount are treated as updates (partial patches).
  const [internalId, setInternalId] = useState<string | undefined>(recordId);
  useEffect(() => setInternalId(recordId), [recordId]);

  const docRef = useMemo(
    () => (internalId ? collection.docRef(db, pathContext, internalId) : null),
    // pathContext intentionally identity-tracked.
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
    [db, collection, copyFromId],
  );
  const copySnap = useDocSnapshot<Doc>(copyDocRef);

  // Nullable fields default to `null` (not `undefined`) so Firestore's
  // converter doesn't reject them on save and Mantine's controlled inputs
  // get a stable initial value.
  const emptyDefaults = useMemo(() => buildEmptyDefaults(descriptors), [descriptors]);

  // Validate what will be SAVED, not the raw editor state: apply each
  // field's `prepareForSave` before delegating to zodResolver. Staged
  // deletions are the motivating case — a schema-invalid row marked with
  // DELETE_MARK must not block the save, since `doSave` strips it anyway.
  // Note for editors: error paths therefore index the TRANSFORMED value
  // (e.g. the array with marked rows removed) — composite editors map the
  // indices back (see FaixaCepEditor).
  // `fieldOverrides` is identity-tracked deliberately: every call site
  // passes a module-level const (the lint rule on inline configs is the
  // backstop).
  const resolver = useMemo<Resolver<FieldValues>>(() => {
    const base = zodResolver(schema as never) as Resolver<FieldValues>;
    const transforms = Object.entries(fieldOverrides).filter(([, cfg]) => cfg?.prepareForSave);
    if (transforms.length === 0 && !validate) return base;
    const wrapped: Resolver<FieldValues> = async (values, ctx, opts) => {
      const prepared: Record<string, unknown> = { ...(values as Record<string, unknown>) };
      for (const [key, cfg] of transforms) {
        prepared[key] = cfg!.prepareForSave!(prepared[key]);
      }
      const result = await base(prepared as FieldValues, ctx, opts);
      if (!validate) return result;
      // Merge cross-document issues at each path's first segment. A real shape
      // error already on that key wins (don't clobber); otherwise the issue
      // blocks the save and routes to the key's tab via the section map.
      const issues = validate(prepared);
      if (issues.length === 0) return result;
      const errors: Record<string, unknown> = { ...(result.errors as Record<string, unknown>) };
      const rootMessages: string[] = [];
      for (const issue of issues) {
        const key = issue.path.split('.')[0];
        // Skip prototype-polluting keys: the hook merges arbitrary
        // caller-supplied paths into a plain object, and `errors['__proto__'] = …`
        // would mutate its prototype.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        // A key-less issue (empty path) is a cross-field / form-level rule with
        // no field to point at. Stash it under a synthetic key so it still
        // blocks the save and reaches `onInvalid` + the form-level Alert
        // instead of being silently dropped. NOT RHF's reserved `root` key:
        // RHF excludes `root` from its validity gating (it's for non-blocking
        // server messages), so a `root` error would not stop the submit.
        if (!key) {
          rootMessages.push(issue.message);
          continue;
        }
        if (!errors[key]) errors[key] = { type: 'custom', message: issue.message };
      }
      if (rootMessages.length > 0 && !errors[FORM_LEVEL_ERROR_KEY]) {
        errors[FORM_LEVEL_ERROR_KEY] = { type: 'custom', message: rootMessages.join('; ') };
      }
      return { ...result, errors } as typeof result;
    };
    return wrapped;
  }, [schema, fieldOverrides, validate]);

  const form = useForm<FieldValues>({
    resolver,
    defaultValues: { ...emptyDefaults, ...(defaultValues ?? {}) } as FieldValues,
    mode: 'onBlur',
  });

  // When the doc loads (or the record id changes), reset the form to the
  // loaded values. RHF needs `reset()` to also zero out `dirtyFields`.
  // Merge with emptyDefaults so docs missing nullable fields still get null
  // (instead of undefined leaking back through the patch on the next save).
  //
  // The IndexedDB persistent cache makes `useDocSnapshot` emit a `fromCache:
  // true` snapshot FIRST, and a transactional `saveRecord` has NO latency
  // compensation — so right after editing THIS record (and a reload) the cached
  // doc can still hold the pre-save value while the server has the new one. We
  // paint the first emission for instant feedback, then RE-SEED once the
  // authoritative `fromCache: false` snapshot arrives — but only while the form
  // is pristine, so an in-progress edit is never clobbered. The seeding logic
  // (first paint vs. one-time server-truth correction, tracked per record id)
  // now lives in `useServerTruthSeed`.
  //
  // `baseline` is the ADR 0011 tier-3 version handed to `saveRecord`: the record
  // as the operator last saw it from SERVER TRUTH.
  //
  // ⚠️ It is deliberately NOT seeded from a cache paint. The IndexedDB snapshot
  // right after an edit still holds the pre-save value, so a baseline taken from
  // it differs from the server on exactly the fields just saved — the guard
  // would fire on every save and operators would learn to click through it. That
  // is not hypothetical: it is the bug #791 fixed for `lastMarketplaceUpdate`.
  const baseline = useRef<Record<string, unknown> | null>(null);
  useServerTruthSeed({
    id: docSnap.data?.id,
    fromCache: docSnap.fromCache,
    isDirty: form.formState.isDirty,
    onSeed: (serverTruth) => {
      form.reset({ ...emptyDefaults, ...(docSnap.data?.data as FieldValues) });
      // Seeded HERE, in the same callback as the form — which is exactly what
      // `useServerTruthSeed`'s contract requires, and for this reason: a form
      // corrected to server truth while the baseline still held the cached copy
      // would compare the operator's patch against a version nobody ever
      // displayed. That mismatch is how the pedido editor turned its own
      // trigger's write-back into a false conflict (#972).
      //
      // Only from server truth, and only alongside a re-seed — the hook already
      // refuses to fire while the form is dirty, so a remote change arriving
      // mid-edit can never quietly become the new baseline and swallow the
      // conflict it should raise.
      if (serverTruth) baseline.current = docSnap.data?.data as Record<string, unknown>;
    },
  });
  // Create mode has no snapshot to seed from — reset to the page's defaults.
  //
  // Note the deliberate hole left by the above: a cache-first paint whose server
  // correction arrives only after the operator has started typing leaves the
  // baseline null, so that one save is unguarded. Fail-open matches the previous
  // behaviour; guarding against a version we never showed them would raise a
  // conflict they cannot act on.
  useEffect(() => {
    if (!docSnap.data && !internalId) {
      form.reset({ ...emptyDefaults, ...(defaultValues ?? {}) } as FieldValues);
      baseline.current = null;
    }
  }, [docSnap.data?.id, docSnap.fromCache, docSnap.data?.data]);

  // Copy mode: once the source doc loads, seed the form with its values. The
  // document id never lives in the schema data, so it's already excluded;
  // creation/modification stamps are stripped so the new record gets fresh
  // ones (resolved field names — e.g. `dataCadastro`, not only `timestamp`).
  // The page's `defaultValues` lose to the source (it's a clone).
  useEffect(() => {
    if (!copySnap.data || internalId) return;
    const source = { ...(copySnap.data.data as Record<string, unknown>) };
    for (const key of copyStripKeys) delete source[key];
    form.reset({
      ...emptyDefaults,
      ...(defaultValues ?? {}),
      ...source,
    } as FieldValues);
  }, [copySnap.data?.id]);

  const [submitError, setSubmitError] = useState<string | null>(null);
  // The remote doc a tier-3 conflict was raised against, plus the fields that
  // collided and whether the operator had asked to keep editing. `continue` is
  // kept so "Salvar mesmo assim" resumes the button they actually pressed.
  const [conflict, setConflict] = useState<{
    /** The version the form was seeded from — the modal's "Você carregou". */
    loaded: Record<string, unknown>;
    current: Record<string, unknown>;
    fields: string[];
    continueEditing: boolean;
  } | null>(null);
  // Delete confirmation modal: the user must type "excluir" to enable the
  // destructive button — guards against accidental clicks.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const deleteConfirmed = deleteText.trim().toLowerCase() === 'excluir';
  // `extraDirty` folds in pending edits held by a self-contained tab, which
  // this form's own dirty state cannot see. That tab must not arm its own
  // guard — see the prop's doc comment.
  useUnsavedChangesGuard(form.formState.isDirty || extraDirty);

  /**
   * The schema's own object shape, for the conflict modal's field labels. The
   * cast is the same one the descriptor pipeline makes: `schema` is an object
   * schema by contract here (it is what drives every rendered field), but the
   * `ZodTypeAny` prop type does not say so.
   */
  const labelShape = (schema as unknown as { shape?: Record<string, ZodTypeAny> }).shape ?? {};

  /**
   * "Recarregar do servidor" — take the server's version for the fields that
   * actually collided, and KEEP every edit that did not.
   *
   * The operator only loses what genuinely conflicted; a name they retyped while
   * someone else changed the price survives. `shouldDirty` is what makes that
   * true — the re-applied values must stay in `dirtyFields` or the next save
   * would not write them at all.
   */
  function reloadFromServer(): void {
    if (!conflict) return;
    const keep = form.getValues() as Record<string, unknown>;
    const dirtyNow = form.formState.dirtyFields as Record<string, unknown>;
    const collided = new Set(conflict.fields);
    form.reset({ ...emptyDefaults, ...(conflict.current as FieldValues) });
    for (const key of Object.keys(dirtyNow)) {
      if (collided.has(key)) continue;
      form.setValue(key, keep[key] as never, { shouldDirty: true });
    }
    setConflict(null);
  }

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
    // Record-level derivations (e.g. denormalized `variacoesIds` from the
    // already-transformed `variacoes`). Merge the derived keys into the values
    // and mark each dirty only when it changed, so a pristine update still
    // short-circuits via NothingChangedError instead of writing a no-op patch.
    // `undefined` results are skipped entirely (Firestore rejects undefined —
    // a derivation must yield `null`, like every other optional field), and
    // the comparison is structural (`valuesEqual`), never JSON serialization,
    // so non-JSON values such as BigInt can't crash the save.
    const dirtyFields: Record<string, unknown> = { ...dirty };
    if (deriveOnSave) {
      for (const [key, next] of Object.entries(deriveOnSave(values))) {
        if (next === undefined) continue;
        if (!valuesEqual(next, raw[key])) dirtyFields[key] = true;
        values[key] = next;
      }
    }
    // Transient fields (aggregate page-model extras) are validated + rendered
    // but never reach the document: strip them — and their dirty flags — from
    // what `saveRecord` writes. The FULL `values` still flow to `form.reset`,
    // `onAfterSave`, and `transactionWrites` (below) so the extras can persist.
    // When ONLY transient fields changed, the doc patch is empty: if
    // `transactionWrites` yields sibling writes, `saveRecord` commits those and
    // skips the main doc; otherwise it throws `NothingChangedError`, whose
    // handler runs `onAfterSave` anyway.
    const docValues: Record<string, unknown> = { ...values };
    const docDirty: Record<string, unknown> = { ...dirtyFields };
    for (const key of transientFields) {
      delete docValues[key];
      delete docDirty[key];
    }
    try {
      const result = await saveRecord<C, Record<string, unknown>>({
        db,
        collection,
        pathContext,
        recordId: internalId,
        values: docValues,
        dirtyFields: docDirty,
        // Persist transient fields (e.g. the extraData singleton) in the SAME
        // transaction as the document — the full `values` carry them; the hook
        // turns them into sibling writes keyed by the resolved record id.
        siblingWrites: transactionWrites ? (id) => transactionWrites(id, values) : undefined,
        currentUserUid,
        // ADR 0011 tier 3. "Salvar mesmo assim" does NOT come through here with
        // the guard off — it comes through with `baseline.current` already
        // re-based onto the version the modal showed (see the catch below).
        // The comparison therefore still runs, and that is the whole point: a
        // THIRD writer landing while the operator read the diff raises the modal
        // again instead of being silently overwritten. Skipping the check on an
        // override would reintroduce the lost update one step later, against a
        // write the operator had just been told was safe.
        baseline: disableConcurrencyGuard ? undefined : (baseline.current ?? undefined),
        ignoreFields: concurrencyIgnoreFields ? new Set(concurrencyIgnoreFields) : undefined,
        stampUnit: stampFields.stampUnit,
        // `false` when auto-detect found nothing — don't fall back to the
        // saveRecord defaults (`timestamp` / `ultimaModificacao`) on schemas
        // that genuinely lack those keys.
        createdAtField: stampFields.createdAtField ?? false,
        modifiedAtField: stampFields.modifiedAtField ?? false,
      });
      // Zero out dirty state while preserving the persisted (transformed) values.
      form.reset(values as typeof raw);
      // Re-base the tier-3 baseline onto what we just wrote: after a successful
      // save, the version the operator last knew IS this one.
      //
      // Without this, "Salvar e continuar" leaves the form mounted holding the
      // PRE-save baseline while the server has the post-save value, so a second
      // edit of the same field collides with the operator's own previous write —
      // a false conflict, which #791 already established is worse than no guard
      // at all ("operators would learn to click through it"). `useServerTruthSeed`
      // cannot repair it: it corrects once per record id and that already
      // happened on open, so no later snapshot re-seeds this.
      //
      // Merged, not replaced, and only when a baseline was actually armed. A null
      // one is the deliberate fail-open hole documented above the create-mode
      // effect; building a baseline out of a patch would claim knowledge of every
      // field the patch does not carry. Same reasoning as the conflict re-base
      // below: whatever they decide next is judged against what they last wrote.
      if (baseline.current) {
        baseline.current = {
          ...baseline.current,
          ...(result.patch as Record<string, unknown>),
        };
      }
      // If we just created, retain the id so subsequent saves are updates.
      if (!internalId) setInternalId(result.id);
      // Sibling writes that belong to this save (e.g. a manager flushing
      // staged child documents). Runs on BOTH save paths; a failure surfaces
      // in the form alert and skips onSaved (the record itself is saved — the
      // user can retry just the sibling step by saving again).
      await onAfterSave?.(result.id, values);
      if (continueEditing) {
        notifications.show({ color: 'green', message: 'Salvo.' });
      } else {
        onSaved?.(result.id);
      }
    } catch (err) {
      // Same contract on the normal save path: the record IS persisted, the
      // sibling step paused on purpose. `onSaved` is unreachable from here
      // (it sits after the throw), which is exactly what we want.
      if (err instanceof AfterSaveBlockedError) {
        setSubmitError(err.message);
        return;
      }
      // Tier 3 — someone else changed a field this save writes. Show the diff
      // and let the operator choose; never discard what they typed. The form
      // stays dirty, so the leave-guard still protects them.
      if (err instanceof RecordConflictError) {
        if (err.missing || err.current === null) {
          setSubmitError(err.message);
          return;
        }
        const loaded = baseline.current ?? {};
        // Re-baseline onto the version being shown: whatever they decide next
        // is judged against what they actually saw.
        baseline.current = err.current;
        setConflict({ loaded, current: err.current, fields: err.fields, continueEditing });
        return;
      }
      if (err instanceof NothingChangedError) {
        // The record itself is pristine — but sibling writes may still be
        // pending (e.g. staged child documents). When an `onAfterSave` is
        // wired, run it and treat the action as a successful save; without
        // one, keep the "nothing changed" toast.
        if (onAfterSave && internalId) {
          try {
            await onAfterSave(internalId, values);
          } catch (afterErr) {
            // The sibling step deliberately stopped and put something in front
            // of the operator — show it, but do NOT run `onSaved`, which
            // navigates away from the screen holding it.
            if (afterErr instanceof AfterSaveBlockedError) {
              setSubmitError(afterErr.message);
              return;
            }
            if (afterErr instanceof ZodError) {
              // `ZodError.message` is the serialized issues array — join the
              // human messages instead (sibling flushes throw contextualized
              // issues, e.g. per-row validation in the variations manager).
              setSubmitError(afterErr.issues.map((i) => i.message).join('; '));
              return;
            }
            if (afterErr instanceof FirebaseError) {
              setSubmitError(afterErr.message);
              return;
            }
            throw afterErr;
          }
          if (continueEditing) {
            notifications.show({ color: 'green', message: 'Salvo.' });
          } else {
            onSaved?.(internalId);
          }
          return;
        }
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

  // Key → label for EVERY top-level field, visible or not. Lets us name an
  // invalid field that has no rendered input (excluded / hidden) by its human
  // label instead of its raw schema key in the "fora do formulário" feedback.
  const labelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of descriptors) map.set(d.key, d.label);
    return map;
  }, [descriptors]);

  // Errors with no rendered input: excluded/hidden fields and key-less
  // (root / cross-field) rules. They never show inline, so surface them in a
  // persistent Alert too. Computed inline on purpose — like `errorSections`
  // below, reading `formState.errors` during render subscribes via the proxy.
  const hiddenErrors: string[] = [];
  for (const [key, val] of Object.entries(form.formState.errors)) {
    if (sectionOf.has(key)) continue;
    const message = (val as { message?: string } | undefined)?.message;
    if (!message) continue;
    const label = labelOf.get(key);
    hiddenErrors.push(label !== undefined ? `${label}: ${message}` : message);
  }

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

  // Published to custom `renderInput` widgets (see `ObjectViewSectionsContext`)
  // so one that writes a SIBLING field can move the operator to the tab that
  // renders it — otherwise the change lands in a hidden panel and reads as
  // "nothing happened". `goToSection` ignores an unknown section rather than
  // stranding `activeSection` on a value `effectiveSection` would discard.
  //
  // ⚠️ The switch is COMMITTED synchronously, and that is what makes the
  // gesture work rather than a performance choice. `SectionTabs` hides an
  // inactive panel with `<Activity mode="hidden">`, which unmounts every effect
  // in it — including the subscription each RHF `Controller` registers. A
  // `setValue` into a hidden panel therefore never reaches that field's input,
  // and the input does NOT re-sync when its effects mount again: it re-renders
  // from the state it held before, so the operator lands on the right tab
  // still looking at the OLD value. Flushing here means a caller can
  // `goToSection(...)` and then `setValue(...)`, with the target mounted and
  // subscribed in between. Pinned by `ObjectView.sections.activity.test.tsx`,
  // which has to render without `env="test"` to see it at all.
  const sectionsApi = useMemo<ObjectViewSections>(
    () => ({
      activeSection: effectiveSection,
      goToSection: (section) => {
        if (!sections?.includes(section)) return;
        flushSync(() => setActiveSection(section));
      },
      sectionOfField: (fieldKey) => sectionOf.get(fieldKey) ?? null,
    }),
    [effectiveSection, sections?.join('|'), sectionOf],
  );

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
  // Build the clause that names everything invalid with no rendered input:
  // excluded/hidden fields (by label) and key-less root / cross-field rules
  // (by message, since their key means nothing to a user). Empty when every
  // error is on a rendered field — those already show inline.
  function describeOutside(errors: FieldErrors): string[] {
    const fields: string[] = [];
    const messages: string[] = [];
    for (const key of Object.keys(errors)) {
      if (sectionOf.has(key)) continue;
      const label = labelOf.get(key);
      if (label !== undefined) {
        fields.push(label);
      } else {
        const message = (errors[key] as { message?: string } | undefined)?.message;
        if (message) messages.push(message);
      }
    }
    return [
      fields.length > 0 ? `campos inválidos fora do formulário (${fields.join(', ')})` : null,
      ...messages,
    ].filter((s): s is string => s !== null);
  }

  function onInvalid(errors: FieldErrors) {
    // zodResolver reports the full error set, so fields hidden or excluded from
    // the form (and root / cross-field rules) can error too — they have no
    // input to point at, so name them explicitly.
    const outside = describeOutside(errors);
    if (!sections || sections.length === 0) {
      // Flat layout: rendered-field errors already show inline. Only escalate
      // with names when something invalid has nothing to point at.
      notifications.show({
        color: 'red',
        message:
          outside.length > 0
            ? `Não foi possível salvar: ${outside.join('. ')}.`
            : 'Corrija os campos inválidos antes de salvar.',
      });
      return;
    }
    // Erroring sections in display order.
    const errorKeys = Object.keys(errors);
    const erroring = sections.filter((s) => errorKeys.some((k) => sectionOf.get(k) === s));
    const first = erroring[0];
    if (first === undefined) {
      notifications.show({
        color: 'red',
        message: `Não foi possível salvar: ${outside.join('. ')}.`,
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
      message: outside.length > 0 ? `${inTabs} Há também ${outside.join('. ')}.` : inTabs,
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

  /**
   * Which snapshot is currently on screen: `pending` (nothing emitted yet — an
   * unresolved listener, a load error, or create mode), `cache` (the local copy,
   * so a server correction is still owed) or `server` (the authoritative
   * `fromCache: false` snapshot landed).
   *
   * Exposed on the form below because that difference is otherwise invisible from
   * the outside, and the invisibility is what costs: a field still showing the
   * cached pre-save value and a genuinely lost write render identically, so an
   * assertion that only reads the value cannot say which it hit. That ambiguity is
   * the whole reason `expectFieldAfterReload` kept costing investigations.
   *
   * ⚠️ It reports which snapshot ARRIVED — never that the form matches the server.
   * `useServerTruthSeed` deliberately withholds the re-seed while the form is dirty,
   * so on a dirty form `server` coexists with the operator's own unsaved value. That
   * is correct, and it is why this must not be read as "converged".
   *
   * ⚠️ It also leads the inputs by one paint: this flips during render, while
   * `form.reset` runs in the effect that follows. A reader must therefore poll for
   * the value it expects, never take one synchronous reading the moment it turns
   * `server`.
   */
  const snapshotSource =
    docSnap.fromCache === undefined ? 'pending' : docSnap.fromCache ? 'cache' : 'server';

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
    // FormProvider exposes the RHF context so custom `renderInput` widgets can
    // read SIBLING fields live (e.g. the VariationManager generating child
    // SKUs from the parent's unsaved `sku` via `useFormContext().getValues`).
    <FormProvider {...form}>
      {/* Tab navigation, published beside the form context: a widget that
          writes a sibling field usually has to point at where it landed. */}
      <ObjectViewSectionsProvider value={sectionsApi}>
        <form
          // Which Firestore snapshot the fields below were painted from. See
          // `snapshotSource` above for the two things it does NOT mean.
          data-snapshot-source={snapshotSource}
          // Zod (via the resolver) owns ALL validation. Without noValidate the
          // browser's native constraint validation intercepts the submit when
          // any control carries the native `required` attribute (e.g. Mantine
          // inputs with `required`): if that control is empty AND inside a
          // hidden section tab, Chrome can't focus it, BLOCKS the submission
          // silently ("An invalid form control with name='' is not focusable")
          // and React's onSubmit never fires — no toast, no tab jump, nothing.
          noValidate
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
                Registro pré-preenchido a partir de uma cópia. Revise os campos e clique em{' '}
                {saveLabel} para criar um novo registro.
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
                  contents={Object.fromEntries(
                    sections.map((s) => [s, fieldsBlock(grouped[s] ?? [])]),
                  )}
                  value={effectiveSection}
                  onChange={setActiveSection}
                  errorSections={errorSections}
                  persistentSections={persistentSections}
                />
              ) : (
                fieldsBlock(grouped['default'] ?? visibleDescriptors)
              ))}

            {hiddenErrors.length > 0 && (
              <Alert color="red" title="Campos inválidos fora do formulário">
                <Stack gap="xs">
                  {hiddenErrors.map((m, i) => (
                    <Text key={`${i}:${m}`} size="sm">
                      {m}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            {submitError && <Alert color="red">{submitError}</Alert>}

            <ConflictModal
              opened={conflict !== null}
              title="Registro alterado"
              fields={
                conflict
                  ? buildConflictFields(
                      conflict.loaded,
                      conflict.current,
                      conflict.fields,
                      // Every listed field is one this save writes — that is how
                      // `saveRecord` picked them — so all of them overwrite.
                      new Set(conflict.fields),
                      { labelFor: (f) => labelFromShape(labelShape, f) },
                    )
                  : []
              }
              saving={form.formState.isSubmitting}
              onForceSave={() => {
                const { continueEditing } = conflict!;
                setConflict(null);
                // Plain re-save. `baseline.current` was re-based onto the version
                // shown when the conflict was caught, so the guard still runs: if
                // nothing moved since, this commits; if a third writer landed
                // meanwhile, the modal comes straight back with THAT version.
                void doSave(continueEditing);
              }}
              onReloadFromServer={reloadFromServer}
              onCancel={() => setConflict(null)}
            />

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
      </ObjectViewSectionsProvider>
    </FormProvider>
  );
}
