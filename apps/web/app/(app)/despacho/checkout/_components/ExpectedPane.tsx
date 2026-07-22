'use client';

import { memo, useMemo, useRef } from 'react';
import { Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import {
  componentProgress,
  kitEquivalents,
  type EngineProduto,
  type ExpectedComponent,
  type ExpectedItem,
} from '@delfrance/schemas';
import { ProdutoFoto } from './ProdutoFoto';
import { useVirtualRows } from '@/components/virtual-rows/useVirtualRows';

const ROW_HEIGHT = 76;

/**
 * A flattened render row. A kit's component sub-rows are lifted into the SAME
 * virtual array as their parent (so one virtualizer covers the whole tree —
 * no nested scroll), tagged with `depth` for indentation.
 */
export type ExpectedRow =
  | { key: string; depth: 0; item: ExpectedItem }
  | { key: string; depth: 1; item: ExpectedItem; component: ExpectedComponent };

/**
 * Flatten the expected items into the virtual row list: drop CONCLUDED items
 * (legacy hid them), keep error items (with their marker), and expand each
 * non-concluded kit into its parent row + one row per component.
 */
export function flattenExpected(expected: readonly ExpectedItem[]): ExpectedRow[] {
  const rows: ExpectedRow[] = [];
  for (const item of expected) {
    if (item.concluido) continue;
    rows.push({ key: item.key, depth: 0, item });
    if (item.ehKit && item.componentes) {
      for (const component of item.componentes) {
        rows.push({ key: `${item.key}:${component.produtoId}`, depth: 1, item, component });
      }
    }
  }
  return rows;
}

function ProgressBadge({ done, total }: { done: number; total: number }) {
  const complete = done >= total && total > 0;
  return (
    <Badge variant="light" color={complete ? 'green' : done > 0 ? 'blue' : 'gray'}>
      {done}/{total}
    </Badge>
  );
}

const ItemRow = memo(function ItemRow({
  db,
  row,
  produtos,
}: {
  db: Firestore;
  row: ExpectedRow;
  produtos: ReadonlyMap<string, EngineProduto>;
}) {
  if (row.depth === 1) {
    const { item, component } = row;
    const produto = produtos.get(component.produtoId) ?? null;
    return (
      <Group gap="sm" wrap="nowrap" h={ROW_HEIGHT} pl={40} pr="xs">
        <ProdutoFoto db={db} produto={produto} size={40} />
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" truncate="end">
            {produto?.nome ?? component.produtoId}
          </Text>
          {produto?.sku && (
            <Text size="xs" c="dimmed">
              {produto.sku}
            </Text>
          )}
        </Stack>
        <ProgressBadge done={componentProgress(item, component)} total={component.requiredTotal} />
      </Group>
    );
  }

  const { item } = row;
  const produto = item.produtoUid !== null ? (produtos.get(item.produtoUid) ?? null) : null;
  const done = item.ehKit ? kitEquivalents(item) : item.launched;

  return (
    <Group gap="sm" wrap="nowrap" h={ROW_HEIGHT} px="xs">
      {item.error !== null ? (
        <Tooltip label={item.error} withArrow>
          <IconAlertCircle size={40} color="var(--mantine-color-red-6)" />
        </Tooltip>
      ) : (
        <ProdutoFoto db={db} produto={produto} size={48} />
      )}
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={500} truncate="end">
            {item.nomeDeVenda ?? produto?.nome ?? 'Sem nome'}
          </Text>
          {item.ehKit && (
            <Badge size="xs" variant="outline" color="grape">
              Kit
            </Badge>
          )}
        </Group>
        {item.sku && (
          <Text size="xs" c="dimmed">
            {item.sku}
          </Text>
        )}
        {item.error !== null && (
          <Text size="xs" c="red">
            {item.error}
          </Text>
        )}
      </Stack>
      <ProgressBadge done={done} total={item.quantidade} />
    </Group>
  );
});

export interface ExpectedPaneProps {
  db: Firestore;
  expected: readonly ExpectedItem[];
  produtos: ReadonlyMap<string, EngineProduto>;
}

/**
 * The "produtos esperados" pane: the remaining items to scan, virtualized, with
 * completed items filtered out and each kit's components flattened inline. Rows
 * are memoed on their `ExpectedItem` reference — a scan replaces exactly one
 * item (the engine structurally shares the rest), so only that row re-renders.
 */
export function ExpectedPane({ db, expected, produtos }: ExpectedPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => flattenExpected(expected), [expected]);
  const { rows: virtualRows, totalSize } = useVirtualRows(rows.length, scrollRef, ROW_HEIGHT);

  return (
    <Stack gap={4} h="100%" style={{ minHeight: 0 }}>
      <Text size="sm" fw={600}>
        Produtos esperados ({rows.filter((r) => r.depth === 0).length})
      </Text>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          border: '1px solid var(--mantine-color-default-border)',
          borderRadius: 8,
        }}
      >
        {rows.length === 0 ? (
          <Text size="sm" c="green" p="md">
            Todos os produtos já foram lançados.
          </Text>
        ) : (
          <div style={{ height: totalSize, position: 'relative' }}>
            {virtualRows.map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={row.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <ItemRow db={db} row={row} produtos={produtos} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Stack>
  );
}
