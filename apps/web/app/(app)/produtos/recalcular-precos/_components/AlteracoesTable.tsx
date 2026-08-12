'use client';

import { useRef } from 'react';
import { ScrollArea, Text } from '@mantine/core';
import { formatReais } from '@delfrance/core/money';
import { useVirtualRows } from '@/components/virtual-rows/useVirtualRows';
import type { PrecoAlteracao } from '@/lib/produtos/bulkPreco/types';

export interface AlteracoesTableProps {
  rows: readonly PrecoAlteracao[];
}

const ROW_HEIGHT = 44;
const TABLE_HEIGHT = 440;

// Shared by the header and every body row so columns stay aligned without a
// real <table> (a real table can't have absolutely-positioned virtual rows).
const COLUMN_TEMPLATE = '120px minmax(160px, 1fr) 110px 110px 110px 110px minmax(180px, 1.6fr)';

function money(value: number | null): string {
  return value === null ? '—' : formatReais(value);
}

function DiferencaCell({ atual, novo }: { atual: number | null; novo: number | null }) {
  if (atual === null || novo === null) return <Text size="sm">—</Text>;
  const diff = novo - atual;
  if (diff === 0) return <Text size="sm">—</Text>;
  return (
    <Text size="sm" c={diff > 0 ? 'teal' : 'red'} fw={500}>
      {diff > 0 ? '+' : ''}
      {formatReais(diff)}
    </Text>
  );
}

/**
 * Results table for the bulk price-recalculation screen (#544). Virtualized
 * via the shared `useVirtualRows` (promoted from the checkout screen) — a
 * full catalog recalculation can produce thousands of rows.
 */
export function AlteracoesTable({ rows }: AlteracoesTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows: virtualRows, totalSize } = useVirtualRows(rows.length, scrollRef, ROW_HEIGHT);

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLUMN_TEMPLATE,
          gap: 8,
          padding: '8px 12px',
          fontWeight: 600,
          fontSize: 'var(--mantine-font-size-sm)',
          borderBottom: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Text size="sm" fw={600}>
          Sku
        </Text>
        <Text size="sm" fw={600}>
          Nome
        </Text>
        <Text size="sm" fw={600}>
          Custo
        </Text>
        <Text size="sm" fw={600}>
          Preço Atual
        </Text>
        <Text size="sm" fw={600}>
          Novo Preço
        </Text>
        <Text size="sm" fw={600}>
          Diferença
        </Text>
        <Text size="sm" fw={600}>
          Erro
        </Text>
      </div>

      {rows.length === 0 ? (
        <Text size="sm" c="dimmed" p="md">
          Nenhum produto calculado.
        </Text>
      ) : (
        <ScrollArea viewportRef={scrollRef} h={TABLE_HEIGHT} offsetScrollbars>
          <div style={{ height: totalSize, position: 'relative' }}>
            {virtualRows.map((vr) => {
              const row = rows[vr.index]!;
              const hasErro = row.erro !== null;
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
                    display: 'grid',
                    gridTemplateColumns: COLUMN_TEMPLATE,
                    gap: 8,
                    alignItems: 'center',
                    padding: '0 12px',
                    backgroundColor: hasErro ? 'var(--mantine-color-red-light)' : undefined,
                    borderBottom: '1px solid var(--mantine-color-default-border)',
                  }}
                >
                  <Text size="sm" truncate="end">
                    {row.sku ?? '—'}
                  </Text>
                  <Text size="sm" truncate="end">
                    {row.nome}
                  </Text>
                  <Text size="sm">{money(row.custo)}</Text>
                  <Text size="sm">{money(row.precoAtual)}</Text>
                  <Text size="sm">{money(row.precoNovo)}</Text>
                  <DiferencaCell atual={row.precoAtual} novo={row.precoNovo} />
                  <Text size="xs" c="red" truncate="end">
                    {row.erro ?? ''}
                  </Text>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
