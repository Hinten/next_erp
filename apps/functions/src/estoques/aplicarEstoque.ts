import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { PERM, hasPerm } from '@delfrance/auth';
import { estoqueCollection, historicoEstoqueCollection } from '@delfrance/data/admin/collections';
import {
  estoqueComandoSchema,
  planMovimentacao,
  type EstoqueComando,
  type MovimentacaoPlan,
} from '@delfrance/data/produto';
import { type EstoqueProduto, makeEstoqueUid } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

export interface AplicarEstoqueResult {
  estoqueId: string;
}

type LocalizacaoComando = Extract<EstoqueComando, { op: 'localizacao' }>;
type MovimentoComando = Extract<EstoqueComando, { op: 'movimento' }>;

/**
 * Set a depósito's `localização` for a produto (getOrCreate). On an EXISTING estoque
 * it updates ONLY `localizacao` — quantities are movement-owned and never touched, and
 * a localização change on an existing doc doesn't bump `ultimaModificacao`. On first
 * touch it creates a valid estoque (`quantidade: 0`, `ultimaModificacao: now` like every
 * other create path — this is document initialization, not a localização edit) carrying
 * the localização. One transaction, so the getOrCreate is race-safe. Exported so the
 * emulator suite drives it without minting auth tokens.
 */
export async function aplicarLocalizacao(
  db: Firestore,
  comando: LocalizacaoComando,
  now: number,
): Promise<AplicarEstoqueResult> {
  const { produtoId, depositoId } = comando;
  const estoqueId = makeEstoqueUid(produtoId, depositoId);
  const estoqueRef = estoqueCollection.docRef(db, { produtoId }, estoqueId);
  // Empty/whitespace clears the field (Flutter `editarLocalizacao` parity).
  const loc = comando.localizacao?.trim() ? comando.localizacao : null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(estoqueRef);
    if (snap.exists) {
      tx.update(estoqueRef, { localizacao: loc });
    } else {
      tx.set(
        estoqueRef,
        estoqueCollection.parse({
          parentId: produtoId,
          depositoOuterRef: `documents/depositos/${depositoId}`,
          localizacao: loc,
          quantidade: 0,
          quantidadeReservada: 0,
          dataCriacao: now,
          ultimaModificacao: now,
        }),
      );
    }
  });

  return { estoqueId };
}

type EstoqueMovimentoWrite =
  | { set: EstoqueProduto }
  | { update: { quantidade: number; quantidadeReservada: number; ultimaModificacao: number } };

/**
 * Resolve the estoque mutation for a movement (pure — no I/O). First movement
 * (`current == null`) → the full doc to `set` (increment-from-zero == the delta;
 * reservada floored at 0 for the schema). Balanço → the absolute counted values.
 * Entrada/saída → the signed delta applied to the value read this transaction. Kept
 * separate so {@link aplicarMovimento}'s transaction body reads linearly.
 */
function movimentoEstoqueWrite(
  produtoId: string,
  depositoId: string,
  current: { quantidade?: number; quantidadeReservada?: number } | null,
  plan: MovimentacaoPlan,
  now: number,
): EstoqueMovimentoWrite {
  if (current === null) {
    return {
      set: estoqueCollection.parse({
        parentId: produtoId,
        depositoOuterRef: `documents/depositos/${depositoId}`,
        quantidade: plan.quantidade,
        quantidadeReservada: Math.max(0, plan.quantidadeReservada),
        dataCriacao: now,
        ultimaModificacao: now,
      }),
    };
  }
  if (plan.ehBalanco) {
    return {
      update: {
        quantidade: plan.quantidade,
        quantidadeReservada: plan.quantidadeReservada,
        ultimaModificacao: now,
      },
    };
  }
  return {
    update: {
      quantidade: (current.quantidade ?? 0) + plan.quantidade,
      quantidadeReservada: Math.max(
        0,
        (current.quantidadeReservada ?? 0) + plan.quantidadeReservada,
      ),
      ultimaModificacao: now,
    },
  };
}

/**
 * Apply a stock movement (entrada/saída delta or balanço absolute set) + append the
 * `historicoEstoque` audit record. ONE transaction does getOrCreate + the mutation +
 * the audit — which makes the first-movement create race impossible (the read and
 * write are atomic) and keeps the clamping policy in a single trusted place. Reuses
 * `planMovimentacao` (the exact use-case the client used) so server and client never
 * fork. Exported for the emulator suite.
 */
export async function aplicarMovimento(
  db: Firestore,
  comando: MovimentoComando,
  now: number,
): Promise<AplicarEstoqueResult> {
  const { produtoId, depositoId } = comando;
  const estoqueId = makeEstoqueUid(produtoId, depositoId);
  const estoqueRef = estoqueCollection.docRef(db, { produtoId }, estoqueId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(estoqueRef);
    const plan = planMovimentacao(comando.input, now);
    const current = snap.exists
      ? (snap.data() as { quantidade?: number; quantidadeReservada?: number })
      : null;

    const write = movimentoEstoqueWrite(produtoId, depositoId, current, plan, now);
    if ('set' in write) tx.set(estoqueRef, write.set);
    else tx.update(estoqueRef, write.update);

    const historicoRef = historicoEstoqueCollection.ref(db, { produtoId, estoqueId }).doc();
    tx.set(historicoRef, historicoEstoqueCollection.parse(plan.historico));
  });

  return { estoqueId };
}

/**
 * `aplicarEstoque` callable — the web client's estoque write path (replaces the
 * direct client `writeBatch` from PR #217). Enforces auth + `PERM.estoque.write`
 * itself (the Admin SDK bypasses Firestore rules), validates the payload, then
 * dispatches to the per-op transaction. Firestore rules stay open for Flutter
 * coexistence (ADR 0010); this is the trusted write path for the OSS app.
 */
export const aplicarEstoque = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Usuário não autenticado.');
  }
  const token = request.auth.token as { permissions?: string; su?: boolean };
  // `su` (break-glass super user) short-circuits permission like the rules do.
  if (token.su !== true && !hasPerm(token.permissions, PERM.estoque.write)) {
    throw new HttpsError('permission-denied', 'Sem permissão para movimentar estoque.');
  }

  const parsed = estoqueComandoSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Comando de estoque inválido.');
  }
  const comando = parsed.data;

  const result =
    comando.op === 'localizacao'
      ? await aplicarLocalizacao(getDb(), comando, Date.now())
      : await aplicarMovimento(getDb(), comando, Date.now());
  logger.info(`aplicarEstoque: ${comando.op} ${comando.produtoId} → ${result.estoqueId}`);
  return result;
});
