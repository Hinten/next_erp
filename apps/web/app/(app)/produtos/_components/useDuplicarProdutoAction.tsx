'use client';

/**
 * "Duplicar" row action for `/produtos` (#556) — port of the legacy
 * `CopiarProdutoAction` (`.old/lib/produtos/pages/produtoTableView.dart`).
 *
 * Unlike pedido's `useDuplicarPedidoAction`, this cannot be a `copyHref`
 * pre-fill: a produto owns variation children, kit composition and
 * marketplace links a plain create-form seed can't touch (the issue's own
 * opening line). `duplicarProduto` writes the clone directly; on success the
 * operator lands on the new produto's editor to review the copy.
 *
 * ⚠️ The clone does NOT inherit the source's exclusive fields — SKU (a fresh
 * unique one is minted per document), GTIN, `codPai`, `codFornecedor`, the
 * marketplace links, the anúncios and the media. `limparParaDuplicar`
 * (`@delfrance/data/produto`) is the single list, with the concrete failure
 * each entry prevents; the editor is where the operator reviews the result,
 * not where they have to repair an identity collision.
 *
 * `maxSelection: 1` disables the button (with an explanatory title) for zero
 * or multiple rows, matching `useDuplicarPedidoAction`'s guard. A thrown
 * `FirebaseError` propagates to the shared `useActionRunner`, which already
 * turns it into a toast (root `CLAUDE.md` rule 6).
 *
 * ⚠️ `ProdutoFamiliaGrandeDemaisError` is the ONE exception, and only because
 * `useActionRunner` re-throws anything that is not a `FirebaseError`: this one
 * is operator-actionable ("split the family, or duplicate it in parts") and
 * would otherwise surface as an unhandled rejection with nothing on screen. It
 * is caught by its own class, never by `Error` — every other rejection, the
 * two sibling produto errors included, still reaches the shared runner.
 */
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { notifications } from '@mantine/notifications';
import { IconCopy } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';
import { duplicarProduto, ProdutoFamiliaGrandeDemaisError } from '@/lib/produtos/duplicar';

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
        let novoId: string;
        try {
          novoId = await duplicarProduto(db, row.id);
        } catch (err) {
          if (!(err instanceof ProdutoFamiliaGrandeDemaisError)) throw err;
          notifications.show({
            color: 'red',
            message:
              'Este produto tem variações e impostos demais para ser duplicado de uma vez. Nada foi criado.',
          });
          return;
        }
        router.push(`/produtos/${novoId}/editar`);
      },
    }),
    [db, router],
  );

  return { action };
}
