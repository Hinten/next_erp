'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import {
  TIPO_MOVIMENTO_ESTOQUE_LABELS,
  estoqueDisponivel,
  historicoEstoqueMeta,
  historicoEstoqueSchema,
  makeEstoqueUid,
} from '@delfrance/schemas';
import { buildQuery, defaultQueryConstraints } from '@delfrance/data';
import type { TipoMovimentacao } from '@delfrance/data/produto';
import { useSnapshot } from '@delfrance/data/hooks';
import { historicoEstoqueCollection } from '@/lib/data/historicoEstoqueCollection';
import { movimentarEstoque } from '@/lib/produtos/clientPort';

const TIPO_OPTIONS: { value: TipoMovimentacao; label: string }[] = [
  { value: 'entrada', label: 'Entrada' },
  { value: 'saida', label: 'Saída' },
  { value: 'balanco', label: 'Balanço' },
];

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Format a ms-epoch timestamp as a pt-BR date+time, or `—` when absent. */
const fmtDate = (ts: number | null | undefined) =>
  typeof ts === 'number' ? new Date(ts).toLocaleString('pt-BR') : '—';

export interface EstoqueMovimentacaoModalProps {
  opened: boolean;
  onClose: () => void;
  db: Firestore;
  produtoId: string;
  depositoId: string;
  /** Header label for the produto being edited (`<sku> - <nome>`). */
  produtoLabel: string;
  depositoNome: string;
  /** Current persisted quantities (read-only display). */
  quantidade: number;
  quantidadeReservada: number;
  /** Whether the estoque doc already exists (drives history load + write path). */
  hasExisting: boolean;
}

/**
 * Conflict-safe stock-movement editor (Flutter `editorDeEstoqueDialog`). Entrada
 * and Saída apply an atomic `increment` to the estoque doc — never overwriting a
 * concurrent movement — while Balanço sets the absolute counted value; every
 * movement appends a `HistoricoEstoque` record. Shows the movement history for
 * the (produto, depósito).
 */
export function EstoqueMovimentacaoModal({
  opened,
  onClose,
  db,
  produtoId,
  depositoId,
  produtoLabel,
  depositoNome,
  quantidade,
  quantidadeReservada,
  hasExisting,
}: EstoqueMovimentacaoModalProps) {
  const [tipo, setTipo] = useState<TipoMovimentacao>('entrada');
  const [qtd, setQtd] = useState<number | string>('');
  const [qtdReservada, setQtdReservada] = useState<number | string>(0);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  const estoqueId = makeEstoqueUid(produtoId, depositoId);

  // The movement history (newest first). Only loads once the estoque doc
  // exists. Built from the meta's defaultQuery so the query shape and its
  // declared index (`historicoEstoque(timestamp desc)`, #407) can never drift.
  const historicoQuery = useMemo(
    () =>
      hasExisting && opened
        ? buildQuery(
            historicoEstoqueCollection.ref(db, { produtoId, estoqueId }),
            defaultQueryConstraints(historicoEstoqueMeta.defaultQuery!),
          )
        : null,
    [hasExisting, opened, db, produtoId, estoqueId],
  );
  const historicoSnap = useSnapshot(historicoQuery);
  const historico = useMemo(
    () => (historicoSnap.data ?? []).map((d) => historicoEstoqueSchema.parse(d.data)),
    [historicoSnap.data],
  );

  const reset = () => {
    setTipo('entrada');
    setQtd('');
    setQtdReservada(0);
    setMotivo('');
  };

  const handleClose = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const handleSave = async () => {
    const quantidadeNum = typeof qtd === 'number' ? qtd : Number(qtd);
    const reservadaNum = typeof qtdReservada === 'number' ? qtdReservada : Number(qtdReservada);
    if (Number.isNaN(quantidadeNum) || Number.isNaN(reservadaNum)) {
      notifications.show({ color: 'red', message: 'Informe uma quantidade válida.' });
      return;
    }
    setSaving(true);
    try {
      await movimentarEstoque({
        produtoId,
        depositoId,
        input: {
          tipo,
          quantidade: quantidadeNum,
          quantidadeReservada: reservadaNum,
          motivo: motivo.trim() === '' ? null : motivo.trim(),
        },
      });
      notifications.show({ color: 'green', message: 'Movimentação salva.' });
      reset();
      onClose();
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao salvar a movimentação',
          message: err.message,
        });
        return;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const qtdLabel = tipo === 'balanco' ? 'Quantidade (contagem)' : 'Quantidade';

  return (
    <Modal opened={opened} onClose={handleClose} title="Edição de estoque" size="lg">
      <Stack>
        <div>
          <Text fw={600}>{produtoLabel}</Text>
          <Text size="sm" c="dimmed">
            Depósito: {depositoNome}
          </Text>
        </div>

        <Group gap="xl">
          <Text size="sm">
            Em estoque: <b>{fmt(quantidade)}</b>
          </Text>
          <Text size="sm">
            Reservado: <b>{fmt(quantidadeReservada)}</b>
          </Text>
          <Text size="sm">
            Disponível: <b>{fmt(estoqueDisponivel({ quantidade, quantidadeReservada }))}</b>
          </Text>
        </Group>

        <Select
          label="Tipo"
          data={TIPO_OPTIONS}
          value={tipo}
          onChange={(v) => v && setTipo(v as TipoMovimentacao)}
          allowDeselect={false}
          disabled={saving}
        />
        <NumberInput
          label={qtdLabel}
          description={
            tipo === 'balanco'
              ? 'Define o valor absoluto contado.'
              : 'Entrada soma; saída subtrai (atômico — não sobrescreve o servidor).'
          }
          value={qtd}
          onChange={setQtd}
          decimalScale={2}
          step={1}
          disabled={saving}
        />
        <NumberInput
          label="Quantidade reservada"
          value={qtdReservada}
          onChange={setQtdReservada}
          decimalScale={2}
          step={1}
          disabled={saving}
        />
        <Textarea
          label="Motivo"
          value={motivo}
          onChange={(e) => setMotivo(e.currentTarget.value)}
          autosize
          minRows={2}
          maxRows={4}
          disabled={saving}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={handleClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Salvar
          </Button>
        </Group>

        <div>
          <Text size="sm" fw={600} mb={4}>
            Movimentações
          </Text>
          {!hasExisting || historico.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nenhuma movimentação registrada.
            </Text>
          ) : (
            <ScrollArea.Autosize mah={220}>
              <Table striped highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Data</Table.Th>
                    <Table.Th>Quantidade</Table.Th>
                    <Table.Th>Reservado</Table.Th>
                    <Table.Th>Tipo</Table.Th>
                    <Table.Th>Motivo</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {historico.map((h, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>{fmtDate(h.timestamp)}</Table.Td>
                      {/* v2 rows carry a signed `movimento`; a legacy row from the
                          migrated corpus has none, and an em-dash is the honest
                          rendering — never a 0, which would read as "no
                          movement" (ADR 0014). */}
                      <Table.Td>{h.movimento == null ? '—' : fmt(h.movimento)}</Table.Td>
                      <Table.Td>
                        {h.movimentoReservada == null ? '—' : fmt(h.movimentoReservada)}
                      </Table.Td>
                      <Table.Td>
                        {h.tipo == null ? '—' : TIPO_MOVIMENTO_ESTOQUE_LABELS[h.tipo]}
                      </Table.Td>
                      <Table.Td>{h.motivo ?? ''}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
        </div>
      </Stack>
    </Modal>
  );
}
