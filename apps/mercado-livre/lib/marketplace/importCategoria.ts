/**
 * ERP Categoria chain from an ML category (ML→ERP) — issue #442. The category
 * detail response (`GET /categories/{id}`) carries `path_from_root: [{id, name}, ...]`,
 * the FULL ancestor chain INCLUDING the category itself as the last entry — so a
 * SINGLE `api.getCategory` call builds the whole chain. The legacy Flutter importer
 * walked the tree with one HTTP call PER ancestor (`detalhar_categoria`, chasing
 * `categoriaPaiId` upward); this port collapses that to one call.
 *
 * Dual-run convergence: a `Categoria` doc id is the ML category id (e.g.
 * `MLB1055`), matching Flutter's `Categoria.fromMercadoLivre` — both apps write
 * the SAME doc id, so a doc created by either side is shared. Writes are
 * CREATE-IF-ABSENT ONLY (`docRef.create()`, swallowing ALREADY_EXISTS): an
 * existing `categorias/<id>` doc — Flutter-written or ERP-curated — is NEVER
 * overwritten by an import.
 *
 * `nomeCompleto` is a breadcrumb of NAMES (`Roupas > Camisetas`), not ids — a
 * deliberate, cosmetic deviation from the legacy chain (which joined ids); it
 * reads better in the UI and nothing keys off its format.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreError,
  type MlCategory,
} from '@delfrance/integrations-mercado-livre';
import { type Categoria, toOuterRef } from '@delfrance/schemas';
import { categoriaCollection } from '@delfrance/data/admin/collections';

import { isAlreadyExists } from './grpcErrors';

export interface CategoriaChain {
  docs: Array<{ id: string; data: Categoria }>;
  leafOuterRef: string | null;
}

interface ChainNode {
  id: string;
  name: string | null;
}

/**
 * Pure assembly of the root→leaf `Categoria` doc chain from an ML category
 * detail. `path_from_root` normally already ends with the category itself; the
 * defensive append covers a response that omits it (or is empty/absent).
 */
export function buildCategoriaChain(detail: MlCategory, now: number): CategoriaChain {
  if (!detail.id) return { docs: [], leafOuterRef: null };

  const fromRoot: ChainNode[] = (detail.path_from_root ?? [])
    .filter((n): n is { id: string; name?: string | null } => !!n.id)
    .map((n) => ({ id: n.id, name: n.name ?? null }));

  const nodes: ChainNode[] =
    fromRoot.length > 0 && fromRoot[fromRoot.length - 1]!.id === detail.id
      ? fromRoot
      : [...fromRoot, { id: detail.id, name: detail.name ?? null }];

  const label = (n: ChainNode): string => (n.name && n.name.length > 0 ? n.name : n.id);

  const docs = nodes.map((node, i) => {
    const data: Categoria = {
      nome: label(node),
      nomeCompleto: nodes
        .slice(0, i + 1)
        .map(label)
        .join(' > '),
      permiteCadastro: true,
      categoriaGoogleId: null,
      categoriaPaiOuterRef: i === 0 ? null : toOuterRef(`categorias/${nodes[i - 1]!.id}`),
      timestamp: now,
    };
    return { id: node.id, data };
  });

  const leafId = nodes[nodes.length - 1]!.id;
  return { docs, leafOuterRef: toOuterRef(`categorias/${leafId}`) };
}

/**
 * IO: fetch the ML category, build the chain, create any missing `Categoria`
 * docs (create-if-absent), and return the leaf outer-ref to link onto the
 * produto. Best-effort against the ML API — a category-lookup failure must
 * never block the produto import — but a Firestore infra failure propagates
 * (retryable: the import should be retried, not silently missing a category).
 */
export async function importCategoriaChain(
  deps: { db: Firestore; api: MercadoLivreApi },
  categoryId: string,
  now: number,
): Promise<string | null> {
  let detail: MlCategory;
  try {
    detail = await deps.api.getCategory(categoryId);
  } catch (err) {
    if (err instanceof MercadoLivreError) return null; // best-effort: skip the category, keep the import
    throw err;
  }

  const chain = buildCategoriaChain(detail, now);
  for (const doc of chain.docs) {
    try {
      await categoriaCollection
        .docRef(deps.db, {}, doc.id)
        .create(categoriaCollection.parse(doc.data));
    } catch (err) {
      if (isAlreadyExists(err)) continue; // an existing categoria (either app) is never overwritten
      throw err;
    }
  }
  return chain.leafOuterRef;
}
