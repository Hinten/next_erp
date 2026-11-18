import { runTransaction, type Firestore } from 'firebase/firestore';
import { valuesEqual } from '@delfrance/core/equality';
import { buildChildrenComponentesKitOps, type ChildComponentesKit } from '@delfrance/data/produto';
import {
  camposDeKitDoMembroUnico,
  ehMembroUnicoImplicito,
  type ComponentesKit,
} from '@delfrance/schemas';
import { AfterSaveBlockedError } from '@delfrance/ui';
import { produtoCollection } from '@/lib/data/produtoCollection';

export interface ChildKitEdit extends ChildComponentesKit {
  baseline: ComponentesKit | null;
}

type KitChildrenChange = { recipes: ChildKitEdit[]; mirrorSoleMember: boolean };

/** Check the live family before replacing any child recipe. */
export async function commitChildKitEdits(
  db: Firestore,
  parentId: string,
  change: KitChildrenChange,
): Promise<void> {
  if (change.recipes.length === 0) return;

  const parentRef = produtoCollection.docRef(db, {}, parentId);
  const childRefs = change.recipes.map(({ id }) => produtoCollection.docRef(db, {}, id));
  await runTransaction(db, async (tx) => {
    const parent = (await tx.get(parentRef)).data();
    if (parent?.ehKit !== true) {
      throw new AfterSaveBlockedError(
        'O status do kit mudou. Recarregue o produto antes de salvar.',
      );
    }

    const snapshots = await Promise.all(childRefs.map((ref) => tx.get(ref)));
    const family = snapshots.filter((child) => child.data()?.paiId === parentId);
    const refs = new Map(family.map((child) => [child.ref.path, child.ref]));
    const byId = new Map(family.map((child) => [child.id, child]));
    const soleMember = change.mirrorSoleMember
      ? family.find((child) =>
          ehMembroUnicoImplicito(
            { ...parent, id: parentId },
            { ...child.data()!, id: child.id },
            change.recipes.length,
          ),
        )
      : undefined;
    const recipes = change.recipes.map((edit) => {
      const child = byId.get(edit.id);
      const current = child?.data();
      if (!current) {
        throw new AfterSaveBlockedError(
          'Uma variação saiu da família. Recarregue o produto antes de salvar.',
        );
      }
      const componentesKit =
        edit.id === soleMember?.id ? parent.componentesKit : edit.componentesKit;
      const currentRecipe = current.componentesKit ?? null;
      if (
        !valuesEqual(currentRecipe, edit.baseline) &&
        !valuesEqual(currentRecipe, componentesKit)
      ) {
        throw new AfterSaveBlockedError(
          `Os componentes de “${current.sku || current.nome || edit.id}” mudaram. Confira a variação antes de salvar novamente.`,
        );
      }
      return { id: edit.id, componentesKit };
    });
    for (const op of buildChildrenComponentesKitOps(recipes)) {
      if (op.type !== 'update') continue;
      if (op.path === soleMember?.ref.path) {
        tx.update(refs.get(op.path)!, camposDeKitDoMembroUnico(parent));
      } else {
        tx.update(refs.get(op.path)!, op.data);
      }
    }
  });
}
