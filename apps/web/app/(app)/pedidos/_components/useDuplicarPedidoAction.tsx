'use client';

/**
 * "Duplicar" row action for `/pedidos` and `/pedidos/entradas` (#370) — port
 * of Flutter `CopiarPedidoAction` (`.old/lib/pedido/pages/pedidoTableView.dart`).
 * With exactly one pedido selected, jumps to the direction's create route
 * (`?copiarDe=<id>`), which pre-fills the form via `buildDuplicarPedidoSeed`
 * (`NovoPedidoView.tsx`'s `NovoPedidoCopia`). `maxSelection: 1` disables the
 * button (with an explanatory title) for zero or multiple rows, matching the
 * legacy "Selecione 1 pedido para copiar" / "Selecione apenas 1 pedido"
 * guard — declaratively, via the ActionBar, instead of a `run`-time snackbar.
 */
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { IconCopy } from '@tabler/icons-react';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';
import { DIRECAO, type Direcao } from './direcao';

export function useDuplicarPedidoAction(direcao: Direcao): {
  readonly action: ActionConfig<Pedido>;
} {
  const router = useRouter();
  const novoPath = DIRECAO[direcao].novoPath;

  const action = useMemo<ActionConfig<Pedido>>(
    () => ({
      id: 'duplicar-pedido',
      label: 'Duplicar',
      color: 'gray',
      icon: <IconCopy size={16} />,
      requiresSelection: true,
      maxSelection: 1,
      run: (rows) => {
        const row = rows[0];
        if (!row) return;
        router.push(`${novoPath}?copiarDe=${encodeURIComponent(row.id)}`);
      },
    }),
    [router, novoPath],
  );

  return { action };
}
