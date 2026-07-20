'use client';

import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import type { EngineProduto, Produto } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';

/**
 * Turn a raw barcode-wedge string into the `EngineProduto` the pure engine
 * scans, or a "not found" verdict. Resolution order, cheapest first:
 *
 *   1. normalize (trim + zero-strip) the raw code;
 *   2. the PREFETCHED maps built at load (`byId` = the pedido's produtos +
 *      kit components, `bySku` = the same keyed by normalized SKU) — a hit here
 *      is synchronous (the scan pipeline's O(1) hot path, no async);
 *   3. Firestore fallback for a produto NOT in the pedido — by doc id, then by
 *      `sku` equality (so scanning a valid-but-unexpected produto still reaches
 *      the engine, which returns `"Produto não esperado"` rather than a bare
 *      "unknown code");
 *   4. nothing matched → `{ kind: 'not-found' }`, which the reducer turns into a
 *      soft error log row the operator must delete before saving.
 *
 * The engine's own `byProdutoId` / `byComponentId` decide whether a resolved
 * produto FITS; this module only answers "which produto is this code, if any".
 */

/** Prefetched produto lookups, rebuilt on every pedido load. */
export interface ScanIndex {
  /** produto id → engine projection (pedido line produtos + kit components). */
  readonly byId: ReadonlyMap<string, EngineProduto>;
  /** normalized SKU → engine projection (same produtos, keyed by `normalizeScanCode(sku)`). */
  readonly bySku: ReadonlyMap<string, EngineProduto>;
}

export type ResolvedScan =
  | { kind: 'produto'; produto: EngineProduto }
  | { kind: 'not-found'; code: string };

/**
 * Normalize a scanned code: trim surrounding whitespace, then strip leading
 * zeros a wedge scanner may prepend to a numeric SKU (`'0007'` → `'7'`). An
 * all-zero / empty string collapses to `'0'` so it never becomes `''`.
 */
export function normalizeScanCode(raw: string): string {
  const trimmed = raw.trim();
  if (!/^0+\d*$/.test(trimmed)) return trimmed; // non-numeric or no leading zero → as-is
  const stripped = trimmed.replace(/^0+/, '');
  return stripped.length > 0 ? stripped : '0';
}

/** Project a Firestore `Produto` onto the engine's minimal view (id from the doc key). */
function toEngineProduto(id: string, p: Produto): EngineProduto {
  return {
    id,
    nome: p.nome ?? null,
    sku: p.sku ?? null,
    ehKit: p.ehKit,
    componentesKit: p.componentesKit,
    fotos: p.fotos,
  };
}

/**
 * Build the prefetched `ScanIndex` from the load-time produto map. `bySku` uses
 * the LAST produto for a duplicate normalized SKU (arbitrary but stable); the id
 * map is authoritative, so a scanned SKU collision degrades to a produtoUid
 * match on whichever the engine indexes.
 */
export function buildScanIndex(produtos: ReadonlyMap<string, EngineProduto>): ScanIndex {
  const bySku = new Map<string, EngineProduto>();
  for (const p of produtos.values()) {
    if (p.sku) bySku.set(normalizeScanCode(p.sku), p);
  }
  return { byId: produtos, bySku };
}

/**
 * Synchronous prefetched-map lookup — the fast path. Tries the raw text and its
 * normalized form as both a doc id and a SKU. Returns `null` on a miss so the
 * caller can decide whether to pay for the async Firestore fallback.
 */
export function resolveFromIndex(rawText: string, index: ScanIndex): EngineProduto | null {
  const norm = normalizeScanCode(rawText);
  const raw = rawText.trim();
  return (
    index.byId.get(raw) ??
    index.byId.get(norm) ??
    index.bySku.get(norm) ??
    index.bySku.get(normalizeScanCode(raw)) ??
    null
  );
}

/**
 * Full resolution including the async Firestore fallback. Callers should try
 * {@link resolveFromIndex} first and only reach here on a miss (the scan
 * pipeline does exactly this, and queues this call so fallbacks serialize).
 */
export async function resolveScanText(
  db: Firestore,
  rawText: string,
  index: ScanIndex,
): Promise<ResolvedScan> {
  const hit = resolveFromIndex(rawText, index);
  if (hit) return { kind: 'produto', produto: hit };

  const raw = rawText.trim();
  const norm = normalizeScanCode(rawText);

  // By doc id (a doc id can't contain '/', which would build an invalid ref).
  if (raw && !raw.includes('/')) {
    const byId = await getDoc(produtoCollection.docRef(db, {}, raw));
    if (byId.exists()) return { kind: 'produto', produto: toEngineProduto(byId.id, byId.data()) };
  }

  // By SKU equality (try the normalized code, then the raw if it differed).
  for (const candidate of norm === raw ? [norm] : [norm, raw]) {
    if (!candidate) continue;
    const bySku = await getDocs(
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('sku', candidate), limit(1)]),
    );
    const doc = bySku.docs[0];
    if (doc) return { kind: 'produto', produto: toEngineProduto(doc.id, doc.data()) };
  }

  return { kind: 'not-found', code: raw };
}
