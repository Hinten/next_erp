'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type DocumentReference, type Firestore, getDocFromServer } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import {
  CAMPOS_DIMENSOES_KIT,
  custoDoKit,
  dimensoesDoKit,
  idFromRef,
  type CampoDimensoesKit,
  type ComponentesKit,
  type DimensoesKit,
  type Kit,
  type ProdutoMedidas,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { produtoCollection } from '@/lib/data/produtoCollection';

/** A working kit entry: the wire `Kit` plus a transient `_delete` marker. */
type KitDraft = Kit & { _delete?: boolean };

/**
 * Drop staged-deleted components and the transient `_delete` marker before the
 * value is validated/saved (wired as the `componentesKit` field's
 * `prepareForSave`). Returns `null` for an empty map so the produto doc stores a
 * clean `null` rather than `{}`.
 */
export function stripKitForSave(value: unknown): ComponentesKit | null {
  const map = (value ?? {}) as Record<string, KitDraft>;
  const out: ComponentesKit = {};
  for (const [id, entry] of Object.entries(map)) {
    if (entry?._delete) continue;
    const { _delete, ...rest } = entry ?? ({} as KitDraft);
    void _delete;
    out[id] = rest as Kit;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Decide which of the five derived fields to push to the form — pure, so the
 * sync logic is unit-testable without a React render. Returns the
 * `(field, value)` patches only when syncing is on, the produto is a kit, the
 * rollup has resolved, AND the form's current value differs (so a consistent kit
 * isn't needlessly dirtied).
 *
 * ⚠️ A `null` field is SKIPPED, never written. It means one of two things and
 * both must leave the stored value alone: the component reads are still in
 * flight, or `dimensoesDoKit` could not derive that field at all (no component
 * resolved a full box). Writing the estimator's `DIMENSOES_PADRAO` fallback
 * would turn a guess into a stored measurement — the server rollup
 * (`recalcularDimensoesKit`, #1152) skips it for exactly the same reason.
 */
export function kitDimensoesFormPatches(
  syncPesoToForm: boolean,
  ehKit: boolean,
  dimensoesResult: DimensoesKit | null,
  current: Readonly<Partial<Record<CampoDimensoesKit, unknown>>>,
): Array<{ field: CampoDimensoesKit; value: number }> {
  if (!syncPesoToForm || !ehKit || !dimensoesResult) return [];
  const patches: Array<{ field: CampoDimensoesKit; value: number }> = [];
  for (const field of CAMPOS_DIMENSOES_KIT) {
    const value = dimensoesResult[field];
    if (value === null) continue;
    if (current[field] === value) continue;
    patches.push({ field, value });
  }
  return patches;
}

/**
 * The component fields the kit rollup reads, projected out of a raw produto doc.
 * Both read paths (the batched effect and `addComponent`'s validate-and-seed) go
 * through this, so neither can cache a narrower shape than `dimensoesDoKit`
 * expects.
 */
function projetarMedidas(d: Record<string, unknown> | undefined): ProdutoMedidas {
  const num = (k: string) => (d?.[k] as number | null | undefined) ?? null;
  return {
    pesoBrutoKg: num('pesoBrutoKg'),
    pesoLiquidoKg: num('pesoLiquidoKg'),
    alturaCm: num('alturaCm'),
    larguraCm: num('larguraCm'),
    profundidadeCm: num('profundidadeCm'),
    paiId: (d?.paiId as string | null | undefined) ?? null,
  };
}

/** A component that cannot supply its own weight — the rollup needs the parent. */
const semPesoProprio = (m: ProdutoMedidas) => m.pesoBrutoKg === null || m.pesoLiquidoKg === null;

/**
 * A component that cannot supply its own box. Any missing or non-positive axis
 * disqualifies the whole set, because a box needs all three.
 *
 * ⚠️ Gating the parent read on the weight alone is the easy mistake here: a
 * variation very commonly carries a weight but NO dimensions, and then
 * `dimensoesDoKit` has no parent to fall back to and silently loses the kit's
 * real box.
 */
const semCaixaPropria = (m: ProdutoMedidas) =>
  !((m.alturaCm ?? 0) > 0 && (m.larguraCm ?? 0) > 0 && (m.profundidadeCm ?? 0) > 0);

const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtKg = (n: number | null) =>
  n === null
    ? '—'
    : `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
const fmtCm = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/**
 * Produto id from the component `CollectionSelect` value — a
 * `documents/produtos/<id>` doc-path string; the object branch stays for any
 * legacy native-ref value still in flight.
 */
function refToId(ref: unknown): string | null {
  if (typeof ref === 'string' && ref.length > 0) return idFromRef(ref) || null;
  if (ref && typeof ref === 'object' && 'id' in ref) return (ref as DocumentReference).id;
  return null;
}

/** Resolves a component produto's `<sku> - <nome>` for display. */
function ComponentLabel({ db, produtoId }: { db: Firestore; produtoId: string }) {
  const ref = useMemo(() => produtoCollection.docRef(db, {}, produtoId), [db, produtoId]);
  const snap = useDocSnapshot(ref);
  const data = snap.data?.data as { nome?: string | null; sku?: string | null } | undefined;
  const label = data ? `${data.sku ?? 'Sem SKU'} - ${data.nome ?? 'Sem nome'}` : produtoId;
  return (
    <Text size="sm" style={{ flex: 3, minWidth: 0 }}>
      {label}
    </Text>
  );
}

export interface KitManagerProps {
  /** `null` in create mode — the cost recalc still works once components exist. */
  produtoId: string | null;
  db: Firestore;
  /** The form's `componentesKit` value (map component id → Kit; may carry drafts). */
  value: ComponentesKit | null;
  onChange: (next: Record<string, KitDraft> | null) => void;
  disabled?: boolean;
  /**
   * Override the kit gating. Defaults to the form's `ehKit` (the parent kit on
   * its own Kit tab); pass `true` when reusing the manager for a variation child
   * (a kit-variation is implicitly a kit, with no `ehKit` of its own in the form).
   */
  ehKit?: boolean;
  /**
   * Push the computed kit cost into the form's `custo` field (default `true`).
   * Pass `false` for variation-child instances — they have no `custo` field in
   * the parent form; the cost is still shown, just not written.
   */
  syncCustoToForm?: boolean;
  /**
   * Push the computed kit weight into the form's `pesoBrutoKg`/`pesoLiquidoKg`
   * fields (default `true`). Pass `false` for variation-child instances — they
   * have no weight fields in the parent form; the weight is still shown.
   */
  syncPesoToForm?: boolean;
  /**
   * Extra produto ids to hide from the component picker (beyond `produtoId`
   * itself, always excluded) — e.g. the kit's variation children. Mirrors the
   * Flutter `optionsFilter` (excludes self + variations).
   */
  excludeIds?: string[];
}

/**
 * Kit tab — port of the Flutter `KitWidget` / `KitManagerWidget`
 * (`produtoCadastro.dart:1918`). Lists the kit's components (each a produto:
 * `quantidade ≥ 1` + `limitarEstoque`), with a staged-deletion trash button
 * (mark → undo → removed on save). The kit cost is DYNAMIC (Flutter `getCusto`,
 * `produtoTableProvider.dart:1339`): Σ(component custo × quantidade) — read once
 * per component (`custoDoKit`, a single batched read) and pushed live into the
 * read-only `custo` field on any component/quantidade change. Gated on `ehKit`
 * (read live via `useFormContext`). `componentesKit` is a produto DOC field — it
 * rides the normal ObjectView save.
 */
export function KitManager({
  produtoId,
  db,
  value,
  onChange,
  disabled,
  ehKit: ehKitProp,
  syncCustoToForm = true,
  syncPesoToForm = true,
  excludeIds,
}: KitManagerProps) {
  // RHF context is typed non-null but IS null outside a provider (ObjectView
  // mounts FormProvider) — guard with `?.`, mirroring PrecoCustoManager.
  const form = useFormContext();
  // Parent kit: gate on the form's `ehKit`. Variation child: caller forces it.
  const ehKit = ehKitProp ?? form?.watch('ehKit') === true;

  // The produto itself + its variations can't be its own components (Flutter
  // `optionsFilter`). `produtoId` is always excluded; the caller adds variations.
  const pickerExcludeIds = useMemo(
    () => [...(produtoId ? [produtoId] : []), ...(excludeIds ?? [])],
    [produtoId, excludeIds],
  );

  const components = useMemo(() => (value ?? {}) as Record<string, KitDraft>, [value]);
  const [pickerValue, setPickerValue] = useState<unknown>(null);
  // Component costs read once per component (a component's `custo` doesn't change
  // while editing this kit) — the kit cost re-sums from this cache on any
  // quantidade change without re-reading. `faltando` = components with no custo.
  // The cache also holds each component PARENT's cost (keyed by `paiId`) so the
  // variation-child cost fallback can resolve from it.
  const [custoCache, setCustoCache] = useState<Record<string, number | null>>({});
  // Component (+ parent) weights AND box, filled from the SAME doc reads as the
  // cost — feeds the dynamic kit rollup (`dimensoesDoKit`).
  const [dimensoesCache, setDimensoesCache] = useState<Record<string, ProdutoMedidas>>({});
  // Each component id → its `paiId` (or null) — feeds the Flutter cost/weight
  // fallback: a variation child with no own value uses its parent's.
  const [paiCache, setPaiCache] = useState<Record<string, string | null>>({});

  const activeIds = useMemo(
    () =>
      Object.entries(components)
        .filter(([, e]) => !e._delete)
        .map(([id]) => id),
    [components],
  );

  // Read each newly-added component's custo + weights (batched); cached ones are
  // reused. ONE doc read feeds BOTH the kit cost and the kit weight — no extra
  // reads. Deps are honest (incl. `custoCache`): on success this re-runs once and
  // no-ops; a transient failure surfaces a notification and self-heals when the
  // components change or the tab remounts.
  useEffect(() => {
    if (!ehKit) return;
    const missing = activeIds.filter((id) => !(id in custoCache));
    if (missing.length === 0) return;
    let cancelled = false;
    const readEntry = async (id: string) => {
      const d = (await getDocFromServer(produtoCollection.docRef(db, {}, id))).data();
      const medidas = projetarMedidas(d);
      return {
        custo: (d?.custo as number | null | undefined) ?? null,
        medidas,
        paiId: medidas.paiId,
      };
    };
    (async () => {
      // Phase 1: read each missing component (custo + weights + paiId) — one read each.
      const comps = await Promise.all(
        missing.map(async (id) => ({ id, ...(await readEntry(id)) })),
      );
      // Phase 2 — Flutter fallback (models.dart:1271-1287 / :1487-1541): a
      // variation child with no own custo/weight inherits its parent's. Read each
      // parent ONCE — dedupe paiIds, skip any already cached (sibling variations
      // share a paiId), and only when some field is actually missing.
      const neededPais = [
        ...new Set(
          comps
            .filter(
              (c) =>
                c.paiId &&
                (c.custo === null || semPesoProprio(c.medidas) || semCaixaPropria(c.medidas)),
            )
            .map((c) => c.paiId as string),
        ),
      ].filter((pid) => !(pid in custoCache));
      const pais = await Promise.all(
        neededPais.map(async (pid) => [pid, await readEntry(pid)] as const),
      );
      if (cancelled) return;
      setCustoCache((c) => ({
        ...c,
        ...Object.fromEntries(comps.map((cm) => [cm.id, cm.custo])),
        ...Object.fromEntries(pais.map(([pid, e]) => [pid, e.custo])),
      }));
      setDimensoesCache((p) => ({
        ...p,
        ...Object.fromEntries(comps.map((cm) => [cm.id, cm.medidas])),
        ...Object.fromEntries(pais.map(([pid, e]) => [pid, e.medidas])),
      }));
      setPaiCache((p) => ({ ...p, ...Object.fromEntries(comps.map((cm) => [cm.id, cm.paiId])) }));
    })().catch((err: unknown) => {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          message: `Falha ao ler os dados dos componentes: ${err.message}`,
        });
        return;
      }
      throw err;
    });
    return () => {
      cancelled = true;
    };
  }, [ehKit, activeIds, custoCache, db]);

  // Kit cost is DYNAMIC (Flutter `getCusto`): Σ(component custo × quantidade).
  // Derived (not state) — `null` until every active component's custo is cached;
  // a component with no custo lands in `faltando` and leaves `custo` untouched.
  const custoResult = useMemo(() => {
    if (activeIds.length === 0) return { custo: null as number | null, faltando: [] as string[] };
    if (activeIds.some((id) => !(id in custoCache))) return null; // wait for reads
    return custoDoKit(stripKitForSave(components) ?? {}, custoCache, paiCache);
  }, [activeIds, custoCache, paiCache, components]);

  // Kit weight AND box are DYNAMIC (Flutter `getPesoBrutoKg`/`getPesoLiquidoKg`
  // for the weight; the box is #1152). `null` until every component is cached —
  // and note `dimensoesDoKit` is the SAME function the `recalcularDimensoesKit`
  // task calls, so the two directions cannot drift.
  const dimensoesResult = useMemo(() => {
    if (activeIds.length === 0) return null;
    if (activeIds.some((id) => !(id in dimensoesCache))) return null; // wait for reads
    return dimensoesDoKit(stripKitForSave(components) ?? {}, dimensoesCache);
  }, [activeIds, dimensoesCache, components]);

  // Push the computed cost into the read-only `custo` form field (writing to the
  // form = an external system, the legitimate use of an effect).
  useEffect(() => {
    if (!syncCustoToForm || !ehKit || !custoResult || custoResult.custo === null) return;
    if (form?.getValues('custo') !== custoResult.custo) {
      form?.setValue('custo', custoResult.custo, { shouldDirty: true });
    }
  }, [syncCustoToForm, ehKit, custoResult, form]);

  // Push the computed weights and box into the "Dimensões e peso" fields. Only
  // when they actually differ, so loading an already-consistent kit doesn't mark
  // the form dirty.
  useEffect(() => {
    const patches = kitDimensoesFormPatches(syncPesoToForm, ehKit, dimensoesResult, {
      pesoBrutoKg: form?.getValues('pesoBrutoKg'),
      pesoLiquidoKg: form?.getValues('pesoLiquidoKg'),
      alturaCm: form?.getValues('alturaCm'),
      larguraCm: form?.getValues('larguraCm'),
      profundidadeCm: form?.getValues('profundidadeCm'),
    });
    for (const { field, value } of patches) {
      form?.setValue(field, value, { shouldDirty: true });
    }
  }, [syncPesoToForm, ehKit, dimensoesResult, form]);

  const setComponent = (id: string, patch: Partial<KitDraft>) => {
    onChange({ ...components, [id]: { ...components[id], ...patch } as KitDraft });
  };

  const toggleDelete = (id: string) => {
    const entry = components[id];
    if (!entry) return;
    const next = { ...components };
    if (entry._delete) {
      const { _delete, ...rest } = entry;
      void _delete;
      next[id] = rest;
    } else {
      next[id] = { ...entry, _delete: true };
    }
    onChange(next);
  };

  const addComponent = async (id: string | null) => {
    if (!id) return;
    if (id === produtoId) {
      notifications.show({
        color: 'yellow',
        message: 'Um produto não pode ser componente de si mesmo.',
      });
      return;
    }
    const existing = components[id];
    if (existing && !existing._delete) {
      notifications.show({ color: 'yellow', message: 'Este componente já foi adicionado.' });
      return;
    }
    if (excludeIds?.includes(id)) {
      // Excluded ids = the kit family (the produto itself + its variations). The
      // picker hides these, but the "Recentes" group is unfiltered, so guard on
      // add too. Generic message — the excluded id may be self, a variation, or
      // (for a per-variation editor) the parent kit / a sibling.
      notifications.show({
        color: 'yellow',
        message: 'Este produto não pode ser componente deste kit.',
      });
      return;
    }
    // A kit cannot be a component of another kit, nor can a variation of THIS
    // produto. The picker hides both, but the unfiltered "Recentes" group + a
    // race (a produto becoming a kit) can still slip through — so validate the
    // picked produto on add, and reuse the read to seed its custo.
    try {
      const snap = await getDocFromServer(produtoCollection.docRef(db, {}, id));
      const data = snap.data();
      if (data?.ehKit === true) {
        notifications.show({
          color: 'yellow',
          message: 'Um kit não pode ser componente de outro kit.',
        });
        return;
      }
      if (produtoId && data?.paiId === produtoId) {
        notifications.show({
          color: 'yellow',
          message: 'Uma variação do próprio produto não pode ser componente do kit.',
        });
        return;
      }
      const own = (data?.custo as number | null | undefined) ?? null;
      const medidas = projetarMedidas(data);
      const paiId = medidas.paiId;
      setPaiCache((p) => ({ ...p, [id]: paiId }));
      const missingField = own === null || semPesoProprio(medidas) || semCaixaPropria(medidas);
      if (missingField && paiId && !(paiId in custoCache)) {
        // Variation child missing custo/weight/box with an UNCACHED parent — read
        // the parent once for the Flutter fallback (`models.dart:1271-1287` / :1487-1541).
        // A parent already cached (e.g. by a sibling component) is reused.
        const pd = (await getDocFromServer(produtoCollection.docRef(db, {}, paiId))).data();
        setCustoCache((c) => ({
          ...c,
          [id]: own,
          [paiId]: (pd?.custo as number | null | undefined) ?? null,
        }));
        setDimensoesCache((p) => ({ ...p, [id]: medidas, [paiId]: projetarMedidas(pd) }));
      } else {
        setCustoCache((c) => ({ ...c, [id]: own }));
        setDimensoesCache((p) => ({ ...p, [id]: medidas }));
      }
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          message: `Falha ao validar o componente: ${err.message}`,
        });
        return;
      }
      throw err;
    }
    // Re-add (un-delete) keeps the previous quantidade; a brand-new one defaults.
    const next = { ...components };
    next[id] = existing
      ? (() => {
          const { _delete, ...rest } = existing;
          void _delete;
          return rest;
        })()
      : { quantidade: 1, limitarEstoque: true, timestamp: null };
    onChange(next);
  };

  const custoKit = custoResult?.custo ?? null;
  const faltando = custoResult?.faltando ?? [];
  const pesoBrutoKit = dimensoesResult?.pesoBrutoKg ?? null;
  const pesoLiquidoKit = dimensoesResult?.pesoLiquidoKg ?? null;
  const caixaKit =
    dimensoesResult &&
    dimensoesResult.alturaCm !== null &&
    dimensoesResult.larguraCm !== null &&
    dimensoesResult.profundidadeCm !== null
      ? dimensoesResult
      : null;

  if (!ehKit) {
    return (
      <Text c="dimmed" size="sm">
        Marque “É kit” acima para definir os componentes do kit.
      </Text>
    );
  }

  const entries = Object.entries(components);

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text size="sm" c="dimmed">
          Produtos que compõem o kit. O custo, o peso e as dimensões do kit são calculados
          automaticamente a partir dos componentes e preenchem os campos Custo e Dimensões.
        </Text>
        <Stack gap={2} align="flex-end" style={{ flexShrink: 0 }}>
          {custoKit !== null && (
            <Text size="sm" fw={600}>
              Custo do kit: {fmtBRL(custoKit)}
            </Text>
          )}
          {(pesoBrutoKit !== null || pesoLiquidoKit !== null) && (
            <Text size="xs" c="dimmed">
              Peso: {fmtKg(pesoBrutoKit)} bruto · {fmtKg(pesoLiquidoKit)} líq.
            </Text>
          )}
          {caixaKit && (
            <Text size="xs" c="dimmed">
              Dimensões: {fmtCm(caixaKit.alturaCm)} × {fmtCm(caixaKit.larguraCm)} ×{' '}
              {fmtCm(caixaKit.profundidadeCm)} cm
            </Text>
          )}
        </Stack>
      </Group>
      {faltando.length > 0 && (
        <Text size="sm" c="orange">
          {faltando.length} componente(s) sem custo cadastrado — o custo do kit não pôde ser
          calculado.
        </Text>
      )}

      {entries.length === 0 && (
        <Text size="sm" c="dimmed">
          Adicione um componente do kit para continuar.
        </Text>
      )}

      {entries.map(([id, entry], index) => {
        const marked = !!entry._delete;
        return (
          <Box
            key={id}
            bg={index % 2 === 1 ? 'gray.0' : undefined}
            style={{ borderRadius: 4, padding: '4px 8px' }}
          >
            <Group wrap="nowrap" align="flex-end" gap="xs" opacity={marked ? 0.55 : 1}>
              <ComponentLabel db={db} produtoId={id} />
              <NumberInput
                label="Qtd"
                min={1}
                step={1}
                allowDecimal={false}
                value={entry.quantidade}
                onChange={(v) => setComponent(id, { quantidade: typeof v === 'number' ? v : 1 })}
                disabled={disabled || marked}
                w={90}
              />
              <Switch
                label="Limita estoque"
                checked={entry.limitarEstoque}
                onChange={(e) => setComponent(id, { limitarEstoque: e.currentTarget.checked })}
                disabled={disabled || marked}
                mb={6}
              />
              {marked && (
                <Badge color="red" variant="light" mb={8}>
                  Será removido
                </Badge>
              )}
              {!disabled && (
                <Tooltip label={marked ? 'Desfazer remoção' : 'Remover componente'}>
                  <ActionIcon
                    variant="subtle"
                    color={marked ? 'blue' : 'red'}
                    mb={4}
                    onClick={() => toggleDelete(id)}
                    aria-label={marked ? `Desfazer remoção ${id}` : `Remover componente ${id}`}
                  >
                    {marked ? <IconArrowBackUp size={16} /> : <IconTrash size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Box>
        );
      })}

      {!disabled && (
        <CollectionSelect
          collection={produtoCollection}
          labelField="nome"
          searchFields={['nome', 'sku']}
          optionHintField="sku"
          fieldName="kit-add-component"
          label="Adicionar componente"
          hint="Selecione um produto para incluir no kit."
          // A kit cannot contain another kit — the picker query excludes them
          // (re-checked on add for the unfiltered "Recentes" group + races).
          filters={[{ field: 'ehKit', op: 'eq', value: false }]}
          // …nor the produto itself or its variations (Flutter `optionsFilter`).
          excludeIds={pickerExcludeIds}
          value={pickerValue}
          onChange={(ref) => {
            void addComponent(refToId(ref));
            setPickerValue(null);
          }}
        />
      )}
    </Stack>
  );
}
