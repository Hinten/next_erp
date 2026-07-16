'use client';

import { Badge } from '@mantine/core';
import { DIRECAO, type Direcao } from './direcao';

/**
 * The entrada marker badge shared by the list title and the edit-page header.
 * Saída pages carry no badge (the default direction needs no callout), so this
 * renders null for `direcao === 'saida'`.
 */
export function DirecaoBadge({ direcao }: { direcao: Direcao }) {
  if (direcao !== 'entrada') return null;
  return (
    <Badge color="entrada" variant="light">
      {DIRECAO.entrada.docLabel}
    </Badge>
  );
}
