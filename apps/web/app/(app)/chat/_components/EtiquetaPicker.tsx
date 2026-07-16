'use client';

import { Group, Tooltip, UnstyledButton } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { ETIQUETA_CORES, argbToRgba } from '@/lib/chat/etiquetaCores';

/**
 * The seven-colour etiqueta picker (legacy `_coresEtiqueta` row,
 * `.old/lib/chat/menu_lateral.dart:208-260`): seven colour dots plus a "clear"
 * (X) dot. Controlled — `value` is a `cor_etiqueta` ARGB int or `null` (none).
 */
export function EtiquetaPicker({
  value,
  onChange,
  size = 22,
}: {
  value: number | null;
  onChange: (cor: number | null) => void;
  size?: number;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      <Tooltip label="Sem etiqueta" withArrow>
        <UnstyledButton
          aria-label="Sem etiqueta"
          aria-pressed={value == null}
          onClick={() => onChange(null)}
          style={(theme) => ({
            width: size,
            height: size,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `${value == null ? 2.5 : 1}px solid ${
              value == null ? theme.colors.blue[6] : theme.colors.gray[4]
            }`,
          })}
        >
          <IconX size={size * 0.6} />
        </UnstyledButton>
      </Tooltip>

      {ETIQUETA_CORES.map((cor) => {
        const selected = value === cor;
        return (
          <Tooltip key={cor} label={`Etiqueta ${argbToRgba(cor)}`} withArrow>
            <UnstyledButton
              aria-label={`Etiqueta ${cor}`}
              aria-pressed={selected}
              onClick={() => onChange(cor)}
              style={(theme) => ({
                width: size,
                height: size,
                borderRadius: '50%',
                background: argbToRgba(cor),
                border: selected ? `2.5px solid ${theme.colors.blue[6]}` : '1px solid transparent',
                boxShadow: selected ? `0 0 0 2px ${argbToRgba(cor)}` : undefined,
              })}
            />
          </Tooltip>
        );
      })}
    </Group>
  );
}
