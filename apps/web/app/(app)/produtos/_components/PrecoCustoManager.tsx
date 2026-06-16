'use client';

import { useMemo } from 'react';
import { ActionIcon, Alert, Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconCalculator, IconTrash } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { type ListaDePrecos, type PrecosMap, calcularPreco, temFormulas } from '@delfrance/schemas';
import { CurrencyInput } from './CurrencyInput';
import { ProdutoHistoryButton } from './ProdutoHistoryButton';

/** A `listaDePrecos` snapshot row, supplied by the page's bounded query. */
export interface ListaComId {
  id: string;
  data: ListaDePrecos;
}

/**
 * A working precos entry: the wire `{ valor }` plus a transient `_delete`
 * marker for staged removal. `valor` may be absent while the user is editing
 * (a cleared input) — that surfaces as a validation error, never a silent drop.
 */
interface PrecoDraft {
  valor?: number;
  _delete?: boolean;
}

/** RHF nested error for the `precos` record: `{ [listaId]: { valor: { message } } }`. */
type PrecosErrorTree = Record<string, { valor?: { message?: string } } | undefined> | undefined;

/**
 * Drop staged-deleted entries and the transient `_delete` marker before the
 * value is validated/saved (wired as the precos field's `prepareForSave`).
 * Kept entries keep their `valor` as-is — an empty one stays so Zod flags it
 * (a price is removed only by the trash button, never by clearing the input).
 */
export function stripPrecosForSave(value: unknown): Record<string, { valor: number }> | null {
  const map = (value ?? {}) as Record<string, PrecoDraft>;
  const out: Record<string, { valor: number }> = {};
  for (const [listaId, entry] of Object.entries(map)) {
    if (entry?._delete) continue;
    const { _delete, ...rest } = entry ?? {};
    void _delete;
    out[listaId] = rest as { valor: number };
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface PrecoCustoManagerProps {
  /** `null` in create mode — prices still editable, history buttons hidden. */
  produtoId: string | null;
  db: Firestore;
  listas: ListaComId[];
  /** Load error from the page's listas snapshot — surfaced, never swallowed. */
  listasError?: string;
  /** The form's `precos` value (map keyed by lista doc id; may carry drafts). */
  value: PrecosMap;
  onChange: (next: Record<string, PrecoDraft> | null) => void;
  /** RHF error node for `precos` (per-lista `valor` validation messages). */
  errorTree?: unknown;
  disabled?: boolean;
}

/**
 * Preço/Custo tab — port of the Flutter `PrecoCustoProdutoWidget`
 * (`produtoCadastro.dart:1075-1498`). One BRL-masked price input per
 * ListaDePrecos (active listas always; inactive ones only while the produto
 * still has a price on them), a per-row formula recalc (engine in
 * `@delfrance/schemas/precoCalculo`), a read-only price-history button and a
 * staged-deletion trash button (mark → undo → removed on save, per the
 * app-wide convention). Editing to 0/empty does NOT remove — it surfaces a
 * validation error. The `custo` input renders as its own field (`CustoField`);
 * this manager reads it (plus weight/categoria) live via `useFormContext` so a
 * custo typed but not yet saved feeds the recalc.
 */
export function PrecoCustoManager({
  produtoId,
  db,
  listas,
  listasError,
  value,
  onChange,
  errorTree,
  disabled,
}: PrecoCustoManagerProps) {
  const precos = useMemo(() => (value ?? {}) as Record<string, PrecoDraft>, [value]);
  const precosErrors = (errorTree ?? {}) as NonNullable<PrecosErrorTree>;

  // RHF context is typed non-null but IS null outside a provider — see
  // VariationManager for the precedent and rationale.
  const form = useFormContext();

  // Active listas first (stable input order); inactive ones appended only
  // while a price exists on them, so legacy entries stay visible/removable.
  const rows = useMemo(() => {
    const ativos = listas.filter((l) => l.data.ativo);
    const inativosComPreco = listas.filter((l) => !l.data.ativo && precos[l.id] !== undefined);
    return [...ativos, ...inativosComPreco];
  }, [listas, precos]);

  // Editing only sets the value — a price is never removed by clearing the
  // input (a cleared/`0` value stays so validation can flag it); use the trash
  // button to stage a removal.
  function setPreco(listaId: string, valor: number | null) {
    const next = { ...precos };
    next[listaId] = { ...next[listaId], valor: valor ?? undefined };
    onChange(next);
  }

  function toggleDelete(listaId: string) {
    const entry = precos[listaId];
    if (!entry) return;
    const next = { ...precos };
    if (entry._delete) {
      const { _delete, ...rest } = entry;
      void _delete;
      next[listaId] = rest;
    } else {
      next[listaId] = { ...entry, _delete: true };
    }
    onChange(next);
  }

  /** Live form values feeding the recalc (mirrors `produtoCadastro.dart:1397-1474`). */
  function recalcInputs() {
    const custo = form?.getValues('custo') as number | null | undefined;
    const pesoKg = (form?.getValues('pesoLiquidoKg') as number | null | undefined) ?? 0.25;
    const categoriaRef = form?.getValues('categoriaProdutoOuterRef') as unknown;
    const idCategoria =
      typeof categoriaRef === 'string' ? (categoriaRef.split('/').pop() ?? null) : null;
    return { custo: custo ?? null, pesoKg, idCategoria };
  }

  function recalcular(lista: ListaComId) {
    const { custo, pesoKg, idCategoria } = recalcInputs();
    if (custo === null || custo <= 0) {
      notifications.show({
        color: 'yellow',
        message: 'Informe um custo maior que zero para recalcular.',
      });
      return;
    }
    const preco = calcularPreco(lista.data, custo, { idCategoria, pesoKg });
    if (preco === null) {
      notifications.show({
        color: 'yellow',
        message: 'Não foi possível calcular o preço (nenhuma fórmula aplicável).',
      });
      return;
    }
    setPreco(lista.id, preco.valor);
  }

  return (
    <Stack gap="xs">
      {listasError && (
        <Alert color="red">Falha ao carregar as listas de preços: {listasError}</Alert>
      )}

      {rows.length === 0 && !listasError && (
        <Text size="sm" c="dimmed">
          Nenhuma lista de preços cadastrada.
        </Text>
      )}

      {rows.map((lista) => {
        const { idCategoria } = recalcInputs();
        const entry = precos[lista.id];
        const marked = !!entry?._delete;
        const zodError = precosErrors[lista.id]?.valor?.message;
        const emptyError =
          entry !== undefined && entry.valor == null
            ? 'Informe um preço (ou remova a lista)'
            : undefined;
        // A cleared price shows the localized guidance, not Zod's generic
        // "required" — `emptyError` wins when the value is missing; the Zod
        // message (e.g. the R$ 0,01 minimum) shows for a present-but-invalid one.
        const rowError = marked ? undefined : (emptyError ?? zodError);
        return (
          <Group key={lista.id} wrap="nowrap" align="flex-end" gap="xs" opacity={marked ? 0.55 : 1}>
            <CurrencyInput
              label={lista.data.nome}
              value={entry?.valor ?? null}
              onChange={(v) => setPreco(lista.id, v)}
              disabled={disabled || marked}
              error={rowError}
              style={{ flex: 1, maxWidth: 320 }}
            />
            {marked && (
              <Badge color="red" variant="light" mb={8}>
                Será removida
              </Badge>
            )}
            {!marked && !lista.data.ativo && (
              <Badge color="gray" variant="light" mb={8}>
                inativa
              </Badge>
            )}
            {!marked && lista.data.padrao && (
              <Badge color="blue" variant="light" mb={8}>
                padrão
              </Badge>
            )}
            {!disabled && !marked && (
              <Tooltip label="Recalcular pelo custo (fórmulas da lista)">
                <ActionIcon
                  variant="subtle"
                  mb={4}
                  onClick={() => recalcular(lista)}
                  disabled={!temFormulas(lista.data, idCategoria)}
                  aria-label={`Recalcular ${lista.data.nome}`}
                >
                  <IconCalculator size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            {produtoId && !marked && (
              <ProdutoHistoryButton
                kind="preco"
                db={db}
                produtoId={produtoId}
                listaId={lista.id}
                label={lista.data.nome}
              />
            )}
            {!disabled && entry !== undefined && (
              <Tooltip label={marked ? 'Desfazer remoção' : 'Remover preço desta lista'}>
                <ActionIcon
                  variant="subtle"
                  color={marked ? 'blue' : 'red'}
                  mb={4}
                  onClick={() => toggleDelete(lista.id)}
                  aria-label={
                    marked
                      ? `Desfazer remoção ${lista.data.nome}`
                      : `Remover preço ${lista.data.nome}`
                  }
                >
                  {marked ? <IconArrowBackUp size={16} /> : <IconTrash size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}
