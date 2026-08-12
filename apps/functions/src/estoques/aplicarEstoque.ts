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
 * deltas as `increment` transforms; balanço writes the plan's absolute counted
 * values verbatim — `planMovimentacao` already clamped the balanço's reservada
 * ≥ 0, and re-clamping here would be a second, silently divergent floor.
 * `floorReservada` tells the caller to append the follow-up `maximum(0)` write
 * that floors the incremented reservada.
 *
 * Exported for `aplicarBalanco`, which applies the same balanço write per
 * produto: one writer, so the two paths cannot drift on the clamp policy or on
 * the `ultimaModificacao` bump the ML stock sweep keys on.
 */
export function movimentoEstoqueWrite(
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
        quantidadeReservada: plan.quantidadeReservada,
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

/** Coerce a stored counter defensively (legacy docs may hold junk). */
function contadorOuZero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/** The `historicoEstoque` v2 row for a manual movement, minus the plan's own fields. */
function historicoManual(
  produtoId: string,
  depositoId: string,
  plan: MovimentacaoPlan,
  audit: { usuarioOuterRef?: string | null },
): Record<string, unknown> {
  return {
    ...plan.historico,
    parentId: produtoId,
    depositoOuterRef: `documents/depositos/${depositoId}`,
    tipo: plan.ehBalanco ? 'balanco' : 'manual',
    usuarioOuterRef: audit.usuarioOuterRef ?? null,
  };
}

/**
 * Apply a stock movement (entrada/saída delta or balanço absolute set) + append the
 * `historicoEstoque` audit record. Reuses `planMovimentacao` (the exact use-case the
 * client used) so server and client never fork. Exported for the emulator suite.
 *
 * **Entrada/saída — ONE atomic WriteBatch, ZERO reads** (#387 — the old Flutter
 * backend's transform design): the merge-set is the getOrCreate, the deltas are
 * server-side `increment`s, `quantidadeReservada` is floored at 0 by a follow-up
 * `maximum(0)` write on the same doc (a batch's writes apply in order — the legacy
 * update+transform pairing), and `ultimaModificacao` is monotonic via `maximum(now)`.
 * Because the server owns the arithmetic, a stored non-number self-heals to the
 * operand instead of corrupting the doc, and concurrent movements never conflict.
 * `FieldValue.maximum`/`minimum` need firebase-admin 14 (`@google-cloud/firestore`
 * ≥ 8.6.0) — one more reason this package stays on admin 14. Their `saldo` is null:
 * a read-free write cannot know where it landed, and that is the accepted price of
 * ADR 0011 tier 0 on the hot path.
 *
 * **Balanço — ONE transaction.** It is the exception, and deliberately so: a balanço
 * is an absolute set, so its *signed delta* exists only relative to the value it
 * replaces, and the ledger has to stay summable (ADR 0014). Recording the counted
 * value in the delta field — what v1 did — silently poisons every
 * `sum(movimento)` the sweep runs. Balanços are rare (an inventory count, not a
 * sale), so paying one read for them costs nothing measurable. `planMovimentacao`
 * is called INSIDE the callback on the `tx.get` result, so an OCC retry re-derives
 * the delta against the winning value instead of replaying a stale one (rule 7).
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

  if (comando.input.tipo === 'balanco') {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(estoqueRef);
      const dados = snap.exists ? snap.data() : null;
      const plan = planMovimentacao(comando.input, now, {
        quantidade: contadorOuZero(dados?.quantidade),
        quantidadeReservada: contadorOuZero(dados?.quantidadeReservada),
      });
      const write = movimentoEstoqueWrite(produtoId, depositoId, plan, now);
      tx.set(estoqueRef, write.base, { merge: true });
      tx.set(
        historicoEstoqueCollection.ref(db, { produtoId, estoqueId }).doc(),
        historicoEstoqueCollection.parse(historicoManual(produtoId, depositoId, plan, audit)),
      );
    });
    return { estoqueId };
  }

  const plan = planMovimentacao(comando.input, now);
  const write = movimentoEstoqueWrite(produtoId, depositoId, plan, now);

  const batch = db.batch();
  batch.set(estoqueRef, write.base, { merge: true });
  if (write.floorReservada) {
    batch.set(estoqueRef, { quantidadeReservada: FieldValue.maximum(0) }, { merge: true });
  }
  batch.set(
    historicoEstoqueCollection.ref(db, { produtoId, estoqueId }).doc(),
    historicoEstoqueCollection.parse(historicoManual(produtoId, depositoId, plan, audit)),
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
