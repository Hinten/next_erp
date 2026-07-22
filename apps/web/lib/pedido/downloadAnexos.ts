/**
 * Bulk "Download Anexos" orchestrator — port of
 * `.old/lib/pedido/utils/anexos.dart` (`downloadAnexos`).
 *
 * Improvements over legacy:
 *  - DISTINCT arquivo ids (legacy re-downloaded the same file per item).
 *  - Batch produto / arquivo loads via `getDocsByIds` (legacy was N+1).
 *  - Skip + continue on per-file errors (legacy aborted the batch).
 *  - Always re-fetches pedidos by id (TableView Pipeline may project partial docs).
 *  - Separate downloads with a 250 ms inter-file delay (legacy; no ZIP).
 */
import type { Firestore } from 'firebase/firestore';
import {
  ARQUIVOS_COLLECTION,
  flattenPedidoItens,
  type Arquivo,
  type Pedido,
  type Produto,
} from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';

import {
  downloadArquivo,
  type ArquivoDownloadMeta,
  type DownloadArquivoDeps,
} from '@/lib/arquivos/downloadArquivo';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';

/** Legacy inter-download delay so browsers do not throttle multi-file saves. */
export const DOWNLOAD_ANEXOS_DELAY_MS = 250;

export interface DownloadAnexosResult {
  readonly downloaded: number;
  readonly fromCache: number;
  readonly skipped: number;
  readonly errors: ReadonlyArray<string>;
  /** True when no distinct anexo was found on any resolved product. */
  readonly noneFound: boolean;
}

export interface DownloadAnexosDeps extends DownloadArquivoDeps {
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — override Firestore loaders. */
  readonly loadPedidos?: (ids: ReadonlyArray<string>) => Promise<Map<string, Pedido>>;
  readonly loadProdutos?: (ids: ReadonlyArray<string>) => Promise<Map<string, Produto>>;
  readonly loadArquivos?: (ids: ReadonlyArray<string>) => Promise<Map<string, Arquivo>>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a bare `arquivos/<id>` outer ref into the doc id. Returns null when the
 * shape is wrong (skip that anexo).
 */
export function arquivoIdFromOuterRef(ref: string): string | null {
  const prefix = `${ARQUIVOS_COLLECTION}/`;
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Collect distinct arquivo ids from product anexos, applying the variation
 * parent (`paiId`) fallback. Order is first-seen stable.
 *
 * Pure — takes already-loaded product maps so unit tests need no Firestore.
 */
export function collectDistinctArquivoIds(
  pedidos: ReadonlyArray<Pedido>,
  produtosById: ReadonlyMap<string, Produto>,
): { readonly arquivoIds: string[]; readonly productIdsTouched: string[] } {
  const arquivoIds: string[] = [];
  const seenArquivo = new Set<string>();
  const productIdsTouched: string[] = [];
  const seenProduct = new Set<string>();

  for (const pedido of pedidos) {
    const itens = flattenPedidoItens(pedido.itens ?? {});
    for (const item of itens) {
      const rawUid = item.produtoUid;
      if (!rawUid) continue;
      // Wire sometimes stores a path; normalize to doc id.
      const produtoId = rawUid.includes('/') ? (rawUid.split('/').pop() ?? rawUid) : rawUid;
      const produto = produtosById.get(produtoId);
      if (!produto) continue;

      let owner = produto;
      if (produto.paiId) {
        const parentId = produto.paiId.includes('/')
          ? (produto.paiId.split('/').pop() ?? produto.paiId)
          : produto.paiId;
        const parent = produtosById.get(parentId);
        if (!parent) continue;
        owner = parent;
        if (!seenProduct.has(parentId)) {
          seenProduct.add(parentId);
          productIdsTouched.push(parentId);
        }
      } else if (!seenProduct.has(produtoId)) {
        seenProduct.add(produtoId);
        productIdsTouched.push(produtoId);
      }

      for (const anexo of owner.anexos ?? []) {
        const id = arquivoIdFromOuterRef(anexo.arquivoOuterRef);
        if (!id || seenArquivo.has(id)) continue;
        seenArquivo.add(id);
        arquivoIds.push(id);
      }
    }
  }

  return { arquivoIds, productIdsTouched };
}

/** Prefer originalFilename; disambiguate collisions within one batch. */
export function fileNamesForBatch(
  metas: ReadonlyArray<{ id: string; originalFilename: string | null; filename: string }>,
): Map<string, string> {
  const preferred = new Map<string, string>();
  const used = new Map<string, string>(); // lower(name) → first id

  for (const m of metas) {
    const base = (m.originalFilename?.trim() || m.filename || m.id).trim() || m.id;
    const key = base.toLowerCase();
    const prior = used.get(key);
    if (prior && prior !== m.id) {
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      preferred.set(m.id, `${stem}-${m.id.slice(0, 8)}${ext}`);
    } else {
      preferred.set(m.id, base);
      if (!prior) used.set(key, m.id);
    }
  }
  return preferred;
}

/**
 * Collect product ids that must be loaded for the given pedidos (items + any
 * `paiId` parents of those items). Two-wave: first wave is item uids; second
 * is parents of loaded variations not already in the set.
 */
export function productIdsFromPedidos(pedidos: ReadonlyArray<Pedido>): string[] {
  const ids = new Set<string>();
  for (const pedido of pedidos) {
    for (const item of flattenPedidoItens(pedido.itens ?? {})) {
      const raw = item.produtoUid;
      if (!raw) continue;
      const id = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function parentIdsMissing(
  produtos: ReadonlyMap<string, Produto>,
  already: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const p of produtos.values()) {
    if (!p.paiId) continue;
    const parentId = p.paiId.includes('/') ? (p.paiId.split('/').pop() ?? p.paiId) : p.paiId;
    if (parentId && !already.has(parentId)) out.push(parentId);
  }
  return out;
}

function toMeta(id: string, arquivo: Arquivo, fileName: string): ArquivoDownloadMeta | null {
  const url = arquivo.url;
  if (!url) return null;
  return {
    id,
    url,
    contentType: arquivo.contentType ?? 'application/octet-stream',
    fileName,
  };
}

/**
 * Run the bulk download for the given pedido ids.
 */
export async function downloadAnexos(
  db: Firestore,
  pedidoIds: ReadonlyArray<string>,
  deps: DownloadAnexosDeps = {},
): Promise<DownloadAnexosResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const delayMs = deps.delayMs ?? DOWNLOAD_ANEXOS_DELAY_MS;
  const errors: string[] = [];

  if (pedidoIds.length === 0) {
    return { downloaded: 0, fromCache: 0, skipped: 0, errors: [], noneFound: true };
  }

  const loadPedidos = deps.loadPedidos ?? (async (ids) => getDocsByIds(db, pedidoCollection, ids));
  const loadProdutos =
    deps.loadProdutos ?? (async (ids) => getDocsByIds(db, produtoCollection, ids));
  const loadArquivos =
    deps.loadArquivos ?? (async (ids) => getDocsByIds(db, arquivoCollection, ids));

  const pedidosMap = await loadPedidos([...new Set(pedidoIds)]);
  const pedidos = [...pedidosMap.values()];
  if (pedidos.length === 0) {
    return { downloaded: 0, fromCache: 0, skipped: 0, errors: [], noneFound: true };
  }

  // Wave 1: item products; wave 2: variation parents.
  const itemIds = productIdsFromPedidos(pedidos);
  const produtos = new Map(await loadProdutos(itemIds));
  const parentIds = parentIdsMissing(produtos, new Set(produtos.keys()));
  if (parentIds.length > 0) {
    const parents = await loadProdutos(parentIds);
    for (const [id, p] of parents) produtos.set(id, p);
  }

  const { arquivoIds } = collectDistinctArquivoIds(pedidos, produtos);
  if (arquivoIds.length === 0) {
    return { downloaded: 0, fromCache: 0, skipped: 0, errors: [], noneFound: true };
  }

  const arquivos = await loadArquivos(arquivoIds);
  const nameInputs: Array<{ id: string; originalFilename: string | null; filename: string }> = [];
  for (const id of arquivoIds) {
    const a = arquivos.get(id);
    if (!a) {
      errors.push(`Arquivo ${id} não encontrado`);
      continue;
    }
    nameInputs.push({
      id,
      originalFilename: a.originalFilename,
      filename: a.filename,
    });
  }
  const names = fileNamesForBatch(nameInputs);

  const metas: ArquivoDownloadMeta[] = [];
  for (const row of nameInputs) {
    const a = arquivos.get(row.id)!;
    const meta = toMeta(row.id, a, names.get(row.id) ?? row.filename);
    if (!meta) {
      errors.push(`Arquivo ${row.id} sem URL`);
      continue;
    }
    metas.push(meta);
  }

  if (metas.length === 0) {
    return {
      downloaded: 0,
      fromCache: 0,
      skipped: errors.length,
      errors,
      noneFound: true,
    };
  }

  let downloaded = 0;
  let fromCache = 0;
  let skipped = errors.length;

  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i]!;
    const result = await downloadArquivo(meta, deps);
    if (result.ok) {
      downloaded += 1;
      if (result.fromCache) fromCache += 1;
    } else {
      skipped += 1;
      errors.push(result.reason);
    }
    if (i < metas.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    downloaded,
    fromCache,
    skipped,
    errors,
    noneFound: downloaded === 0 && nameInputs.length === 0,
  };
}
