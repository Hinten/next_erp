import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { PERM, hasPerm } from '@delfrance/auth';
import { estoqueCollection, historicoEstoqueCollection } from '@delfrance/data/admin/collections';
import {
  buildLocalizacaoOp,
  estoqueComandoSchema,
  planMovimentacao,
  type EstoqueComando,
} from '@delfrance/data/produto';
import { makeEstoqueUid } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

export interface AplicarEstoqueResult {
  estoqueId: string;
}

/**
 * Server-owned estoque write CORE (exported so the emulator suite drives it
 * without minting auth tokens). ONE Firestore transaction does getOrCreate + the
 * movement / localização + the audit record — which is what makes the
 * first-movement create race impossible (the doc is read and created-or-updated
 * atomically) and keeps the clamping policy in a single trusted place. Reuses the
 * exact framework-agnostic use-cases the client used (`planMovimentacao`,
 * `buildLocalizacaoOp`) so server and client never fork.
 */
export async function applyEstoqueComando(
  db: Firestore,
  comando: EstoqueComando,
  now: number,
): Promise<AplicarEstoqueResult> {
  const { produtoId, depositoId } = comando;
  const estoqueId = makeEstoqueUid(produtoId, depositoId);
  const estoqueRef = estoqueCollection.docRef(db, { produtoId }, estoqueId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(estoqueRef);
    const exists = snap.exists;

    if (comando.op === 'localizacao') {
      // getOrCreate + set localização (quantities, owned by movements, untouched).
      const op = buildLocalizacaoOp(produtoId, depositoId, comando.localizacao, exists, now);
      // buildLocalizacaoOp only ever returns set|update (never delete).
      if (op.type === 'update') tx.update(estoqueRef, op.data);
      else if (op.type === 'set') tx.set(estoqueRef, op.data);
      return;
    }

    // op === 'movimento'
    const plan = planMovimentacao(comando.input, now);
    if (!exists) {
      // First movement: create with the resulting quantities (increment-from-zero
      // == the delta; reservada floored at 0 to satisfy the schema).
      tx.set(
        estoqueRef,
        estoqueCollection.parse({
          parentId: produtoId,
          depositoOuterRef: `documents/depositos/${depositoId}`,
          quantidade: plan.quantidade,
          quantidadeReservada: Math.max(0, plan.quantidadeReservada),
          dataCriacao: now,
          ultimaModificacao: now,
        }),
      );
    } else if (plan.ehBalanco) {
      // Balanço — set the absolute counted value (a deliberate override).
      tx.update(estoqueRef, {
        quantidade: plan.quantidade,
        quantidadeReservada: plan.quantidadeReservada,
        ultimaModificacao: now,
      });
    } else {
      // Entrada/saída — apply the delta to the value read in THIS transaction
      // (the read+write is atomic, so concurrent movements can't clobber).
      const cur = snap.data() as { quantidade?: number; quantidadeReservada?: number };
      tx.update(estoqueRef, {
        quantidade: (cur.quantidade ?? 0) + plan.quantidade,
        quantidadeReservada: Math.max(0, (cur.quantidadeReservada ?? 0) + plan.quantidadeReservada),
        ultimaModificacao: now,
      });
    }

    const historicoRef = historicoEstoqueCollection.ref(db, { produtoId, estoqueId }).doc();
    tx.set(historicoRef, historicoEstoqueCollection.parse(plan.historico));
  });

  return { estoqueId };
}

/**
 * `aplicarEstoque` callable — the web client's estoque write path (replaces the
 * direct client `writeBatch` from PR #217). Enforces auth + `PERM.estoque.write`
 * itself (the Admin SDK bypasses Firestore rules), validates the payload, then
 * runs {@link applyEstoqueComando}. Firestore rules stay open for Flutter
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

  const result = await applyEstoqueComando(getDb(), parsed.data, Date.now());
  logger.info(`aplicarEstoque: ${parsed.data.op} ${parsed.data.produtoId} → ${result.estoqueId}`);
  return result;
});
