'use client';

import { getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { colapsarPaiEFilhoUnico, type Produto } from '@delfrance/schemas';
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
 * `limit(3)` is what makes "duplicado" distinguishable from "encontrado" — two
 * extra document reads, and without them two produtos sharing a SKU would
 * silently count against whichever the index returned first.
 *
 * ⚠️ Three, not two, because a produto with no variations legitimately puts TWO
 * documents behind one SKU: the sole member copies its parent's SKU verbatim
 * (`upSoleMember.ts:193`), so scanning such a produto answered "SKU duplicado"
 * about a produto that has exactly one SKU. {@link colapsarPaiEFilhoUnico}
 * collapses that pair to the CHILD — where the stock is — and the third read is
 * what tells "a parent and the only member carrying this SKU" apart from "a
 * parent, one of several same-SKU members, and whatever else the index
 * returned". With `limit(2)` the collapse would fire on the second case and
 * count against an arbitrary sibling.
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
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('sku', candidato), limit(3)]),
    );
    // ⚠️ `snap.data()` is NOT memoized — the Firebase SDK re-runs the converter
    // on every call, and this repo's converter is a full `produtoSchema`
    // safeParse (`defineCollection.ts:65-69`). This is the hot path of a
    // warehouse screen driven by a wedge scanner, so each document is parsed
    // exactly once and the value carried forward.
    const candidatos = achados.docs.map((d) => ({ id: d.id, data: d.data() }));
    // A parent and the only member sharing its SKU are one produto; anything
    // else with more than one hit is a real ambiguity the operator has to resolve.
    const membroUnico = colapsarPaiEFilhoUnico(
      candidatos.map((c) => ({ id: c.id, paiId: c.data.paiId, data: c.data })),
    );
    if (membroUnico) return classificarProduto(membroUnico.id, membroUnico.data);
    if (candidatos.length > 1) return { kind: 'duplicado' };
    const unico = candidatos[0];
    if (unico) return classificarProduto(unico.id, unico.data);
  }

  return { kind: 'nao-encontrado' };
}
