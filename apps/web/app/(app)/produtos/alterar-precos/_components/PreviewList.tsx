'use client';

/**
 * Live preview list for the bulk manual price editor (#545) — port of the
 * legacy `_getListTile` / `_calcularPrevisaoPreco`
 * (`.old/lib/produtos/pages/alterarPrecoMassa.dart:461-515`/`1001-1015`).
 *
 * Purely presentational: `page.tsx` owns the `buildPreviewRows` computation
 * (deferred + memoized there) since the SAME computed rows also feed the
 * pre-apply "Baixar Relatório" button and `AplicarDialog` — this component
 * only needs to know WHY `rows` might be empty (`targetListaId`/`isValid`) to
 * show the right placeholder message, plus the raw selection count for the
 * "Total de Produtos" header (which must stay accurate even before a preview
 * can be computed at all).
 */
import { useRef } from 'react';
import { ActionIcon, Badge, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { formatReais } from '@delfrance/core/money';
import { useVirtualRows } from '@/components/virtual-rows/useVirtualRows';
import type { PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';

export interface PreviewListProps {
  /** Computed preview rows — one per selected produto, empty until a target
   * lista is chosen AND the regra form is valid. */
  rows: PrecoAlteracao[];
  targetListaId: string | null;
  isValid: boolean;
  /** Raw selection count — independent of whether a preview could be computed. */
  totalSelecionados: number;
  onRemove: (produtoId: string) => void;
}

const ROW_HEIGHT = 48;
const LIST_HEIGHT = 420;

/**
 * The right-hand side of the `atual → novo` preview, with the legacy color
 * parity from `_calcularPrevisaoPreco`: no atual price → blue (nothing to
 * compare against); higher → teal `+diff`; lower → red `-diff` (already
 * signed by `formatReais`); equal → `+ R$ 0,00`. `erro`/`foraDosLimites` take
 * priority over all of the above — there's no "novo" to show a diff for.
 */
function NovoPrecoCell({ row }: { row: PrecoAlteracao }) {
  if (row.erro) {
    return (
      <Text size="sm" c="red" truncate="end">
        {row.erro}
      </Text>
    );
  }
  if (row.foraDosLimites) {
    return (
      <Text size="sm" c="dimmed" fs="italic">
        Fora dos limites
      </Text>
    );
  }
  if (row.precoNovo === null) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  if (row.precoAtual === null) {
    return (
      <Text size="sm" c="blue">
        {formatReais(row.precoNovo)}
      </Text>
    );
  }

  // Sibling Text elements (not nested) so the colored diff never ends up as
  // block-inside-block markup — matches the sibling AlteracoesTable's
  // DiferencaCell, just with the base price kept alongside it.
  const diff = row.precoNovo - row.precoAtual;
  const diffColor = diff >= 0 ? 'teal' : 'red';
  const diffLabel =
    diff === 0 ? `+ ${formatReais(0)}` : diff > 0 ? `+${formatReais(diff)}` : formatReais(diff);
  return (
    <Group gap={4} wrap="nowrap">
      <Text size="sm">{formatReais(row.precoNovo)}</Text>
      <Text size="sm" c={diffColor} fw={500}>
        ({diffLabel})
      </Text>
    </Group>
  );
}

export function PreviewList({
  rows,
  targetListaId,
  isValid,
  totalSelecionados,
  onRemove,
}: PreviewListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows: virtualRows, totalSize } = useVirtualRows(rows.length, scrollRef, ROW_HEIGHT);

  const okCount = rows.filter((r) => r.erro === null && r.foraDosLimites !== true).length;
  const foraCount = rows.filter((r) => r.erro === null && r.foraDosLimites === true).length;
  const erroCount = rows.filter((r) => r.erro !== null).length;

  const podeMostrarPreview = targetListaId !== null && isValid;

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Text fw={600}>Total de Produtos: {totalSelecionados}</Text>
          {podeMostrarPreview && rows.length > 0 && (
            <Group gap="xs">
              <Badge color="teal" variant="light">
                {okCount} ok
              </Badge>
              <Badge color="yellow" variant="light">
                {foraCount} fora dos limites
              </Badge>
              <Badge color="red" variant="light">
                {erroCount} com erro
              </Badge>
            </Group>
          )}
        </Group>

        {!targetListaId ? (
          <Text size="sm" c="dimmed">
            Selecione uma tabela de preços
          </Text>
        ) : !isValid ? (
          <Text size="sm" c="dimmed">
            Complete a regra para calcular a prévia
          </Text>
        ) : rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nenhum produto adicionado.
          </Text>
        ) : (
          <ScrollArea viewportRef={scrollRef} h={LIST_HEIGHT} offsetScrollbars>
            <div style={{ height: totalSize, position: 'relative' }}>
              {virtualRows.map((vr) => {
                const row = rows[vr.index]!;
                return (
                  <div
                    key={row.produtoId}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: vr.size,
                      transform: `translateY(${vr.start}px)`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '0 12px',
                      borderBottom: '1px solid var(--mantine-color-default-border)',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" c="dimmed">
                          {row.precoAtual === null ? 'N/A' : formatReais(row.precoAtual)}
                        </Text>
                        <Text size="sm" c="dimmed">
                          →
                        </Text>
                        <NovoPrecoCell row={row} />
                      </Group>
                      <Text size="xs" c="dimmed" truncate="end">
                        ({row.sku ?? 'Sem SKU'}) {row.nome}
                      </Text>
                    </div>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Remover ${row.nome}`}
                      onClick={() => onRemove(row.produtoId)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </Stack>
    </Paper>
  );
}
