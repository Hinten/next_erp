'use client';

/**
 * "Duplicar" row action for `/produtos` (#556) — port of the legacy
 * `CopiarProdutoAction` (`.old/lib/produtos/pages/produtoTableView.dart`).
 *
 * Unlike pedido's `useDuplicarPedidoAction`, this cannot be a `copyHref`
 * pre-fill: a produto owns variation children, kit composition and
 * marketplace links a plain create-form seed can't touch (the issue's own
 * opening line). `duplicarProduto` writes the clone directly; on success the
 * operator lands on the new produto's editor to review the copy and adjust
 * its SKU(s) — the acceptance criterion is that adjustment happens there, not
 * that this action dedupes them itself.
 *
 * `maxSelection: 1` disables the button (with an explanatory title) for zero
 * or multiple rows, matching `useDuplicarPedidoAction`'s guard. A thrown
 * `FirebaseError` propagates to the shared `useActionRunner`, which already
 * turns it into a toast — nothing to catch here (root `CLAUDE.md` rule 6).
 */
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { IconCopy } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';
import { duplicarProduto } from '@/lib/produtos/duplicar';

export function useDuplicarProdutoAction(db: Firestore): {
  readonly action: ActionConfig<Produto>;
} {
  const router = useRouter();

  const action = useMemo<ActionConfig<Produto>>(
    () => ({
      id: 'duplicar-produto',
      label: 'Duplicar',
      color: 'gray',
      icon: <IconCopy size={16} />,
      requiresSelection: true,
      maxSelection: 1,
      run: async (rows) => {
        const row = rows[0];
        if (!row) return;
        const novoId = await duplicarProduto(db, row.id);
        router.push(`/produtos/${novoId}/editar`);
      },
    }),
    [db, router],
  );

  return { action };
}
