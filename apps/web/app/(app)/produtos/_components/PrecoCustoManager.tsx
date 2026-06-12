'use client';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Group,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCalculator, IconHistory } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type Firestore, getDocs } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { buildQuery, limit } from '@delfrance/data';
import { format, money } from '@delfrance/core';
import {
  type ListaDePrecos,
  type Preco,
  type PrecosMap,
  calcularPreco,
  temFormulas,
} from '@delfrance/schemas';
import {
  historicoCustoCollection,
  historicoPrecoCollection,
} from '@/lib/data/historicoCollections';

/** A `listaDePrecos` snapshot row, supplied by the page's bounded query. */
export interface ListaComId {
  id: string;
  data: ListaDePrecos;
}

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
  disabled?: boolean;
}

const brl = (value: number) => format(money(Math.round(value * 100)));

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** One line of either history modal, pre-formatted by the caller. */
interface HistoryRow {
  key: string;
  when: string;
  texto: string;
}

/**
 * Preço/Custo tab — port of the Flutter `PrecoCustoProdutoWidget`
 * (`produtoCadastro.dart:1075-1498`). One price input per ListaDePrecos
 * (active listas always; inactive ones only while the produto still has a
 * price on them), a per-row formula recalc (engine in
 * `@delfrance/schemas/precoCalculo`) and read-only history modals. The
 * `custo` input itself renders as a regular schema field in the same tab —
 * this manager reads it (plus weight/categoria) live via `useFormContext`,
 * so a custo typed but not yet saved feeds the recalc, like the variations
 * generator. All edits land in the form value; nothing writes until save.
 */
export function PrecoCustoManager({
  produtoId,
  db,
  listas,
  listasError,
  value,
  onChange,
  disabled,
}: PrecoCustoManagerProps) {
  const precos = useMemo(() => value ?? {}, [value]);

  // RHF context is typed non-null but IS null outside a provider — see
  // VariationManager for the precedent and rationale.
  const form = useFormContext();

  const [history, setHistory] = useState<{
    title: string;
    loading: boolean;
    rows: HistoryRow[];
    error: string | null;
  } | null>(null);

  // Active listas first (stable input order); inactive ones appended only
  // while a price exists on them, so legacy entries stay visible/removable.
  const rows = useMemo(() => {
    const ativos = listas.filter((l) => l.data.ativo);
    const inativosComPreco = listas.filter((l) => !l.data.ativo && precos[l.id] !== undefined);
    return [...ativos, ...inativosComPreco];
  }, [listas, precos]);

  function setPreco(listaId: string, valor: number | '') {
    const next = { ...precos };
    if (valor === '' || valor === 0) {
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

  async function openHistory(kind: 'preco' | 'custo', lista?: ListaComId) {
    if (!produtoId) return;
    const title =
      kind === 'preco' ? `Histórico de preço — ${lista!.data.nome}` : 'Histórico de custo';
    setHistory({ title, loading: true, rows: [], error: null });
    try {
      if (kind === 'preco') {
        const snap = await getDocs(
          buildQuery(historicoPrecoCollection.ref(db, { produtoId }), [limit(100)]),
        );
        const rows = snap.docs
          .map((d) => ({ id: d.id, data: d.data() }))
          // The ref is `documents/listaDePrecos/<id>` (legacy may omit the
          // prefix) — match by last path segment.
          .filter((r) => r.data.listaDePrecoHistoricoOuterRef.split('/').pop() === lista!.id)
          .sort((a, b) => (b.data.timestamp ?? 0) - (a.data.timestamp ?? 0))
          .map((r) => ({
            key: r.id,
            when: r.data.timestamp ? dateFmt.format(new Date(r.data.timestamp)) : '—',
            texto: `${r.data.valorOriginal != null ? brl(r.data.valorOriginal) : '—'} → ${
              r.data.valorFinal != null ? brl(r.data.valorFinal) : 'removido'
            }`,
          }));
        setHistory({ title, loading: false, rows, error: null });
      } else {
        const snap = await getDocs(
          buildQuery(historicoCustoCollection.ref(db, { produtoId }), [limit(100)]),
        );
        const rows = snap.docs
          .map((d) => ({ id: d.id, data: d.data() }))
          .sort((a, b) => (b.data.timestamp ?? 0) - (a.data.timestamp ?? 0))
          .map((r) => ({
            key: r.id,
            when: r.data.timestamp ? dateFmt.format(new Date(r.data.timestamp)) : '—',
            texto: brl(r.data.valor),
          }));
        setHistory({ title, loading: false, rows, error: null });
      }
    } catch (err) {
      if (err instanceof FirebaseError) {
        setHistory({
          title,
          loading: false,
          rows: [],
          error: `Falha ao carregar o histórico: ${err.code}`,
        });
        return;
      }
      throw err;
    }
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
            <NumberInput
              label={lista.data.nome}
              value={precos[lista.id]?.valor ?? ''}
              onChange={(v) => setPreco(lista.id, typeof v === 'number' ? v : '')}
              disabled={disabled}
              prefix="R$ "
              decimalScale={2}
              min={0.01}
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
              <Tooltip label="Histórico de preço">
                <ActionIcon
                  variant="subtle"
                  mb={4}
                  onClick={() => void openHistory('preco', lista)}
                  aria-label={`Histórico de ${lista.data.nome}`}
                >
                  <IconHistory size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        );
      })}

      {produtoId && (
        <Group>
          <ActionIcon
            variant="subtle"
            onClick={() => void openHistory('custo')}
            aria-label="Histórico de custo"
          >
            <IconHistory size={16} />
          </ActionIcon>
          <Text size="sm" c="dimmed">
            Histórico de custo (somente leitura)
          </Text>
        </Group>
      )}

      <Modal
        opened={history !== null}
        onClose={() => setHistory(null)}
        title={history?.title}
        size="md"
      >
        {history?.loading && <Loader size="sm" />}
        {history?.error && <Alert color="red">{history.error}</Alert>}
        {history && !history.loading && !history.error && history.rows.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhum registro.
          </Text>
        )}
        {history && history.rows.length > 0 && (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Data</Table.Th>
                <Table.Th>Valor</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {history.rows.map((row) => (
                <Table.Tr key={row.key}>
                  <Table.Td>{row.when}</Table.Td>
                  <Table.Td>{row.texto}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Modal>
    </Stack>
  );
}
