'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import {
  Button,
  Fieldset,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { AfterSaveBlockedError } from '@delfrance/ui';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import {
  channelOptions,
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
import { CategoriaField } from './CategoriaField';
import { ListingConflictModal } from './ListingConflictModal';
import { ListingField, textOr } from './ListingField';

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
   * Hands the editor a closure that saves this listing, so the produto's own
   * "Salvar alterações" commits ML edits too. `null` on unmount.
   */
  registerFlush: (linkDocId: string, flush: (() => Promise<void>) | null) => void;
}

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
  const channelSelectData = useMemo(() => channelOptions(link.channels), [link.channels]);
  const isPublished = link.id != null;

  // Re-seed from the live snapshot ONLY while the operator has nothing pending.
  // A publish or a webhook landing mid-edit must not silently rewrite the text
  // someone is typing — that case is what the conflict modal is for.
  useEffect(() => {
    if (isDirty) return;
    baselineRef.current = link;
    form.reset(toFormValues(link));
  }, [link, isDirty, form]);

  useEffect(() => {
    onDirtyChange(linkDocId, isDirty);
  }, [linkDocId, isDirty, onDirtyChange]);

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
      setSaving(true);
      try {
        await saveListing(port, {
          values: toPatchValues(parsed.data),
          dirty: form.formState.dirtyFields as Record<string, unknown>,
          baseline,
          baselineMs: baseline.ultimaModificacao ?? null,
        });
        // Zero the dirty state without waiting for the snapshot round trip, so
        // the produto's leave-guard clears the moment the write lands.
        form.reset(parsed.data);
        // Advance the baseline to what we just wrote. Waiting for the snapshot
        // instead would leave a window where a second save compares against the
        // pre-save doc and reports a conflict with our own write.
        baselineRef.current = {
          ...baseline,
          ...toPatchValues(parsed.data),
        } as ProdutoMercadoLivreLink;
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
    [db, form, linkDocId, produtoId],
  );

  // The flush closure is re-read from a ref so the registration itself stays
  // stable — re-registering on every render would churn the editor's map.
  const runSaveRef = useRef(runSave);
  useEffect(() => {
    runSaveRef.current = runSave;
  }, [runSave]);
  useEffect(() => {
    registerFlush(linkDocId, () => runSaveRef.current('flush'));
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
            name="channels"
            render={({ field, fieldState }) => (
              <Select
                label="Canais"
                data={channelSelectData}
                value={field.value}
                onChange={(v) => field.onChange(v ?? 'marketplace')}
                onBlur={field.onBlur}
                allowDeselect={false}
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
          {/* The one field a fresh produto cannot be published without, and the
              reason "Preparar anúncio" exists at all — publish refuses a
              listing with no `category_id` and no longer guesses one. */}
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
          <Controller
            control={form.control}
            name="tarifaFrete"
            render={({ field, fieldState }) => (
              <NumberInput
                label="Tarifa de frete"
                prefix="R$ "
                decimalScale={2}
                min={0}
                value={field.value ?? ''}
                onChange={(v) => field.onChange(v === '' ? null : Number(v))}
                onBlur={field.onBlur}
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            control={form.control}
            name="crossdocking"
            render={({ field, fieldState }) => (
              <NumberInput
                label="Crossdocking"
                description="Dias de preparação antes do envio."
                allowDecimal={false}
                min={0}
                value={field.value ?? ''}
                onChange={(v) => field.onChange(v === '' ? null : Number(v))}
                onBlur={field.onBlur}
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            control={form.control}
            name="video_id"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                label="Vídeo (YouTube)"
                description="Somente o id do vídeo."
                disabled={readOnly}
                error={fieldState.error?.message}
              />
            )}
          />
        </SimpleGrid>
      </Fieldset>

      <Group justify="flex-end">
        {/* type="button": ObjectView's <form> wraps this subtree, and a submit
            button here would fire the produto save instead. */}
        <Button
          type="button"
          variant="light"
          onClick={() => void runSave('button')}
          loading={saving}
          disabled={readOnly || !isDirty}
        >
          Salvar anúncio
        </Button>
      </Group>

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
