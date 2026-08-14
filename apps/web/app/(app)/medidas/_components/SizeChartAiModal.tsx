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
import { aiCellKey, preCheckedCells } from '@delfrance/ai';
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

/**
 * ⚠️ `aiCellKey` and `preCheckedCells` are IMPORTED, not reimplemented.
 *
 * Both ship from `@delfrance/ai` with their own unit tests, and this modal is
 * their only production consumer — a local copy of the key and of the pre-check
 * rule would have meant two implementations of a rule the stack deliberately
 * factored out, with the tested ones having no caller at all.
 */

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
  // the operator's own unticking. The parent remounts this component per run
  // (`key={aiRun}`), so `marcadas` never survives into a later suggestion.
  const [marcadas, setMarcadas] = useState<Set<string> | null>(null);
  const seeded = useMemo(
    () =>
      new Set(
        preCheckedCells(sugestoes, (rowKey, attributeId) =>
          isFilled(rowByKey.get(rowKey)?.cells[attributeId]),
        ),
      ),
    [sugestoes, rowByKey],
  );
  const checked = marcadas ?? seeded;

  function toggle(key: string) {
    setMarcadas((prev) => {
      const next = new Set(prev ?? seeded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const aceitas = sugestoes.filter((s) => checked.has(aiCellKey(s.rowKey, s.attributeId)));
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
        {carregando && <Text size="sm">Lendo a tabela de medidas…</Text>}

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
                        setMarcadas(
                          new Set(sugestoes.map((s) => aiCellKey(s.rowKey, s.attributeId))),
                        )
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
                        const key = aiCellKey(s.rowKey, s.attributeId);
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
 * ⚠️ This exists because a text-only answer to a transcription task is close to
 * worthless, and without saying so the operator blames the model. The two
 * photo-less cases carry OPPOSITE instructions, which is why `contexto` reports
 * `fotos` and `anexadas` separately rather than one flag: a tabela with no photo
 * needs one uploaded, while a tabela whose photo has no readable copy yet needs
 * only time — telling that operator to "envie a foto" sends them to redo the
 * thing they just did.
 */
function Fonte({ resultado }: { resultado: MercadoLivreMedidasSugestao }) {
  const { fotos, anexadas, descricao, codigo, referencia } = resultado.contexto;

  // Everything that reached the model, in the order it matters. Listing the
  // sources is what lets the operator judge the ANSWER instead of guessing
  // whether the model was given anything to work with.
  const usados: string[] = [];
  if (fotos > 0) usados.push(fotos === 1 ? '1 foto' : `${String(fotos)} fotos`);
  if (descricao) usados.push('descrição');
  if (codigo) usados.push('código');
  if (referencia) usados.push('1 guia de referência');

  return (
    <Stack gap="xs">
      {fotos === 0 && anexadas === 0 && (
        <Alert color="orange" variant="light" title="Sem foto da tabela">
          Esta tabela de medidas não tem nenhuma foto, então o modelo usou apenas o texto. Envie a
          foto da tabela do fornecedor na aba Fotos para um resultado melhor.
        </Alert>
      )}
      {fotos === 0 && anexadas > 0 && (
        <Alert color="orange" variant="light" title="Não foi possível ler a foto">
          {/*
            ⚠️ Both halves matter. "Not processed yet" is only ONE of the reasons
            a photo that exists cannot be read — a format outside the allowlist,
            a file over the size ceiling, or a batch over the request budget are
            all PERMANENT, and an alert that says only "aguarde" leaves that
            operator retrying forever while forbidding the one action that would
            actually fix it.
          */}
          {anexadas === 1 ? 'A foto desta tabela' : 'As fotos desta tabela'} não
          {anexadas === 1 ? ' pôde' : ' puderam'} ser {anexadas === 1 ? 'lida' : 'lidas'}, então o
          modelo usou apenas o texto. Se a foto acabou de ser enviada, aguarde alguns instantes e
          tente de novo; se continuar, envie uma versão menor ou em JPEG.
        </Alert>
      )}
      {resultado.truncado && (
        <Alert color="yellow" variant="light" title="A grade foi reduzida">
          Parte da grade ficou de fora do pedido (limite de linhas/colunas, ou dois tamanhos com o
          mesmo nome). As medidas que faltarem precisam ser preenchidas à mão.
        </Alert>
      )}
      <Text size="xs" c="dimmed" data-testid="ml-size-chart-ai-fonte">
        {usados.length > 0 ? usados.join(' · ') : 'nenhum contexto disponível'} ·{' '}
        {resultado.celulas} células oferecidas ao modelo · nada é gravado até você confirmar.
      </Text>
    </Stack>
  );
}
