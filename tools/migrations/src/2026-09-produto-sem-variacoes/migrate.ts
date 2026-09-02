import {
  FieldPath,
  FieldValue,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

import { toOuterRef } from '@delfrance/schemas';

import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import { resumirEstoques, type EstoqueBruto, type ResumoEstoque } from './predicate';
import { planejarConversao, type MotivoPular, type PlanoDeConversao } from './transform';

/**
 * One-time conversion: every legacy **Produto Simples** becomes a **family of
 * one** (#1398). Idempotent, re-runnable, dry-run by default.
 * Runbook: `tools/migrations/produto-sem-variacoes.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id>
 *   pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id> --apply
 *
 * The decision is `transform.ts` — pure, unit-tested, and where every "why" is
 * written down. This file is Firestore I/O and nothing else.
 *
 * ## ⚠️ ONE ATOMIC BATCH PER PRODUTO, and it must stay that way
 *
 * A produto's writes move stock: the parent's row is decremented and the child's
 * is incremented by the same number. Split them across two commits and a crash in
 * between either destroys units or duplicates them, permanently and silently. So
 * `writer.flush()` runs after EVERY produto rather than every 400 ops — one commit
 * RPC per converted produto is the price of the unit being all-or-nothing, and for
 * a one-shot run over a bounded corpus that is not a price worth negotiating.
 *
 * ⚠️ `BatchWriter` still auto-flushes at its own cap. A produto holding more than
 * ~200 depósitos would therefore straddle a commit; no such produto exists in this
 * corpus (the census reports `nDepositos`), and if one ever did the fix is a bigger
 * per-produto batch, never a smaller unit of atomicity.
 *
 * ## ⚠️ This is a FULL `produtos` walk, twice
 *
 * Pass 1 reads every produto to learn which ids are named as a `paiId` — Firestore
 * cannot answer "has no children" as a filter, and `where('paiId','==',null)` on
 * Enterprise silently full-scans anyway (rule 1) while missing every document that
 * has no `paiId` KEY at all. Pass 2 then reads the estoques and the ML links of the
 * candidates only. Enterprise bills data scanned, which is exactly why this is a
 * one-shot manual run inside the cutover window and never anything scheduled.
 *
 * ## ⛔ Agents never run this. See root `CLAUDE.md` rule 8 / ADR 0013.
 */

const PAGE_SIZE = 300;

/** Page any collection by document id — stable cursor, bounded memory, no index. */
async function* pagesByDocId(base: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = base.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/* -------------------------------------------------------------------------- */
/*                        Pass 1 — who has children                           */
/* -------------------------------------------------------------------------- */

interface Raizes {
  /** Root produtos (no `paiId`), in key order: `[id, doc]`. */
  raizes: Array<[string, Record<string, unknown>]>;
  /** Every id some other produto names as its `paiId`. */
  paisComFilhos: Set<string>;
}

async function lerRaizes(ctx: MigrationContext): Promise<Raizes> {
  const out: Raizes = { raizes: [], paisComFilhos: new Set() };
  for await (const docs of pagesByDocId(ctx.db.collection('produtos'))) {
    for (const doc of docs) {
      const data = doc.data() as Record<string, unknown>;
      const paiId = data.paiId;
      if (typeof paiId === 'string' && paiId !== '') {
        out.paisComFilhos.add(paiId);
        continue;
      }
      out.raizes.push([doc.id, data]);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                     Pass 2 — the per-candidate reads                       */
/* -------------------------------------------------------------------------- */

async function lerEstoques(ctx: MigrationContext, produtoId: string): Promise<ResumoEstoque> {
  const snap = await ctx.db.collection(`produtos/${produtoId}/estoques`).get();
  const brutos: EstoqueBruto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      docId: d.id,
      depositoOuterRef: data.depositoOuterRef,
      quantidade: data.quantidade,
      quantidadeReservada: data.quantidadeReservada,
    };
  });
  return resumirEstoques(produtoId, brutos);
}

/**
 * Does this produto have a child RIGHT NOW?
 *
 * ⚠️ Pass 1's `paisComFilhos` is a snapshot taken before pass 2 started, and pass 2
 * is minutes long. A variation created in that window makes the snapshot say "no
 * children" for a produto that has one — so the script would mint a SECOND member
 * and stamp `filhoUnicoId` on a family of two, which is the stale-pointer harm the
 * whole design is built to avoid (every stock reader would then resolve the parent
 * to one arbitrary child).
 *
 * It self-heals on the produto's next save — `VariationManager` re-derives the
 * pointer from the live child set — but "self-heals eventually" is not a property
 * to rely on for a run whose whole point is to leave the corpus correct.
 *
 * So pass 1 stays the CHEAP pre-filter (it skips the already-families for free, and
 * on this corpus that is most of them) and this is the fresh re-check for the few
 * that survive it. `limit(1)` because the answer is boolean. Rides the existing
 * `produtos(paiId ASC, nome ASC)` index on its prefix.
 *
 * ⚠️ It does NOT close the window entirely — a child created between this read and
 * the commit still slips through. Firestore has no batch precondition on a QUERY,
 * so closing it fully would mean a transaction per produto, and the run this script
 * exists for happens on a quiet database (the legacy app is off, traffic has not cut
 * over). This shrinks the window from minutes to milliseconds, which is the whole
 * difference between "a staging rehearsal will hit it" and "it will not".
 */
async function temFilhoAgora(ctx: MigrationContext, produtoId: string): Promise<boolean> {
  const snap = await ctx.db.collection('produtos').where('paiId', '==', produtoId).limit(1).get();
  return !snap.empty;
}

/**
 * Does this produto sell on Mercado Livre?
 *
 * ⛔ `limit(1)` because the ANSWER is boolean and the consequence is a skip —
 * `transform.ts`'s header carries the reason a produto with a link must not be
 * converted here. Reading the whole subcollection to answer a yes/no would bill
 * every link of every candidate for nothing.
 */
async function temVinculoMercadoLivre(ctx: MigrationContext, produtoId: string): Promise<boolean> {
  const snap = await ctx.db.collection(`produtos/${produtoId}/produtoMercadoLivre`).limit(1).get();
  return !snap.empty;
}

/* -------------------------------------------------------------------------- */
/*                                 The writes                                 */
/* -------------------------------------------------------------------------- */

/**
 * Apply one conversion. Every write lands in the caller's batch; the caller
 * flushes immediately after, which is what makes the produto atomic.
 *
 * ⚠️ The child's estoque row is a MERGE-SET carrying `FieldValue.increment`, not a
 * plain set. A re-run after an *entrada* was booked on the parent has real units
 * to move onto a row that already exists, and a plain set would overwrite what is
 * there — destroying everything the first run moved. `dataCriacao` takes
 * `minimum` for the mirror-image reason: a second pass must not push the row's
 * birthday forward.
 *
 * ⚠️ The parent's row is DECREMENTED, never deleted (`FieldValue.increment(-n)`).
 * A delete cascades through `onEstoqueDeleted`, taking the row's whole
 * `historicoEstoque` ledger with it — and a migration run INSIDE the cutover
 * window does fire triggers; only the import fires none (ADR 0013).
 */
async function aplicarConversao(
  ctx: MigrationContext,
  produtoId: string,
  plano: Extract<PlanoDeConversao, { tipo: 'converter' }>,
  agora: number,
): Promise<void> {
  const { writer, db } = ctx;

  await writer.set(db.doc(`produtos/${plano.childId}`), {
    ...plano.childDoc,
    timestamp: agora,
    // ⚠️ Load-bearing: `produtoMeta.defaultQuery` sorts on `ultimaModificacao`, and
    // a document missing the sort key is invisible to `orderBy` (#159/#861). A
    // sole member nobody can list is a produto whose stock nobody can find.
    ultimaModificacao: agora,
  });

  await writer.update(db.doc(`produtos/${produtoId}`), {
    ...plano.parentPatch,
    ultimaModificacao: FieldValue.maximum(agora),
  });

  for (const mov of plano.movimentos) {
    await writer.set(
      db.doc(`produtos/${plano.childId}/estoques/${mov.docIdNoFilho}`),
      {
        parentId: plano.childId,
        depositoOuterRef: toOuterRef(`depositos/${mov.depositoId}`),
        quantidade: FieldValue.increment(mov.quantidade),
        dataCriacao: FieldValue.minimum(agora),
        ultimaModificacao: FieldValue.maximum(agora),
      },
      { merge: true },
    );
    await writer.update(db.doc(`produtos/${produtoId}/estoques/${mov.docIdNoPai}`), {
      quantidade: FieldValue.increment(-mov.quantidade),
      ultimaModificacao: FieldValue.maximum(agora),
    });
  }

  // ⛔ Per PRODUTO, not per 400 ops. See the module header.
  await writer.flush();
}

/* -------------------------------------------------------------------------- */
/*                                    Run                                     */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  // ONE clock for the whole run, so every document this pass writes carries the
  // same stamp and the batch is orderable against neighbouring runs. Also what
  // makes a re-run's `FieldValue.maximum` a no-op rather than a churn write.
  const agora = Date.now();
  log(`[produto-sem-variacoes] full walk of produtos; stamp ${agora}`);

  const { raizes, paisComFilhos } = await lerRaizes(ctx);
  log(`[produto-sem-variacoes] ${raizes.length} raiz(es); ${paisComFilhos.size} já são família`);

  const pulados = new Map<MotivoPular, number>();
  let convertidos = 0;
  let unidadesMovidas = 0;
  let unidadesQueFicamNoPai = 0;
  let linhasSemDeposito = 0;

  for (const [produtoId, produto] of raizes) {
    const temFilhos = paisComFilhos.has(produtoId);

    // ⚠️ The per-candidate reads are behind the CHEAP skip. A produto pass 1 already
    // saw as a family needs none of them, and on a corpus that is mostly families
    // that is the difference between three reads per produto and zero. What pass 1
    // CANNOT do is prove the negative — see `temFilhoAgora`, which re-reads it.
    if (temFilhos) {
      pulados.set('ja-tem-filho', (pulados.get('ja-tem-filho') ?? 0) + 1);
      ctx.sink.skip(`produtos/${produtoId}`, 'filhoUnicoId', null, 'ja-tem-filho');
      continue;
    }

    const noMercadoLivre = await temVinculoMercadoLivre(ctx, produtoId);
    const estoque = await lerEstoques(ctx, produtoId);
    const plano = planejarConversao({
      produtoId,
      produto,
      // ⚠️ Re-read, not the pass-1 snapshot. See `temFilhoAgora`.
      temFilhos: await temFilhoAgora(ctx, produtoId),
      temVinculoMercadoLivre: noMercadoLivre,
      estoque,
    });

    if (plano.tipo === 'pular') {
      pulados.set(plano.motivo, (pulados.get(plano.motivo) ?? 0) + 1);
      ctx.sink.skip(`produtos/${produtoId}`, 'filhoUnicoId', null, plano.motivo);
      continue;
    }

    convertidos += 1;
    unidadesMovidas += plano.movimentos.reduce((acc, m) => acc + m.quantidade, 0);
    unidadesQueFicamNoPai += plano.ficaNoPai;
    linhasSemDeposito += estoque.nDepositosIrreconheciveis;

    ctx.sink.change(`produtos/${produtoId}`, 'filhoUnicoId', null, plano.childId);
    for (const mov of plano.movimentos) {
      ctx.sink.change(
        `produtos/${produtoId}/estoques/${mov.docIdNoPai}`,
        'quantidade',
        `-${mov.quantidade}`,
        `produtos/${plano.childId}/estoques/${mov.docIdNoFilho}`,
      );
    }

    await aplicarConversao(ctx, produtoId, plano, agora);
  }

  // ⚠️ Nothing here is a rounding note. Every number is either work done or work
  // LEFT — a silent cap reads as "covered everything" when it did not.
  log(`[produto-sem-variacoes] convertidos: ${convertidos}`);
  log(`[produto-sem-variacoes] unidades movidas para o filho: ${unidadesMovidas}`);
  log(
    `[produto-sem-variacoes] unidades RESERVADAS que ficam no pai: ${unidadesQueFicamNoPai} ` +
      `— saem à mão depois que os pedidos abertos enviarem`,
  );
  if (linhasSemDeposito > 0) {
    log(
      `[produto-sem-variacoes] ⚠️ ${linhasSemDeposito} linha(s) de estoque com depositoOuterRef ` +
        `irreconhecível ficaram no pai — sem depósito não há linha canônica de destino`,
    );
  }
  for (const [motivo, n] of [...pulados].sort()) {
    log(`[produto-sem-variacoes] pulados (${motivo}): ${n}`);
  }

  return { docsScanned: raizes.length, docsChanged: convertidos };
}

if (isMainModule(import.meta.url)) {
  await runMigration('produto-sem-variacoes', run);
}

export { run };
