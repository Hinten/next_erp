'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { Fieldset, Select, SimpleGrid, Textarea, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { AfterSaveBlockedError } from '@delfrance/ui';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import {
  attributesForSave,
  seedRows,
  validateAttr,
  type AttrRow,
} from '@/lib/mercado-livre/attributeForm';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';

import {
  CONDITION_OPTIONS,
  LISTING_TYPE_OPTIONS,
  listingTypeLabel,
  titleEditability,
  TITLE_MAX_LENGTH,
} from '@/lib/mercado-livre/listingFields';
import {
  listingFormSchema,
  toFormValues,
  toPatchValues,
  type ListingFormInput,
  type ListingFormValues,
} from '@/lib/mercado-livre/listingForm';
import { createClientListingPort } from '@/lib/mercado-livre/listingPort';
import {
  ListingConflictError,
  ListingMissingError,
  ListingNothingChangedError,
  saveListing,
} from '@/lib/mercado-livre/saveListing';
import type { OperatorOwnedKey } from '@/lib/mercado-livre/listingPatch';
import { AtributosSection } from './AtributosSection';
import { CategoriaField } from './CategoriaField';
import { ListingConflictModal } from './ListingConflictModal';
import { ListingField, textOr } from './ListingField';

/** ML metadata barely moves; a half-hour is generous and still bounded. */
const METADATA_STALE_MS = 30 * 60 * 1000;

export interface ListingFormProps {
  produtoId: string;
  /** Firestore id of the `produtoMercadoLivre` doc being edited. */
  linkDocId: string;
  /** The ML account this listing belongs to — needed for every metadata call. */
  integracaoId: string;
  /** Seeds the category suggestion request. */
  produtoNome: string;
  link: ProdutoMercadoLivreLink;
  db: Firestore;
  canWrite: boolean;
  disabled?: boolean;
  /** Reported on every change so the page's leave-guard can see ML edits. */
  onDirtyChange: (linkDocId: string, dirty: boolean) => void;
  /**
   * Hands the editor a closure that saves this listing, so **both** callers can
   * drive it: the produto's own "Salvar alterações" (`'flush'`) and the
   * "Salvar anúncio" button the editor now renders next to Publicar
   * (`'button'`). `null` on unmount.
   *
   * ⚠️ The mode is not cosmetic — it decides how a failure is reported. `'flush'`
   * throws `AfterSaveBlockedError`, which `ObjectView` turns into a form alert and
   * which stops it navigating away from the conflict modal; `'button'` shows a
   * notification and swallows, because there is no outer save to block.
   */
  registerFlush: (linkDocId: string, save: ListingSaveFn | null) => void;
}

/** How a registered listing save is invoked — see `registerFlush`. */
export type ListingSaveFn = (mode: 'button' | 'flush') => Promise<void>;

/**
 * The editable half of a listing.
 *
 * Everything here is an **operator-owned** key (`OPERATOR_OWNED_KEYS`); the
 * server-owned fields stay read-only in `ListingDetails`. That split is not
 * cosmetic — it is tier 0 of the lost-update ladder. A patch that only ever
 * carries these keys cannot collide with the webhook advancing `estado` or the
 * price sync refreshing `precoPublicado`, which is what makes an editor on a
 * document six writers touch safe at all.
 *
 * Two rules this component must not break, both from the surrounding
 * `ObjectView`:
 *
 *  - **never render a `<form>` element.** ObjectView already renders one and
 *    this subtree lives inside it; a nested form is invalid HTML and the inner
 *    submit would bubble into the produto save.
 *  - **never call `useUnsavedChangesGuard`.** ObjectView owns the only guard.
 *    Dirtiness is reported upward through `onDirtyChange` and reaches the guard
 *    as ObjectView's `extraDirty` prop instead.
 */
export function ListingForm({
  produtoId,
  linkDocId,
  integracaoId,
  produtoNome,
  link,
  db,
  canWrite,
  disabled,
  onDirtyChange,
  registerFlush,
}: ListingFormProps) {
  const client = useMercadoLivreClient();
  const form = useForm<ListingFormInput, unknown, ListingFormValues>({
    resolver: zodResolver(listingFormSchema),
    defaultValues: toFormValues(link),
    mode: 'onBlur',
  });
  const isDirty = form.formState.isDirty;

  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{
    fields: OperatorOwnedKey[];
    baseline: ProdutoMercadoLivreLink;
    current: ProdutoMercadoLivreLink;
  } | null>(null);

  // The doc the form was seeded from — the concurrency baseline, deliberately
  // NOT the live snapshot. `saveListing` compares this against a fresh read
  // inside the transaction.
  const baselineRef = useRef<ProdutoMercadoLivreLink>(link);

  const titleRule = useMemo(() => titleEditability(link), [link]);
  const isPublished = link.id != null;

  // ---- Attributes ---------------------------------------------------------
  // Deliberately NOT a react-hook-form field. The set of attributes is decided
  // by an async metadata call keyed on the category, so an RHF array would have
  // to be re-seeded on every arrival with `shouldDirty: false`, and every
  // re-seed is a chance to either wipe a pending edit or mark a pristine form
  // dirty. Holding the edits beside the form and deriving the rest is simpler
  // and has no effect in it.
  // `useWatch`, not `form.watch()`: the latter returns a fresh function the
  // React Compiler cannot memoize, so it opts the whole component out of
  // compilation (`react-hooks/incompatible-library`).
  const categoryId = useWatch({ control: form.control, name: 'category_id' });
  const effectiveCategoryId = categoryId == null || categoryId === '' ? null : categoryId;
  const atributosQuery = useQuery({
    queryKey: ['ml', 'atributos', integracaoId, effectiveCategoryId],
    enabled: effectiveCategoryId != null && client != null,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.categoriaAtributos({ integracaoId, categoryId: effectiveCategoryId! }),
  });
  const attrs = useMemo(() => atributosQuery.data?.atributos ?? [], [atributosQuery.data]);
  const omitidos = useMemo(() => atributosQuery.data?.omitidos ?? [], [atributosQuery.data]);

  // Edits are stamped with the category they were made under, so switching
  // category falls back to the freshly seeded rows instead of showing values
  // that belong to a different attribute set.
  const [edited, setEdited] = useState<{ categoryId: string | null; rows: AttrRow[] } | null>(null);
  const seededRows = useMemo(
    () => seedRows(attrs, link.attributes ?? null),
    [attrs, link.attributes],
  );
  const attrDirty = edited != null && edited.categoryId === effectiveCategoryId;
  const attrRows = attrDirty ? edited.rows : seededRows;

  const attrErrors = useMemo(() => {
    const out: Record<string, string> = {};
    const byId = new Map(attrRows.map((r) => [r.id, r]));
    for (const attr of attrs) {
      const message = validateAttr(attr, byId.get(attr.id));
      if (message != null) out[attr.id] = message;
    }
    return out;
  }, [attrs, attrRows]);

  // Re-seed from the live snapshot ONLY while the operator has nothing pending.
  // A publish or a webhook landing mid-edit must not silently rewrite the text
  // someone is typing — that case is what the conflict modal is for.
  useEffect(() => {
    if (isDirty) return;
    baselineRef.current = link;
    form.reset(toFormValues(link));
  }, [link, isDirty, form]);

  useEffect(() => {
    onDirtyChange(linkDocId, isDirty || attrDirty);
  }, [linkDocId, isDirty, attrDirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange(linkDocId, false);
    },
    [linkDocId, onDirtyChange],
  );

  const runSave = useCallback(
    async (mode: 'button' | 'flush', override?: ProdutoMercadoLivreLink): Promise<void> => {
      const valid = await form.trigger();
      if (!valid) {
        if (mode === 'flush') {
          throw new AfterSaveBlockedError(
            'Há campos inválidos no anúncio do Mercado Livre. Corrija-os na aba Mercado Livre.',
          );
        }
        return;
      }
      const parsed = listingFormSchema.safeParse(form.getValues());
      if (!parsed.success) return;

      const baseline = override ?? baselineRef.current;
      const port = createClientListingPort(db, produtoId, linkDocId);

      // `attributes` rides ONLY when the operator edited it AND the metadata
      // that governs the purge has actually loaded. `attributesForSave` decides
      // what survives by iterating that metadata, so running it against an
      // empty list would be deciding with no information — and this is the
      // field where the cost of that is silent: dropping `SIZE_GRID_ID` breaks
      // every size-chart binding with nothing on screen to show for it.
      const values = toPatchValues(parsed.data);
      const attributesRide = attrDirty && atributosQuery.data != null;
      if (attributesRide) {
        values.attributes = attributesForSave(attrs, attrRows, link.attributes ?? null, omitidos);
      }

      setSaving(true);
      try {
        await saveListing(port, {
          values,
          dirty: {
            ...(form.formState.dirtyFields as Record<string, unknown>),
            ...(attributesRide ? { attributes: true } : {}),
          },
          baseline,
          baselineMs: baseline.ultimaModificacao ?? null,
        });
        // Zero the dirty state without waiting for the snapshot round trip, so
        // the produto's leave-guard clears the moment the write lands.
        form.reset(parsed.data);
        // Drop the local attribute edits so the grid re-derives from the doc.
        setEdited(null);
        // Advance the baseline to what we just wrote — `values`, not a fresh
        // `toPatchValues`, so the attributes that rode are part of it. Waiting
        // for the snapshot instead would leave a window where a second save
        // compares against the pre-save doc and reports a conflict with our own
        // write.
        baselineRef.current = { ...baseline, ...values } as ProdutoMercadoLivreLink;
        setConflict(null);
        if (mode === 'button') {
          notifications.show({ color: 'green', message: 'Anúncio salvo.' });
        }
      } catch (err) {
        if (err instanceof ListingNothingChangedError) {
          // A round trip that ended where it started. Nothing to write, and
          // nothing worth interrupting the produto save for.
          form.reset(parsed.data);
          if (mode === 'button') {
            notifications.show({ color: 'yellow', message: err.message });
          }
          return;
        }
        if (err instanceof ListingConflictError) {
          setConflict({ fields: err.fields, baseline, current: err.current });
          if (mode === 'flush') {
            throw new AfterSaveBlockedError(
              'O anúncio do Mercado Livre foi alterado por outra pessoa. Revise as diferenças antes de salvar.',
            );
          }
          return;
        }
        if (err instanceof ListingMissingError) {
          notifications.show({ color: 'red', message: err.message });
          if (mode === 'flush') throw new AfterSaveBlockedError(err.message);
          return;
        }
        if (err instanceof FirebaseError) {
          notifications.show({ color: 'red', message: err.message });
          if (mode === 'flush') throw new AfterSaveBlockedError(err.message);
          return;
        }
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [
      db,
      form,
      linkDocId,
      produtoId,
      attrDirty,
      attrRows,
      attrs,
      omitidos,
      atributosQuery.data,
      link.attributes,
    ],
  );

  // The flush closure is re-read from a ref so the registration itself stays
  // stable — re-registering on every render would churn the editor's map.
  const runSaveRef = useRef(runSave);
  useEffect(() => {
    runSaveRef.current = runSave;
  }, [runSave]);
  useEffect(() => {
    registerFlush(linkDocId, (mode) => runSaveRef.current(mode));
    return () => registerFlush(linkDocId, null);
  }, [linkDocId, registerFlush]);

  const readOnly = Boolean(disabled) || !canWrite;

  return (
    <>
      <Fieldset legend="Dados do anúncio" variant="unstyled">
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
          <Controller
            control={form.control}
            name="title"
            render={({ field, fieldState }) => (
              <Tooltip label={titleRule.reason} disabled={titleRule.editable} multiline w={280}>
                <TextInput
                  {...field}
                  value={field.value ?? ''}
                  label="Título do anúncio"
                  maxLength={TITLE_MAX_LENGTH}
                  description={`${(field.value ?? '').length}/${TITLE_MAX_LENGTH}`}
                  disabled={readOnly || !titleRule.editable}
                  error={fieldState.error?.message}
                />
              </Tooltip>
            )}
          />
          <Controller
            control={form.control}
            name="condition"
            render={({ field, fieldState }) => (
              <Select
                label="Condição"
                data={[...CONDITION_OPTIONS]}
                value={field.value}
                onChange={(v) => field.onChange(v ?? 'new')}
                onBlur={field.onBlur}
                allowDeselect={false}
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            control={form.control}
            name="category_id"
            render={({ field, fieldState }) => (
              <CategoriaField
                integracaoId={integracaoId}
                produtoNome={produtoNome}
                value={field.value === '' ? null : field.value}
                onChange={field.onChange}
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            control={form.control}
            name="descricao"
            render={({ field, fieldState }) => (
              <Textarea
                {...field}
                value={field.value ?? ''}
                label="Descrição"
                description="Em branco, a publicação usa a descrição do produto."
                autosize
                minRows={3}
                maxRows={10}
                disabled={readOnly}
                error={fieldState.error?.message}
                style={{ gridColumn: '1 / -1' }}
              />
            )}
          />
        </SimpleGrid>
      </Fieldset>

      <Fieldset legend="Comercial" variant="unstyled">
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" verticalSpacing="xs">
          {/* ⚠️ A published listing must NOT render a labelled "Tipo de anúncio"
              control: ML only changes a listing type through its own upgrade
              endpoint, and `produto-mercado-livre.vendas.e2e.spec.ts` proves the
              first-publish Select is gone by asserting that label has count 0
              on a published card. */}
          {isPublished ? (
            <ListingField label="Tipo de anúncio">
              {textOr(listingTypeLabel(link.listing_type_id))}
            </ListingField>
          ) : (
            <Controller
              control={form.control}
              name="listing_type_id"
              render={({ field, fieldState }) => (
                <Select
                  label="Tipo de anúncio"
                  data={[...LISTING_TYPE_OPTIONS]}
                  value={field.value === '' ? null : field.value}
                  onChange={(v) => field.onChange(v ?? '')}
                  onBlur={field.onBlur}
                  disabled={readOnly}
                  error={fieldState.error?.message}
                />
              )}
            />
          )}
        </SimpleGrid>
      </Fieldset>

      <Fieldset legend="Atributos da categoria" variant="unstyled">
        <AtributosSection
          categoryId={effectiveCategoryId}
          attrs={attrs}
          rows={attrRows}
          onRowsChange={(rows) => setEdited({ categoryId: effectiveCategoryId, rows })}
          errors={attrErrors}
          leaf={atributosQuery.data?.leaf ?? true}
          loading={atributosQuery.isPending && effectiveCategoryId != null}
          failed={atributosQuery.isError}
          disabled={readOnly}
        />
      </Fieldset>

      {/* ⚠️ "Salvar anúncio" is NOT rendered here any more. It lives in
          `MercadoLivreEditor`'s action group, beside "Publicar no Mercado Livre",
          because saving and publishing are the two halves of one decision and
          having them at opposite ends of a long card read as unrelated.
          `registerFlush` is what lets the editor drive this form's save, and the
          editor gates the button on its own `dirtyIds` — which counts ATTRIBUTE
          edits too, unlike the RHF-only `isDirty` this button used to read. */}

      <ListingConflictModal
        opened={conflict !== null}
        fields={conflict?.fields ?? []}
        baseline={conflict?.baseline ?? null}
        current={conflict?.current ?? null}
        saving={saving}
        onCancel={() => setConflict(null)}
        onForceSave={() => {
          const current = conflict?.current;
          if (!current) return;
          void runSave('button', current);
        }}
      />
    </>
  );
}
