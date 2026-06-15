'use client';

import { useMemo } from 'react';
import { ActionIcon, Alert, Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCalculator } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import {
  type ListaDePrecos,
  type Preco,
  type PrecosMap,
  calcularPreco,
  temFormulas,
} from '@delfrance/schemas';
import { CurrencyInput } from './CurrencyInput';
import { ProdutoHistoryButton } from './ProdutoHistoryButton';

/** A `listaDePrecos` snapshot row, supplied by the page's bounded query. */
export interface ListaComId {
  id: string;
  data: ListaDePrecos;
}

/** RHF nested error for the `precos` record: `{ [listaId]: { valor: { message } } }`. */
type PrecosErrorTree = Record<string, { valor?: { message?: string } } | undefined> | undefined;

export interface PrecoCustoManagerProps {
  /** `null` in create mode — prices still editable, history buttons hidden. */
  produtoId: string | null;
  db: Firestore;
  listas: ListaComId[];
  /** Load error from the page's listas snapshot — surfaced, never swallowed. */
  listasError?: string;
  /** The form's `precos` value (map keyed by lista doc id). */
  value: PrecosMap;
  onChange: (next: Record<string, Preco> | null) => void;
  /** RHF error node for `precos` (per-lista `valor` validation messages). */
  errorTree?: unknown;
  disabled?: boolean;
}

/**
 * Preço/Custo tab — port of the Flutter `PrecoCustoProdutoWidget`
 * (`produtoCadastro.dart:1075-1498`). One BRL-masked price input per
 * ListaDePrecos (active listas always; inactive ones only while the produto
 * still has a price on them), a per-row formula recalc (engine in
 * `@delfrance/schemas/precoCalculo`) and a read-only price-history button. The
 * `custo` input renders as its own field (see `CustoField`) in the same tab —
 * this manager reads it (plus weight/categoria) live via `useFormContext`, so a
 * custo typed but not yet saved feeds the recalc, like the variations
 * generator. All edits land in the form value; nothing writes until save.
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
  const precos = useMemo(() => value ?? {}, [value]);
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

  function setPreco(listaId: string, valor: number | null) {
    const next = { ...precos };
    if (valor === null) {
      // Clearing the input removes the lista's price. A 0/sub-cent value is NOT
      // removed — it stays so Zod (`precoSchema` min 0.01) flags it on save.
      delete next[listaId];
    } else {
      // Spread keeps any passthrough keys Flutter may carry on the entry.
      next[listaId] = { ...next[listaId], valor };
    }
    onChange(Object.keys(next).length > 0 ? next : null);
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
        return (
          <Group key={lista.id} wrap="nowrap" align="flex-end" gap="xs">
            <CurrencyInput
              label={lista.data.nome}
              value={precos[lista.id]?.valor ?? null}
              onChange={(v) => setPreco(lista.id, v)}
              disabled={disabled}
              error={precosErrors[lista.id]?.valor?.message}
              style={{ flex: 1, maxWidth: 320 }}
            />
            {!lista.data.ativo && (
              <Badge color="gray" variant="light" mb={8}>
                inativa
              </Badge>
            )}
            {lista.data.padrao && (
              <Badge color="blue" variant="light" mb={8}>
                padrão
              </Badge>
            )}
            {!disabled && (
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
            {produtoId && (
              <ProdutoHistoryButton
                kind="preco"
                db={db}
                produtoId={produtoId}
                listaId={lista.id}
                label={lista.data.nome}
              />
            )}
          </Group>
        );
      })}
    </Stack>
  );
}
