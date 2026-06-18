'use client';

import { useEffect, useMemo } from 'react';
import { Fieldset, Group, Stack, Text, TextInput } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { estoqueDisponivel, estoqueProdutoSchema, type EstoqueProduto } from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';

// Depósitos are inherently few (physical warehouses); a bounded, name-ordered
// query is plenty and `ativo` is filtered client-side so it needs no index.
const DEPOSITO_LIMIT = 200;
const ESTOQUE_LIMIT = 500;

/** Depósito doc id from a `documents/depositos/<id>` (or bare) ref string. */
function depositoIdOf(ref: string): string {
  return ref.split('/').filter(Boolean).pop() ?? '';
}

/** A fresh, all-zero estoque row for a depósito the produto has no doc for yet. */
function emptyEstoque(depositoId: string, produtoId: string | null): EstoqueProduto {
  return estoqueProdutoSchema.parse({
    parentId: produtoId,
    depositoOuterRef: `documents/depositos/${depositoId}`,
  });
}

export interface EstoqueManagerProps {
  /** `null` in create mode — nothing to load yet; persisted on first save. */
  produtoId: string | null;
  db: Firestore;
  /** The transient `estoques` form value (null until seeded / edited). */
  value: EstoqueProduto[] | null;
  onChange: (next: EstoqueProduto[]) => void;
  disabled?: boolean;
}

/**
 * Estoque por depósito tab — editor for the produto's `estoques` subcollection
 * (`produtos/<id>/estoques/est-<produtoId>-<depositoId>`). It is a TRANSIENT
 * field on the aggregate page model: validated + rendered here, stripped from
 * the produto doc write, and persisted to its subcollection ATOMICALLY with the
 * produto doc (the page's `transactionWrites` hook).
 *
 * One row per active depósito. `quantidade` / `quantidadeReservada` /
 * `disponível` are shown READ-ONLY — they are owned by stock movements (there is
 * no movement system here yet) — and the screen only edits `localizacao`. A
 * depósito the produto has no estoque doc for yet shows zeros; typing a
 * `localização` creates the doc on save.
 *
 * It self-loads the produto's estoque docs and seeds the transient field once
 * they resolve, re-seeding if ObjectView's produto-doc `reset` wipes the field
 * back to null (guarded by `value == null` so user edits are never clobbered).
 */
export function EstoqueManager({ produtoId, db, value, onChange, disabled }: EstoqueManagerProps) {
  // Active depósitos (bounded, ordered by nome). `ativo` is filtered client-side
  // (treat a missing flag as active, matching the schema default).
  const depositosQuery = useMemo(
    () => buildQuery(depositoCollection.ref(db, {}), [orderByField('nome'), limit(DEPOSITO_LIMIT)]),
    [db],
  );
  const depositosSnap = useSnapshot(depositosQuery);
  const depositos = useMemo(
    () => (depositosSnap.data ?? []).filter((d) => d.data.ativo !== false),
    [depositosSnap.data],
  );

  // The produto's existing estoque docs (edit mode only).
  const estoquesQuery = useMemo(
    () =>
      produtoId
        ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId }), [limit(ESTOQUE_LIMIT)])
        : null,
    [db, produtoId],
  );
  const estoquesSnap = useSnapshot(estoquesQuery);

  // Seed the transient field from the loaded docs. Re-runs when the produto-doc
  // reset zeroes the field back to null (re-seeds the same docs); create mode
  // has nothing to load (value stays null until the user types a localização).
  useEffect(() => {
    if (!produtoId) return;
    if (estoquesSnap.loading) return;
    if (value != null) return;
    onChange((estoquesSnap.data ?? []).map((d) => estoqueProdutoSchema.parse(d.data)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtoId, estoquesSnap.loading, value]);

  const rows = useMemo(() => value ?? [], [value]);
  const byDeposito = useMemo(() => {
    const map = new Map<string, EstoqueProduto>();
    for (const e of rows) map.set(depositoIdOf(e.depositoOuterRef), e);
    return map;
  }, [rows]);

  const setLocalizacao = (depositoId: string, localizacao: string) => {
    const loc = localizacao.length > 0 ? localizacao : null;
    const next = [...rows];
    const i = next.findIndex((e) => depositoIdOf(e.depositoOuterRef) === depositoId);
    if (i >= 0) {
      next[i] = { ...next[i]!, localizacao: loc };
    } else {
      next.push({ ...emptyEstoque(depositoId, produtoId), localizacao: loc });
    }
    onChange(next);
  };

  if (depositosSnap.error) {
    return (
      <Text c="red" size="sm">
        Falha ao carregar depósitos: {depositosSnap.error.message}
      </Text>
    );
  }
  if (depositos.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {depositosSnap.loading ? 'Carregando depósitos…' : 'Nenhum depósito ativo cadastrado.'}
      </Text>
    );
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Quantidade e reservada são controladas por movimentações de estoque. Aqui você define a
        localização do produto em cada depósito.
      </Text>
      {depositos.map((d) => {
        const e = byDeposito.get(d.id);
        const quantidade = e?.quantidade ?? 0;
        const reservada = e?.quantidadeReservada ?? 0;
        return (
          <Fieldset key={d.id} legend={d.data.nome}>
            <Stack gap="xs">
              <Group gap="xl">
                <Text size="sm">
                  Quantidade: <b>{quantidade}</b>
                </Text>
                <Text size="sm">
                  Reservada: <b>{reservada}</b>
                </Text>
                <Text size="sm">
                  Disponível:{' '}
                  <b>{estoqueDisponivel({ quantidade, quantidadeReservada: reservada })}</b>
                </Text>
              </Group>
              <TextInput
                label="Localização"
                placeholder="Ex.: Corredor 3, Prateleira B"
                maxLength={50}
                value={e?.localizacao ?? ''}
                onChange={(ev) => setLocalizacao(d.id, ev.currentTarget.value)}
                disabled={disabled}
              />
            </Stack>
          </Fieldset>
        );
      })}
    </Stack>
  );
}
