'use client';

import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import type { MercadoLivreMedidasSugestao } from '@/lib/mercado-livre/client';
import type { ChartColumn } from '@/lib/mercado-livre/chartSpec';
import { type ChartRowDraft, isFilled } from '@/lib/mercado-livre/chartRows';

/**
 * Review the model's proposed measurements before any of them reach the grid.
 *
 * ⚠️ **Nothing is applied until Confirmar.** That is the whole point of the
 * screen, and it is not caution for its own sake: a measurement that is wrong is
 * indistinguishable from one that is right once it is in the grid, and it ships
 * to buyers. The operator has to see `atual → sugerido` for every cell, with the
 * photo they uploaded next to them, before agreeing.
 *
 * Cells that already hold a value start **unchecked** with the current value
 * shown — visible so they can be accepted deliberately, never overwritten by
 * default. Same rule the attribute agent follows via `preCheckedSuggestionIds`.
 */
export interface SizeChartAiModalProps {
  opened: boolean;
  onClose: () => void;
  /** Null while the call is still out. */
  resultado: MercadoLivreMedidasSugestao | null;
  rows: ChartRowDraft[];
  columns: ChartColumn[];
  /**
   * The chart's main attribute — where each row's size label lives.
   *
   * ⚠️ Not always `SIZE`: a footwear chart's main attribute is `EU_SIZE` or
   * `M_US_SIZE`, and hardcoding `SIZE` would leave every row of this table
   * labelled blank on exactly the domains that motivated the picker.
   */
  mainAttributeId: string;
  /** Applies the accepted cells. Only ever called with a non-empty list. */
  onApply: (aceitas: MercadoLivreMedidasSugestao['sugestoes']) => void;
}

/** Stable identity for one proposed cell; mirrors `medidaCellKey` server-side. */
function cellKey(rowKey: string, attributeId: string): string {
  return `${rowKey}::${attributeId}`;
}

export function SizeChartAiModal({
  opened,
  onClose,
  resultado,
  rows,
  columns,
  mainAttributeId,
  onApply,
}: SizeChartAiModalProps) {
  const sugestoes = useMemo(() => resultado?.sugestoes ?? [], [resultado]);

  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const labelByAttr = useMemo(() => {
    const out = new Map<string, string>();
    for (const column of columns) {
      for (const part of column.parts) out.set(part.attributeId, part.label);
    }
    return out;
  }, [columns]);

  /** The current value of the cell a suggestion lands on, or null when empty. */
  function atualDe(rowKey: string, attributeId: string): string | null {
    const cell = rowByKey.get(rowKey)?.cells[attributeId];
    if (!isFilled(cell)) return null;
    return cell?.value_name ?? cell?.valueList?.map((v) => v.name).join(', ') ?? null;
  }

  // Seeded once per result: the pre-check decision depends on the grid as it was
  // when the suggestion came back, and re-deriving it on every render would undo
  // the operator's own unticking.
  const [marcadas, setMarcadas] = useState<Set<string> | null>(null);
  const seeded = useMemo(() => {
    const next = new Set<string>();
    for (const s of sugestoes) {
      if (atualDe(s.rowKey, s.attributeId) == null) next.add(cellKey(s.rowKey, s.attributeId));
    }
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugestoes]);
  const checked = marcadas ?? seeded;

  function toggle(key: string) {
    setMarcadas((prev) => {
      const next = new Set(prev ?? seeded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const aceitas = sugestoes.filter((s) => checked.has(cellKey(s.rowKey, s.attributeId)));
  const carregando = resultado == null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Medidas sugeridas pela IA"
      size="xl"
      centered
      data-testid="ml-size-chart-ai-modal"
    >
      <Stack gap="md">
        {carregando && <Text size="sm">Lendo a foto da tabela…</Text>}

        {!carregando && (
          <>
            <Fonte resultado={resultado} />

            {sugestoes.length === 0 ? (
              <Alert color="yellow" variant="light" title="Nenhuma medida foi lida">
                O modelo não conseguiu ler nenhuma medida com segurança. Confira se a foto da tabela
                está legível e se os tamanhos da guia batem com os da tabela.
              </Alert>
            ) : (
              <>
                <Group justify="space-between">
                  <Text size="sm">
                    {aceitas.length} de {sugestoes.length} medidas selecionadas.
                  </Text>
                  <Group gap="xs">
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() =>
                        setMarcadas(new Set(sugestoes.map((s) => cellKey(s.rowKey, s.attributeId))))
                      }
                    >
                      Marcar todas
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setMarcadas(new Set())}
                    >
                      Desmarcar todas
                    </Button>
                  </Group>
                </Group>

                <ScrollArea.Autosize mah={420}>
                  <Table striped highlightOnHover withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={40} />
                        <Table.Th>Tamanho</Table.Th>
                        <Table.Th>Medida</Table.Th>
                        <Table.Th>Atual</Table.Th>
                        <Table.Th>Sugerido</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {sugestoes.map((s) => {
                        const key = cellKey(s.rowKey, s.attributeId);
                        const atual = atualDe(s.rowKey, s.attributeId);
                        const size =
                          rowByKey.get(s.rowKey)?.cells[mainAttributeId]?.value_name ??
                          s.rowKey.split('/').pop();
                        return (
                          <Table.Tr key={key}>
                            <Table.Td>
                              <Checkbox
                                checked={checked.has(key)}
                                onChange={() => toggle(key)}
                                aria-label={`Aplicar ${labelByAttr.get(s.attributeId) ?? s.attributeId}`}
                              />
                            </Table.Td>
                            <Table.Td>{size}</Table.Td>
                            <Table.Td>{labelByAttr.get(s.attributeId) ?? s.attributeId}</Table.Td>
                            <Table.Td>
                              {atual == null ? (
                                <Text size="sm" c="dimmed">
                                  vazio
                                </Text>
                              ) : (
                                <Group gap={6}>
                                  <Text size="sm">{atual}</Text>
                                  <Badge size="xs" color="yellow" variant="light">
                                    será substituída
                                  </Badge>
                                </Group>
                              )}
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm" fw={500}>
                                {s.value_name}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              </>
            )}
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onApply(aceitas);
              onClose();
            }}
            disabled={carregando || aceitas.length === 0}
          >
            Aplicar {aceitas.length > 0 ? `(${aceitas.length})` : ''}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * What the model actually saw.
 *
 * ⚠️ `comFoto: false` is the case this exists for. A tabela whose photo predates
 * the resize rollout has no derivative to read, so the agent falls back to the
 * description alone — and a text-only answer to a transcription task is close to
 * worthless. Without this line the operator would blame the model.
 */
function Fonte({ resultado }: { resultado: MercadoLivreMedidasSugestao }) {
  return (
    <Stack gap="xs">
      {!resultado.comFoto && (
        <Alert color="orange" variant="light" title="Sem foto da tabela">
          Nenhuma foto legível foi encontrada nesta tabela de medidas, então o modelo usou apenas a
          descrição. Envie a foto da tabela do fornecedor na aba Fotos para um resultado melhor.
        </Alert>
      )}
      {resultado.truncado && (
        <Alert color="yellow" variant="light" title="A grade foi reduzida">
          Parte da grade ficou de fora do pedido (limite de linhas/colunas, ou dois tamanhos com o
          mesmo nome). As medidas que faltarem precisam ser preenchidas à mão.
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        {resultado.comFoto ? '1 foto + descrição' : 'apenas a descrição'} · {resultado.celulas}{' '}
        células oferecidas ao modelo · nada é gravado até você confirmar.
      </Text>
    </Stack>
  );
}
