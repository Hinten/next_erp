'use client';

import { useEffect, useMemo, type MutableRefObject } from 'react';
import { Fieldset, Select, Stack, Switch, TagsInput, Textarea, TextInput } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  CONDICAO_PRODUTO_LABELS,
  GOOGLE_AGE_GROUP_LABELS,
  GOOGLE_GENDER_LABELS,
  PRODUTO_EXTRA_DATA_DOC_ID,
  googleMerchantDataSchema,
  produtoExtraDataSchema,
  type CondicaoProduto,
  type GoogleAgeGroup,
  type GoogleGender,
  type GoogleMerchantData,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';

/** All-defaults extra data — the rendering fallback before the field is seeded. */
const EMPTY_EXTRA_DATA: ProdutoExtraData = produtoExtraDataSchema.parse({});
/** All-null Google Merchant block — the base a first GMD edit builds onto. */
const EMPTY_GOOGLE_MERCHANT: GoogleMerchantData = googleMerchantDataSchema.parse({});

/** Options derived once from the label maps (Select wants string values). */
const CONDICAO_OPTIONS = Object.entries(CONDICAO_PRODUTO_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const AGE_GROUP_OPTIONS = Object.entries(GOOGLE_AGE_GROUP_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const GENDER_OPTIONS = Object.entries(GOOGLE_GENDER_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/** Raw RHF error node for the `extraData` object field. */
interface ExtraDataErrorTree {
  descricao?: { message?: string };
  marca?: { message?: string };
  metaDescricao?: { message?: string };
  youtube?: { message?: string };
  googleMerchantData?: Record<string, { message?: string } | undefined>;
}

export interface ExtraDataManagerProps {
  /** `null` in create mode — nothing to load yet; persisted after first save. */
  produtoId: string | null;
  db: Firestore;
  /** The transient `extraData` form value (null until seeded / edited). */
  value: ProdutoExtraData | null;
  onChange: (next: ProdutoExtraData) => void;
  /**
   * Flipped to `true` once the singleton has resolved (or immediately in create
   * mode). The page's `onAfterSave` reads it so it never persists `extraData`
   * before the existing doc loaded — a fast save can't blow away unread copy.
   */
  readyRef: MutableRefObject<boolean>;
  errorTree?: unknown;
  disabled?: boolean;
}

/**
 * Descrição + Google Merchant tab — editor for the produto's `extraData`
 * singleton (`produtos/<id>/extraData/singleton`). It is a TRANSIENT field on
 * the aggregate page model: validated + rendered here, stripped from the produto
 * doc write, and persisted to its subcollection in the page's `onAfterSave` via
 * `saveProdutoExtraData`.
 *
 * It self-loads the singleton and seeds the transient field once it resolves,
 * re-seeding if ObjectView's produto-doc `reset` wipes the field back to null
 * (guarded by `value == null` so user edits are never clobbered).
 */
export function ExtraDataManager({
  produtoId,
  db,
  value,
  onChange,
  readyRef,
  errorTree,
  disabled,
}: ExtraDataManagerProps) {
  const docRef = useMemo(
    () =>
      produtoId
        ? produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID)
        : null,
    [db, produtoId],
  );
  const snap = useDocSnapshot(docRef);

  // Seed the transient field from the loaded singleton. Re-runs when the
  // produto-doc reset zeroes the field back to null (re-seeds the same doc);
  // never seeds an EMPTY doc when the produto has none (avoids creating a
  // stray singleton on save). Create mode is "ready" immediately.
  useEffect(() => {
    if (!produtoId) {
      readyRef.current = true;
      return;
    }
    if (snap.loading) return;
    readyRef.current = true;
    if (value != null) return;
    if (snap.data) onChange(produtoExtraDataSchema.parse(snap.data.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtoId, snap.loading, snap.data?.id, value]);

  const v = value ?? EMPTY_EXTRA_DATA;
  const gmd = v.googleMerchantData ?? EMPTY_GOOGLE_MERCHANT;
  const tree = (errorTree ?? {}) as ExtraDataErrorTree;
  const gErr = (key: string) => tree.googleMerchantData?.[key]?.message;

  const setField = (patch: Partial<ProdutoExtraData>) => onChange({ ...v, ...patch });
  const setGmd = (patch: Partial<GoogleMerchantData>) =>
    onChange({ ...v, googleMerchantData: { ...gmd, ...patch } });

  return (
    <Stack>
      <Textarea
        label="Descrição"
        description="Descrição do produto (aceita HTML). Até 3000 caracteres."
        autosize
        minRows={4}
        maxRows={12}
        value={v.descricao ?? ''}
        onChange={(e) => setField({ descricao: e.currentTarget.value || null })}
        disabled={disabled}
        error={tree.descricao?.message}
      />
      <TextInput
        label="Marca"
        value={v.marca ?? ''}
        onChange={(e) => setField({ marca: e.currentTarget.value || null })}
        disabled={disabled}
        error={tree.marca?.message}
      />
      <Textarea
        label="Meta descrição"
        description="Resumo para SEO. Até 255 caracteres."
        autosize
        minRows={2}
        maxRows={4}
        value={v.metaDescricao ?? ''}
        onChange={(e) => setField({ metaDescricao: e.currentTarget.value || null })}
        disabled={disabled}
        error={tree.metaDescricao?.message}
      />
      <TagsInput
        label="Palavras-chave"
        description="Pressione Enter para adicionar."
        value={v.keyWords ?? []}
        onChange={(keyWords) => setField({ keyWords: keyWords.length > 0 ? keyWords : null })}
        disabled={disabled}
      />
      <TextInput
        label="YouTube"
        description="URL de um vídeo do produto."
        value={v.youtube ?? ''}
        onChange={(e) => setField({ youtube: e.currentTarget.value || null })}
        disabled={disabled}
        error={tree.youtube?.message}
      />
      <Select
        label="Condição"
        data={CONDICAO_OPTIONS}
        value={String(v.condicao)}
        onChange={(val) => val && setField({ condicao: Number(val) as CondicaoProduto })}
        disabled={disabled}
        allowDeselect={false}
      />
      <Switch
        label="Conteúdo adulto"
        checked={v.coteudoAdulto}
        onChange={(e) => setField({ coteudoAdulto: e.currentTarget.checked })}
        disabled={disabled}
      />

      <Fieldset legend="Google Merchant">
        <Stack>
          <TextInput
            label="Título"
            value={(gmd.title as string | null) ?? ''}
            onChange={(e) => setGmd({ title: e.currentTarget.value || null })}
            disabled={disabled}
            error={gErr('title')}
          />
          <TextInput
            label="Categoria de produto do Google"
            description="ID ou caminho da taxonomia do Google Shopping."
            value={(gmd.google_product_category as string | null) ?? ''}
            onChange={(e) => setGmd({ google_product_category: e.currentTarget.value || null })}
            disabled={disabled}
          />
          <TextInput
            label="Tipo de produto"
            description="Categorização própria (ex.: Página inicial > Mulheres > Vestidos)."
            value={(gmd.product_type as string | null) ?? ''}
            onChange={(e) => setGmd({ product_type: e.currentTarget.value || null })}
            disabled={disabled}
          />
          <Select
            label="Faixa etária"
            data={AGE_GROUP_OPTIONS}
            value={(gmd.age_group as GoogleAgeGroup | null) ?? null}
            onChange={(val) => setGmd({ age_group: (val as GoogleAgeGroup | null) ?? null })}
            disabled={disabled}
            clearable
          />
          <Select
            label="Gênero"
            data={GENDER_OPTIONS}
            value={(gmd.gender as GoogleGender | null) ?? null}
            onChange={(val) => setGmd({ gender: (val as GoogleGender | null) ?? null })}
            disabled={disabled}
            clearable
          />
          <TextInput
            label="Material"
            value={(gmd.material as string | null) ?? ''}
            onChange={(e) => setGmd({ material: e.currentTarget.value || null })}
            disabled={disabled}
          />
          <TextInput
            label="Padrão"
            description="Ex.: bolinhas, listrado, xadrez."
            value={(gmd.pattern as string | null) ?? ''}
            onChange={(e) => setGmd({ pattern: e.currentTarget.value || null })}
            disabled={disabled}
          />
        </Stack>
      </Fieldset>
    </Stack>
  );
}
