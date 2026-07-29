import { type Firestore, getDocsFromServer } from 'firebase/firestore';
import { buildQuery, whereEqual } from '@delfrance/data';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { makeNomeCompleto, outerRefForCategoriaId } from './nomeCompleto';

export type CategoriaChild = { id: string; nome: string };

export type CategoriaNomeCompletoPatch = {
  id: string;
  nomeCompleto: string;
  ultimaModificacao: number;
};

/**
 * Pure: given direct children and the parent's new breadcrumb, build the
 * patches each child must receive. Format matches {@link makeNomeCompleto}.
 */
export function buildChildNomeCompletoPatches(
  children: CategoriaChild[],
  parentNomeCompleto: string,
): Array<{ id: string; nomeCompleto: string }> {
  return children.map((c) => ({
    id: c.id,
    nomeCompleto: makeNomeCompleto(c.nome, parentNomeCompleto),
  }));
}

export type CascadeNomeCompletoDeps = {
  listDirectChildren: (parentId: string) => Promise<CategoriaChild[]>;
  applyPatches: (patches: CategoriaNomeCompletoPatch[]) => Promise<void>;
  now: () => number;
};

/**
 * BFS recompute of `nomeCompleto` for the whole subtree under `rootId`.
 *
 * Issue #554 AC only requires **direct** children; multi-level BFS is a cheap
 * extension so grandchildren stay consistent when a root renames (materialized
 * breadcrumbs would otherwise go stale one level down).
 *
 * DI seam: unit tests inject list/apply; the client adapter uses classic
 * equality queries on `categoriaPaiOuterRef` (not pipelines — no graph stage).
 */
export async function cascadeNomeCompletoToDescendants(
  deps: CascadeNomeCompletoDeps,
  rootId: string,
  rootNomeCompleto: string,
): Promise<number> {
  // Visited set guards against cycles / duplicate child ids in legacy data so
  // BFS cannot loop forever issuing reads/writes.
  const visited = new Set<string>([rootId]);
  let frontier: Array<{ id: string; nomeCompleto: string }> = [
    { id: rootId, nomeCompleto: rootNomeCompleto },
  ];
  let updated = 0;

  while (frontier.length > 0) {
    const next: Array<{ id: string; nomeCompleto: string }> = [];
    for (const parent of frontier) {
      const children = await deps.listDirectChildren(parent.id);
      const unseen: CategoriaChild[] = [];
      for (const c of children) {
        if (visited.has(c.id)) continue;
        visited.add(c.id);
        unseen.push(c);
      }
      if (unseen.length === 0) continue;
      const now = deps.now();
      const patches: CategoriaNomeCompletoPatch[] = buildChildNomeCompletoPatches(
        unseen,
        parent.nomeCompleto,
      ).map((p) => ({ ...p, ultimaModificacao: now }));
      await deps.applyPatches(patches);
      updated += patches.length;
      for (const p of patches) {
        next.push({ id: p.id, nomeCompleto: p.nomeCompleto });
      }
    }
    frontier = next;
  }

  return updated;
}

/**
 * List every descendant id under `rootId` (BFS, excludes the root itself).
 * Used by the parent picker to block cycles (self + descendants).
 */
export async function listDescendantCategoriaIds(
  listDirectChildren: (parentId: string) => Promise<CategoriaChild[]>,
  rootId: string,
): Promise<string[]> {
  // Same cycle/duplicate guard as the cascade BFS — without it a cycle keeps
  // the parent-picker exclude list loading forever.
  const visited = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const children = await listDirectChildren(id);
      for (const c of children) {
        if (visited.has(c.id)) continue;
        visited.add(c.id);
        out.push(c.id);
        next.push(c.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Client-SDK listing of direct children by parent outer-ref string.
 *
 * First monorepo query that filters on an `*OuterRef` equality — the wire
 * format is a plain string (`documents/categorias/<id>`), so this is a normal
 * equality predicate. Needs the single-field index on `categoriaPaiOuterRef`
 * (Enterprise full-scans otherwise). Forced to the server so a cold cache
 * never silently skips cascade.
 */
export async function listDirectCategoriaChildren(
  db: Firestore,
  parentId: string,
): Promise<CategoriaChild[]> {
  const snap = await getDocsFromServer(
    buildQuery(categoriaCollection.ref(db, {}), [
      whereEqual('categoriaPaiOuterRef', outerRefForCategoriaId(parentId)),
    ]),
  );
  return snap.docs.map((d) => ({
    id: d.id,
    nome: d.data().nome,
  }));
}

/**
 * Apply breadcrumb patches via the collection handle's `merge()` (partial
 * patch — never `setDoc` on a converted ref; see monorepo merge rule).
 * Sequential is fine: categoria trees are small.
 */
export async function applyCategoriaNomeCompletoPatches(
  db: Firestore,
  patches: CategoriaNomeCompletoPatch[],
): Promise<void> {
  for (const p of patches) {
    await categoriaCollection.merge(db, {}, p.id, {
      nomeCompleto: p.nomeCompleto,
      ultimaModificacao: p.ultimaModificacao,
    });
  }
}

/** Wire cascade after a categoria save whose `nomeCompleto` is authoritative. */
export async function cascadeCategoriaNomeCompleto(
  db: Firestore,
  categoriaId: string,
  nomeCompleto: string,
): Promise<number> {
  return cascadeNomeCompletoToDescendants(
    {
      listDirectChildren: (parentId) => listDirectCategoriaChildren(db, parentId),
      applyPatches: (patches) => applyCategoriaNomeCompletoPatches(db, patches),
      now: () => Date.now(),
    },
    categoriaId,
    nomeCompleto,
  );
}

/** Descendant ids for the parent picker (self is added by the caller). */
export async function listDescendantIdsForPicker(db: Firestore, rootId: string): Promise<string[]> {
  return listDescendantCategoriaIds(
    (parentId) => listDirectCategoriaChildren(db, parentId),
    rootId,
  );
}
