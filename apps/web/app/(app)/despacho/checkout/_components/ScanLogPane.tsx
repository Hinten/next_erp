'use client';

import { memo, useRef } from 'react';
import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconTrash, IconTrashOff, IconAlertCircle } from '@tabler/icons-react';
import type { ScanKind, ScanLogEntry } from '@delfrance/schemas';
import { useVirtualRows } from './useVirtualRows';

const KIND_LABEL: Record<Exclude<ScanKind, 'error'>, string> = {
  unit: 'Unidade',
  kit: 'Kit',
  component: 'Componente',
};

const ROW_HEIGHT = 64;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR');
}

export interface ScanLogPaneProps {
  log: readonly ScanLogEntry[];
  onDelete: (uid: string) => void;
}

/** One scan-log row — memoed so replacing one row doesn't re-render the rest. */
const LogRow = memo(function LogRow({
  entry,
  onDelete,
}: {
  entry: ScanLogEntry;
  onDelete: (uid: string) => void;
}) {
  const deleted = entry.excluidoMs !== null;
  const isError = entry.kind === 'error' || entry.error !== null;
  const label = `${entry.produtoSku ? `(${entry.produtoSku}) ` : ''}${entry.produtoNome}${
    entry.quantidade !== 1 ? ` ×${entry.quantidade}` : ''
  }`;

  return (
    <Group gap="xs" wrap="nowrap" h={ROW_HEIGHT} px="xs" style={{ opacity: deleted ? 0.5 : 1 }}>
      {isError && (
        <Tooltip label={entry.error ?? 'Erro'} withArrow>
          <IconAlertCircle size={18} color="var(--mantine-color-red-6)" />
        </Tooltip>
      )}
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500} truncate="end" td={deleted ? 'line-through' : undefined}>
          {label}
        </Text>
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {formatTime(entry.timestampMs)}
          </Text>
          {entry.kind !== 'error' && (
            <Badge size="xs" variant="light" color="gray">
              {KIND_LABEL[entry.kind]}
            </Badge>
          )}
        </Group>
      </Stack>
      {deleted ? (
        <Tooltip
          label={`Excluído em ${entry.excluidoMs ? formatTime(entry.excluidoMs) : ''}`}
          withArrow
        >
          <IconTrashOff size={18} color="var(--mantine-color-dimmed)" />
        </Tooltip>
      ) : (
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label="Excluir lançamento"
          onClick={() => onDelete(entry.uid)}
        >
          <IconTrash size={18} />
        </ActionIcon>
      )}
    </Group>
  );
});

/**
 * The scan audit log — NEWEST AT TOP (legacy was oldest-first with auto-scroll;
 * newest-first removes the scroll-chase). Virtualized so a 1000-scan session
 * renders only the visible rows. Soft-deleted + error rows stay visible (the
 * full audit trail); delete soft-deletes via the engine.
 */
export function ScanLogPane({ log, onDelete }: ScanLogPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Newest at top WITHOUT materializing a reversed copy: virtualize over the
  // live log and map each visible index to its mirror from the end. `log` grows
  // by one every scan, so a per-scan [...log].reverse() would be O(n) → O(n²)
  // over a ~1000-scan session and defeat the "1–2 row re-render" goal.
  const { rows: virtualRows, totalSize } = useVirtualRows(log.length, scrollRef, ROW_HEIGHT);

  return (
    <Stack gap={4} h="100%" style={{ minHeight: 0 }}>
      <Text size="sm" fw={600}>
        Produtos lançados ({log.length})
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
        {log.length === 0 ? (
          <Text size="sm" c="dimmed" p="md">
            Nenhum produto lançado ainda.
          </Text>
        ) : (
          <div style={{ height: totalSize, position: 'relative' }}>
            {virtualRows.map((vr) => {
              // Newest-first: virtual index 0 is the last log entry.
              const entry = log[log.length - 1 - vr.index]!;
              return (
                <div
                  key={entry.uid}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <LogRow entry={entry} onDelete={onDelete} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Stack>
  );
}
