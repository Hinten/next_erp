import { FieldValue, type Firestore } from 'firebase-admin/firestore';
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
import { makeEstoqueUid } from '@delfrance/schemas';

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

/**
 * Merge-set payload for a movement (pure — no I/O). Every path carries the doc
 * constants — the merge-set on first touch IS the getOrCreate — plus two invariant
 * transforms: `ultimaModificacao: maximum(now)` (monotonic — a stale `now` can't
 * move it backwards, #387) and `dataCriacao: minimum(now)` (set-if-missing; an
 * existing, older creation time always wins). Entrada/saída apply the signed
 * deltas as `increment` transforms; balanço writes the absolute counted values
 * with the reservada clamped ≥ 0 in code. `floorReservada` tells the caller to
 * append the follow-up `maximum(0)` write that floors the incremented reservada.
 */
function movimentoEstoqueWrite(
  produtoId: string,
  depositoId: string,
  plan: MovimentacaoPlan,
  now: number,
): { base: Record<string, unknown>; floorReservada: boolean } {
  const shared = {
    parentId: produtoId,
    depositoOuterRef: `documents/depositos/${depositoId}`,
    ultimaModificacao: FieldValue.maximum(now),
    dataCriacao: FieldValue.minimum(now),
  };
  if (plan.ehBalanco) {
    return {
      base: {
        ...shared,
        quantidade: plan.quantidade,
        quantidadeReservada: Math.max(0, plan.quantidadeReservada),
      },
      floorReservada: false,
    };
  }
  return {
    base: {
      ...shared,
      quantidade: FieldValue.increment(plan.quantidade),
      quantidadeReservada: FieldValue.increment(plan.quantidadeReservada),
    },
    floorReservada: true,
  };
}

/**
 * Apply a stock movement (entrada/saída delta or balanço absolute set) + append the
 * `historicoEstoque` audit record. ONE atomic WriteBatch, ZERO reads (#387 — the old
 * Flutter backend's transform design): the merge-set is the getOrCreate, the deltas
 * are server-side `increment`s, `quantidadeReservada` is floored at 0 by a follow-up
 * `maximum(0)` write on the same doc (a batch's writes apply in order — the legacy
 * update+transform pairing), and `ultimaModificacao` is monotonic via `maximum(now)`.
 * Because the server owns the arithmetic, a stored non-number self-heals to the
 * operand instead of corrupting the doc, and concurrent movements never conflict.
 * `FieldValue.maximum`/`minimum` need firebase-admin 14 (`@google-cloud/firestore`
 * ≥ 8.6.0) — one more reason this package stays on admin 14. Reuses
 * `planMovimentacao` (the exact use-case the client used) so server and client never
 * fork. Exported for the emulator suite.
 */
export async function aplicarMovimento(
  db: Firestore,
  comando: MovimentoComando,
  now: number,
  audit: { usuarioOuterRef?: string | null } = {},
): Promise<AplicarEstoqueResult> {
  const { produtoId, depositoId } = comando;
  const estoqueId = makeEstoqueUid(produtoId, depositoId);
  const estoqueRef = estoqueCollection.docRef(db, { produtoId }, estoqueId);

  const plan = planMovimentacao(comando.input, now);
  const write = movimentoEstoqueWrite(produtoId, depositoId, plan, now);

  const batch = db.batch();
  batch.set(estoqueRef, write.base, { merge: true });
  if (write.floorReservada) {
    batch.set(estoqueRef, { quantidadeReservada: FieldValue.maximum(0) }, { merge: true });
  }
  const historicoRef = historicoEstoqueCollection.ref(db, { produtoId, estoqueId }).doc();
  // Structured audit: manual movements name their tipo + author. Before/after
  // stay null here — this path is deliberately read-free (the pedido sync's
  // transactional records carry them).
  batch.set(
    historicoRef,
    historicoEstoqueCollection.parse({
      ...plan.historico,
      tipo: plan.ehBalanco ? 'balanco' : 'manual',
      usuarioOuterRef: audit.usuarioOuterRef ?? null,
    }),
  );
  await batch.commit();

  return { estoqueId };
}

/**
 * `aplicarEstoque` callable — the web client's estoque write path (replaces the
 * direct client `writeBatch` from PR #217). Enforces auth + `PERM.estoque.write`
 * itself (the Admin SDK bypasses Firestore rules), validates the payload, then
 * dispatches to the per-op write path. Firestore rules stay open for Flutter
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
      : await aplicarMovimento(getDb(), comando, Date.now(), {
          usuarioOuterRef: `documents/usuarios/${request.auth.uid}`,
        });
  logger.info(`aplicarEstoque: ${comando.op} ${comando.produtoId} → ${result.estoqueId}`);
  return result;
});
