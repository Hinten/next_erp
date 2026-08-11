'use client';

import { getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import type { Produto } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';

import { normalizeScanCode } from '../../despacho/checkout/_components/resolveScan';

/**
 * Resolve a scanned SKU to the produto being counted.
 *
 * Every non-match is a NAMED verdict rather than a thrown error, because the
 * counting screen persists each one as an error movimento: a scan that
 * happened on the warehouse floor must leave a trace even when it resolved to
 * nothing. The messages are the ones the operator reads in the "Erros" panel.
 *
 * `limit(2)` is what makes "duplicado" distinguishable from "encontrado" — one
 * extra document read, and without it two produtos sharing a SKU would silently
 * count against whichever the index returned first.
 */
export type VerdictoSku =
  | { kind: 'produto'; produtoId: string; produto: Produto }
  | { kind: 'kit'; produtoId: string; produto: Produto }
  | { kind: 'nao-encontrado' }
  | { kind: 'duplicado' };

export const MENSAGEM_SKU: Record<Exclude<VerdictoSku['kind'], 'produto'>, string> = {
  kit: 'Kits não podem ser lançados no balanço — lance os produtos que o compõem',
  'nao-encontrado': 'SKU não encontrado',
  duplicado: 'SKU duplicado',
};

/** Classify a produto once it has been found — the only branch shared with manual entry. */
export function classificarProduto(produtoId: string, produto: Produto): VerdictoSku {
  // A kit holds no stock of its own (ADR 0014): its availability is derived
  // from its components, and a counted quantity written onto it would ADD to
  // that. So a kit is refused here AND again server-side at finalize.
  return produto.ehKit
    ? { kind: 'kit', produtoId, produto }
    : { kind: 'produto', produtoId, produto };
}

/**
 * Look a scanned code up by SKU. The code is normalized first
 * ({@link normalizeScanCode} — a wedge scanner prepends zeros to numeric SKUs),
 * and the raw form is tried too when it differs, so a SKU that genuinely starts
 * with a zero still resolves.
 */
export async function resolverSkuBalanco(db: Firestore, texto: string): Promise<VerdictoSku> {
  const raw = texto.trim();
  const norm = normalizeScanCode(raw);

  for (const candidato of norm === raw ? [norm] : [norm, raw]) {
    if (!candidato) continue;
    const achados = await getDocs(
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('sku', candidato), limit(2)]),
    );
    if (achados.size > 1) return { kind: 'duplicado' };
    const doc = achados.docs[0];
    if (doc) return classificarProduto(doc.id, doc.data());
  }

  return { kind: 'nao-encontrado' };
}
