/**
 * Fixtures of the daily stock reconcile's suites (master plan step 12, PR 12-g), **for tests
 * only** (`estrutura.test.ts`: nothing outside a test imports `testing/`): contas with a depósito,
 * produtos, their links and stock records in a {@link FakeDb}, a recording reads-queue producer
 * and a recording logger. Every id here is synthetic.
 */
import { INTEGRACAO_TIPO, makeEstoqueUid } from '@delfrance/schemas';

import type { AgendadorReconcileEstoqueLi } from '../estoque/reconcile/agendadorReconcile';
import type { DocData, FakeDb } from './fakeDb';

/** The fixtures' clock: 2027-01-15T15:00:00Z. */
export const AGORA_RECONCILE_MS = Date.UTC(2027, 0, 15, 15, 0, 0);

/** A run id of the fixtures. */
export const RUN_A = 'estoque-reconcile-20270115';
export const RUN_B = 'estoque-reconcile-20270116';

/** The canonical stored form of a depósito ref. */
export function refDeposito(depositoId: string): string {
  return `documents/depositos/${depositoId}`;
}

/** A Loja Integrada conta with a depósito (either stored form; the canonical by default). */
export function seedContaComDeposito(
  db: FakeDb,
  contaId: string,
  depositoOuterRef: string | null,
  over: Partial<DocData> = {},
): void {
  db.seed(`integracao/${contaId}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: `Loja ${contaId}`,
    ativo: true,
    depositoOuterRef,
    ...over,
  });
}

/** A child link of a conta to store id `id` under produto `produtoId`. */
export function seedLinkFilho(
  db: FakeDb,
  produtoId: string,
  linkId: string,
  contaId: string,
  id: number | string,
  over: Partial<DocData> = {},
): void {
  db.seed(`produtos/${produtoId}/produtolojaintegrada/${linkId}`, {
    contaLojaIntegrada: `documents/integracao/${contaId}`,
    id,
    paiProdutoIntegradaId: 900,
    removido: false,
    ...over,
  });
}

/** A produto document (a plain child by default). */
export function seedProduto(db: FakeDb, produtoId: string, over: Partial<DocData> = {}): void {
  db.seed(`produtos/${produtoId}`, { nome: `Produto ${produtoId}`, ...over });
}

/** A stock record of `produtoId` at `depositoId` (canonical id by default), with `parentId`. */
export function seedRegistro(
  db: FakeDb,
  produtoId: string,
  depositoId: string,
  quantidade: number,
  over: Partial<DocData> & { readonly id?: string } = {},
): string {
  const { id, ...resto } = over;
  const estoqueId = id ?? makeEstoqueUid(produtoId, depositoId);
  db.seed(`produtos/${produtoId}/estoques/${estoqueId}`, {
    parentId: produtoId,
    depositoOuterRef: refDeposito(depositoId),
    quantidade,
    ...resto,
  });
  return estoqueId;
}

/** A kit's `componentesKit`, every component constraining it. */
export function componentesDoKit(componentes: Record<string, number>): DocData {
  return Object.fromEntries(
    Object.entries(componentes).map(([id, quantidade]) => [
      id,
      { quantidade, limitarEstoque: true, timestamp: null },
    ]),
  );
}

/** One enqueue a {@link agendadorGravador} recorded. */
export interface EnfileiradoReconcileLi {
  readonly execucaoId: string;
  readonly seq: number;
  readonly atrasoS: number;
}

/** A reads-queue producer that records, or rejects with `falha` when given. */
export function agendadorGravador(falha?: () => unknown): {
  readonly agendador: AgendadorReconcileEstoqueLi;
  readonly enfileirados: EnfileiradoReconcileLi[];
} {
  const enfileirados: EnfileiradoReconcileLi[] = [];
  return {
    enfileirados,
    agendador: {
      async enfileirar(tarefa, { atrasoS }) {
        if (falha !== undefined) throw falha();
        enfileirados.push({ execucaoId: tarefa.execucaoId, seq: tarefa.seq, atrasoS });
      },
    },
  };
}

/** One line a {@link loggerGravador} recorded. */
export interface LinhaReconcileLi {
  readonly nivel: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly meta: Record<string, unknown>;
}

/** A logger that records every line. */
export function loggerGravador(): {
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  readonly linhas: LinhaReconcileLi[];
} {
  const linhas: LinhaReconcileLi[] = [];
  const gravar =
    (nivel: LinhaReconcileLi['nivel']) =>
    (msg: string, meta: Record<string, unknown> = {}): void => {
      linhas.push({ nivel, msg, meta });
    };
  return { linhas, logger: { info: gravar('info'), warn: gravar('warn'), error: gravar('error') } };
}
