/**
 * Mercado Livre freight backfill (#782, #1888). Enumeration supplies IDs only:
 * apply reconciles current transactional state, and preview reads fresh snapshots.
 * A preview is advisory when accounts or freight configuration change concurrently.
 */
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';
import { intFreteCollection, integracaoCollection } from '@delfrance/data/admin/collections';
import type { DisposicaoIntFrete, PlanoIntFrete } from '@delfrance/data/admin/frete';

import {
  buscarIntFreteDaConta,
  planejarIntFreteDaConta,
  reconciliarIntFreteDaConta,
} from './intFreteSync';

const PAGE_SIZE = 200;

export interface ContaEnumerada {
  readonly id: string;
}

export interface ResultadoBackfillIntFrete {
  contas: number;
  totals: Partial<Record<DisposicaoIntFrete['action'], number>>;
}

export interface OpcoesBackfillIntFrete {
  apply: boolean;
  onConta?: (integracaoId: string, disposicao: DisposicaoIntFrete) => void;
}

/**
 * Page by the existing `integracao(tipo, nome)` index. A `__name__` ordering
 * would need a new index; Enterprise would otherwise silently full-scan.
 */
async function* pagesDeContas(db: Firestore): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = integracaoCollection
      .ref(db, {})
      .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
      .orderBy('nome')
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/** Read-only twin of the reconciler's lookup and pure decision, with no active filter. */
export async function preverIntFreteDaConta(
  db: Firestore,
  integracaoId: string,
): Promise<DisposicaoIntFrete> {
  const contaSnap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  const conta = contaSnap.exists ? (contaSnap.data() as Record<string, unknown>) : null;
  let existente = await buscarIntFreteDaConta(db, integracaoId);
  if (existente == null) {
    const id = `${VINCULO_INT_FRETE_CONTA.mercadoLivre.prefixoDocId}-${integracaoId}`;
    const snap = await intFreteCollection.docRef(db, {}, id).get();
    if (snap.exists) existente = { id, data: snap.data() as Record<string, unknown> };
  }
  return disposicaoDoPlano(planejarIntFreteDaConta(integracaoId, conta, existente));
}

/** Preserve the CLI's disposition labels and field detail in the read-only preview. */
function disposicaoDoPlano(plano: PlanoIntFrete): DisposicaoIntFrete {
  switch (plano.acao) {
    case 'criar':
      return {
        action: 'criado',
        ...(plano.id == null ? {} : { intFreteId: plano.id }),
        campos: Object.keys(plano.campos),
      };
    case 'atualizar':
      return { action: 'atualizado', intFreteId: plano.id, campos: Object.keys(plano.patch) };
    case 'desativar':
      return { action: 'desativado', intFreteId: plano.id, campos: ['ativo'] };
    case 'inalterado':
      return { action: 'inalterado', intFreteId: plano.id };
    case 'incompleto':
      return { action: 'incompleto', faltando: plano.faltando };
    case 'nao-encontrado':
      return { action: 'nao-encontrado' };
  }
}

/**
 * Process each encountered ID once, even if a rename moves it across page boundaries.
 * Page snapshots never supply mirrored fields or a clock to either execution mode.
 */
export async function backfillIntFrete(
  db: Firestore,
  opts: OpcoesBackfillIntFrete,
  pages: AsyncIterable<readonly ContaEnumerada[]> = pagesDeContas(db),
): Promise<ResultadoBackfillIntFrete> {
  const vistos = new Set<string>();
  const totals: ResultadoBackfillIntFrete['totals'] = {};
  for await (const docs of pages) {
    for (const doc of docs) {
      if (vistos.has(doc.id)) continue;
      vistos.add(doc.id);
      const disposicao = opts.apply
        ? await reconciliarIntFreteDaConta(db, doc.id)
        : await preverIntFreteDaConta(db, doc.id);
      totals[disposicao.action] = (totals[disposicao.action] ?? 0) + 1;
      opts.onConta?.(doc.id, disposicao);
    }
  }
  return { contas: vistos.size, totals };
}
