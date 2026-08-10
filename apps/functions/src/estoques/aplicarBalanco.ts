import {
  FieldPath,
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QuerySnapshot,
} from 'firebase-admin/firestore';
import * as pipelines from '@google-cloud/firestore/pipelines';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  balancoCollection,
  estoqueCollection,
  historicoEstoqueCollection,
  movimentoBalancoCollection,
  produtoCollection,
  relatorioBalancoCollection,
} from '@delfrance/data/admin/collections';
import {
  MovimentoBalancoIndefinidoError,
  balancoTaskSchema,
  finalizarBalancoSchema,
  montarListaTrabalho,
  montarShardsRelatorio,
  motivoBalanco,
  planejarItemBalanco,
  type BalancoTaskPayload,
  type FinalizarBalancoComando,
  type FinalizarBalancoResult,
  type ItemTrabalhoBalanco,
} from '@delfrance/data/balanco';
import {
  ESTADO_BALANCO,
  RELATORIO_BALANCO_SHARD_SIZE,
  idFromRef,
  makeEstoqueUid,
  podeFinalizarBalanco,
  relatorioBalancoShardId,
  type ItemRelatorioBalanco,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { movimentoEstoqueWrite } from './aplicarEstoque';
import {
  BALANCO_MAX_ATTEMPTS,
  BALANCO_QUEUE,
  createBalancoScheduler,
  type BalancoScheduler,
} from './balancoTasks';

/**
 * Produtos per apply transaction. Each one costs 2 reads (estoque + the
 * idempotency marker) and up to 2 writes, plus a single shard patch — so 100
 * sits comfortably under Firestore's 500-write transaction limit with room for
 * the patch.
 */
const PRODUTOS_POR_TRANSACAO = 100;

/** Estoque docs per page of the depósito-wide scan. */
const PAGINA_ESTOQUES = 500;

/** Produtos per field-masked detail `getAll`. */
const PRODUTOS_POR_LEITURA = 300;

/**
 * Wall-clock budget for one dispatch. `timeoutSeconds` is 540; stopping at 400
 * leaves room for the in-flight shard plus the re-enqueue.
 */
const ORCAMENTO_MS = 400_000;

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

/** produtoId → units counted (non-error, non-removed movimentos). */
export type AgregarContagem = (db: Firestore, balancoId: string) => Promise<Map<string, number>>;

/**
 * What the depósito scan learns about one produto. Deliberately NOT the stored
 * counters: phase B re-reads those inside the applying transaction, and a value
 * read here would be minutes stale by then.
 */
export interface EstoqueDoDeposito {
  /** Docs whose id is NOT `est-<produtoId>-<depositoId>` (legacy anomalies). */
  extras: number;
}
export type VarrerDeposito = (
  db: Firestore,
  depositoId: string,
) => Promise<Map<string, EstoqueDoDeposito>>;

export interface BalancoDeps {
  db: Firestore;
  scheduler: BalancoScheduler;
  agregar: AgregarContagem;
  varrer: VarrerDeposito;
  agora: () => number;
}

/* -------------------------------------------------------------------------- */
/* Aggregate — the counted totals                                              */
/* -------------------------------------------------------------------------- */

/** Fold aggregate rows into produtoId → total. Pure, so it is unit-testable. */
export function reduzirContagem(linhas: Array<Record<string, unknown>>): Map<string, number> {
  const contagem = new Map<string, number>();
  for (const linha of linhas) {
    const produtoId = linha.produtoId;
    if (typeof produtoId !== 'string' || produtoId === '') continue;
    const total = linha.total;
    if (typeof total !== 'number' || !Number.isFinite(total)) continue;
    // Accumulate rather than set: a produto can only produce one group here,
    // but accumulating costs nothing and cannot silently drop a second one.
    contagem.set(produtoId, (contagem.get(produtoId) ?? 0) + total);
  }
  return contagem;
}

/**
 * ONE pipeline aggregate over the balanço's movimentos, grouped by the
 * denormalized `produtoId`. Legacy walked distinct produtos with a cursor and
 * ran a `sum()` per produto — 2 reads per distinct produto; this is one query.
 *
 * ⚠️ NOT emulator-runnable — see {@link agregarContagemPadrao} for the gate.
 * {@link reduzirContagem}, the piece both paths share, is unit-tested on its own.
 */
export const agregarContagemPipeline: AgregarContagem = async (db, balancoId) => {
  const snap = await db
    .pipeline()
    .collection(movimentoBalancoCollection.resolvePath({ balancoId }))
    .where(
      pipelines.and(
        pipelines.equal(pipelines.field('error'), false),
        pipelines.equal(pipelines.field('removido'), false),
      ),
    )
    .aggregate({
      accumulators: [pipelines.sum('quantidade').as('total')],
      groups: ['produtoId'],
    })
    .execute();
  return reduzirContagem(snap.results.map((r) => r.data() as Record<string, unknown>));
};

/**
 * Classic-query fallback: page the movimentos and reduce in memory. Used by the
 * emulator lane (where pipelines do not run) and correct anywhere — a balanço's
 * movimentos are a single, parent-scoped subcollection, so the read volume is
 * bounded by one count rather than by the catalogue.
 */
export const agregarContagemClassico: AgregarContagem = async (db, balancoId) => {
  const linhas: Array<Record<string, unknown>> = [];
  const base = movimentoBalancoCollection
    .ref(db, { balancoId })
    .where('error', '==', false)
    .where('removido', '==', false)
    .orderBy(FieldPath.documentId())
    .limit(PAGINA_ESTOQUES);
  let cursor: DocumentSnapshot | null = null;
  for (;;) {
    const pagina: QuerySnapshot = await (cursor ? base.startAfter(cursor) : base).get();
    if (pagina.empty) break;
    for (const doc of pagina.docs) {
      const dados = doc.data();
      linhas.push({ produtoId: dados.produtoId, total: dados.quantidade });
    }
    if (pagina.size < PAGINA_ESTOQUES) break;
    cursor = pagina.docs[pagina.size - 1] ?? null;
    if (!cursor) break;
  }
  return reduzirContagem(linhas);
};

/**
 * The aggregate the deployed worker uses.
 *
 * ⚠️ Gated on `FIRESTORE_EMULATOR_HOST`, a fact about the backend, rather than
 * on a caught error: the Firestore emulator is Standard edition and rejects the
 * Pipelines API, but the SDK still exposes `db.pipeline()`, so probing the
 * client for support answers yes and the call then fails at execution. Making
 * this a capability gate instead of an injected test double is deliberate — it
 * means the e2e lane exercises the function as DEPLOYED, with only the query
 * shape degraded.
 */
export const agregarContagemPadrao: AgregarContagem = (db, balancoId) =>
  process.env.FIRESTORE_EMULATOR_HOST
    ? agregarContagemClassico(db, balancoId)
    : agregarContagemPipeline(db, balancoId);

/* -------------------------------------------------------------------------- */
/* Depósito scan                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every estoque doc held in one depósito, keyed by produto.
 *
 * Runs ONLY when `zerarNaoContados` is on, because that is the only mode that
 * needs the set of produtos it could zero — and a produto with no estoque doc
 * in this depósito has no stock here, so nothing to zero. Legacy instead loaded
 * the entire non-kit catalogue and wrote an estoque + a history row for every
 * product in it.
 *
 * It also counts, for free, the estoque docs whose id is not the canonical
 * `est-<produtoId>-<depositoId>` — a legacy anomaly the finalize reports rather
 * than deletes.
 */
export const varrerDepositoClassico: VarrerDeposito = async (db, depositoId) => {
  const encontrados = new Map<string, EstoqueDoDeposito>();
  const base = estoqueCollection
    .groupQuery(db)
    // The outerRef invariant: readers tolerate the bare form too. Matching both
    // costs one extra index scan and cannot silently miss a depósito.
    .where('depositoOuterRef', 'in', [
      `documents/depositos/${depositoId}`,
      `depositos/${depositoId}`,
    ])
    .orderBy(FieldPath.documentId())
    .limit(PAGINA_ESTOQUES)
    // Keys-only but for the produto id: the counters are re-read in phase B.
    .select('parentId');
  let cursor: DocumentSnapshot | null = null;
  for (;;) {
    const pagina: QuerySnapshot = await (cursor ? base.startAfter(cursor) : base).get();
    if (pagina.empty) break;
    for (const doc of pagina.docs) {
      const dados = doc.data();
      // `parentId` is the denormalized produto id; fall back to the path so a
      // legacy doc that never got the denorm is still seen.
      const produtoId =
        typeof dados.parentId === 'string' && dados.parentId !== ''
          ? dados.parentId
          : (doc.ref.parent.parent?.id ?? '');
      if (produtoId === '') continue;
      const canonico = doc.id === makeEstoqueUid(produtoId, depositoId);
      const anterior = encontrados.get(produtoId);
      encontrados.set(produtoId, { extras: (anterior?.extras ?? 0) + (canonico ? 0 : 1) });
    }
    if (pagina.size < PAGINA_ESTOQUES) break;
    cursor = pagina.docs[pagina.size - 1] ?? null;
    if (!cursor) break;
  }
  return encontrados;
};

/* -------------------------------------------------------------------------- */
/* Phase A — freeze the work list                                              */
/* -------------------------------------------------------------------------- */

interface DetalheProduto {
  sku: string | null;
  nome: string | null;
  ehKit: boolean;
}

/** Field-masked produto reads — only what the report and the kit guard need. */
async function lerDetalhesProduto(
  db: Firestore,
  produtoIds: string[],
): Promise<Map<string, DetalheProduto>> {
  const detalhes = new Map<string, DetalheProduto>();
  for (let i = 0; i < produtoIds.length; i += PRODUTOS_POR_LEITURA) {
    const fatia = produtoIds.slice(i, i + PRODUTOS_POR_LEITURA);
    const refs = fatia.map((id) => produtoCollection.docRef(db, {}, id));
    const snaps = await db.getAll(...refs, { fieldMask: ['sku', 'nome', 'ehKit'] });
    snaps.forEach((snap, j) => {
      const id = fatia[j];
      if (id === undefined) return;
      const dados = snap.exists ? (snap.data() as DocumentData) : {};
      detalhes.set(id, {
        sku: typeof dados.sku === 'string' ? dados.sku : null,
        nome: typeof dados.nome === 'string' ? dados.nome : null,
        ehKit: dados.ehKit === true,
      });
    });
  }
  return detalhes;
}

/**
 * Build the work list and freeze it into `relatorios` shards, then record how
 * many shards there are. Deterministic shard ids mean a retried phase A
 * overwrites its own shards rather than duplicating them.
 */
async function congelarListaTrabalho(
  deps: BalancoDeps,
  balancoId: string,
  depositoId: string,
  zerarNaoContados: boolean,
): Promise<number> {
  const { db } = deps;
  const contagem = await deps.agregar(db, balancoId);
  const doDeposito = zerarNaoContados ? await deps.varrer(db, depositoId) : new Map();

  const detalhes = await lerDetalhesProduto(db, [
    ...new Set([...contagem.keys(), ...doDeposito.keys()]),
  ]);

  // A kit holds no stock of its own — it is expanded into components at sale
  // time (ADR 0014), and `estoqueDisponivelComKit` ADDS a kit's own quantity to
  // the component-derived figure. Writing a counted quantity onto a kit would
  // therefore invent stock. The counting screen already refuses kits (they
  // become error movimentos), so this is defence in depth; loud, because a hit
  // means the UI guard leaked.
  const kits = new Set<string>();
  for (const [produtoId, detalhe] of detalhes) if (detalhe.ehKit) kits.add(produtoId);
  const kitsContados = [...contagem.keys()].filter((id) => kits.has(id));
  if (kitsContados.length > 0) {
    logger.warn(
      `aplicarBalanco: ${balancoId} — ${kitsContados.length} kit(s) com lançamento foram IGNORADOS ` +
        `(kits não guardam estoque próprio): ${kitsContados.slice(0, 20).join(', ')}`,
    );
    for (const id of kitsContados) contagem.delete(id);
  }

  const itens = montarListaTrabalho({
    contagem,
    comEstoque: new Set(doDeposito.keys()),
    kits,
    extrasPorProduto: new Map([...doDeposito].map(([id, e]) => [id, e.extras])),
    detalhes: new Map([...detalhes].map(([id, d]) => [id, { sku: d.sku, nome: d.nome }])),
    zerarNaoContados,
  });

  const shards = montarShardsRelatorio(itens, RELATORIO_BALANCO_SHARD_SIZE);
  const agoraMs = deps.agora();
  for (const [index, body] of shards.entries()) {
    await relatorioBalancoCollection.set(db, { balancoId }, relatorioBalancoShardId(index), {
      itens: body,
      timestamp: agoraMs,
    });
  }
  await balancoCollection
    .docRef(db, {}, balancoId)
    .update({ 'finalizacao.shards': shards.length, 'finalizacao.shardCursor': 0 });
  logger.info(
    `aplicarBalanco: ${balancoId} — lista congelada: ${itens.length} produto(s) em ${shards.length} shard(s)`,
  );
  return shards.length;
}

/* -------------------------------------------------------------------------- */
/* Phase B — apply, shard by shard                                             */
/* -------------------------------------------------------------------------- */

/** Read one shard back as an ordered work list. */
function itensDoShard(dados: DocumentData): Array<{ produtoId: string; contado: number }> {
  const itens = (dados.itens ?? {}) as Record<string, ItemRelatorioBalanco>;
  return Object.entries(itens)
    .map(([produtoId, item]) => ({
      // `contado: null` means the produto was never counted and is only here
      // because `zerar` is on — it applies as 0.
      produtoId,
      contado:
        typeof item?.contado === 'number' && Number.isFinite(item.contado) ? item.contado : 0,
    }))
    .sort((a, b) => a.produtoId.localeCompare(b.produtoId));
}

/**
 * Apply one chunk of produtos in a single transaction, and patch the same
 * chunk's observed "before" values into the shard as part of it.
 *
 * Patching inside the transaction is deliberate: the estoque write and the
 * report line that explains it either both land or neither does, so a crash
 * mid-shard can never leave a produto applied with no record of what it
 * replaced.
 */
async function aplicarChunk(
  deps: BalancoDeps,
  args: {
    balancoId: string;
    depositoId: string;
    shardRef: DocumentReference;
    motivo: string;
    usuarioOuterRef: string | null;
    itens: Array<{ produtoId: string; contado: number }>;
  },
): Promise<number> {
  const { db } = deps;
  const { balancoId, depositoId, shardRef, motivo, usuarioOuterRef, itens } = args;
  if (itens.length === 0) return 0;
  const agoraMs = deps.agora();

  // ONE deterministic history id per (balanço, produto): it doubles as the
  // "already applied" marker, which is what makes a resume safe. Re-deriving
  // `contado − atual` against a value this job already moved would write a
  // second, wrong delta onto a ledger that must stay summable (ADR 0014).
  const historicoId = `balanco-${balancoId}`;

  const alvos = itens.map(({ produtoId, contado }) => {
    const estoqueId = makeEstoqueUid(produtoId, depositoId);
    return {
      produtoId,
      contado,
      estoqueId,
      estoqueRef: estoqueCollection.docRef(db, { produtoId }, estoqueId),
      historicoRef: historicoEstoqueCollection.docRef(db, { produtoId, estoqueId }, historicoId),
    };
  });

  return db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(
      ...alvos.map((a) => a.estoqueRef),
      ...alvos.map((a) => a.historicoRef),
    );
    const estoques = snaps.slice(0, alvos.length);
    const historicos = snaps.slice(alvos.length);

    let aplicados = 0;
    const patchShard: unknown[] = [];

    alvos.forEach((alvo, i) => {
      const estoqueSnap = estoques[i] as DocumentSnapshot;
      const dados = estoqueSnap.exists ? (estoqueSnap.data() as DocumentData) : null;
      const acao = planejarItemBalanco({
        produtoId: alvo.produtoId,
        contado: alvo.contado,
        atual: dados
          ? { quantidade: dados.quantidade, quantidadeReservada: dados.quantidadeReservada }
          : null,
        jaAplicado: historicos[i]?.exists === true,
        motivo,
        agoraMs,
      });

      if (acao.tipo === 'ja-aplicado') return;

      patchShard.push(new FieldPath('itens', alvo.produtoId, 'estoque'), acao.estoqueAntes);
      if (acao.tipo === 'inalterado') return;

      // Same writer as the manual balanço path (`aplicarEstoque`): merge-set is
      // the getOrCreate, the counted values land verbatim (already clamped in
      // the plan), and `ultimaModificacao: maximum(now)` makes the change
      // visible to the ML stock sweep — the bump legacy never did, which is why
      // a legacy balanço never republished a price/stock change.
      const write = movimentoEstoqueWrite(alvo.produtoId, depositoId, acao.plan, agoraMs);
      tx.set(alvo.estoqueRef, write.base, { merge: true });
      tx.set(
        alvo.historicoRef,
        historicoEstoqueCollection.parse({
          ...acao.plan.historico,
          parentId: alvo.produtoId,
          depositoOuterRef: `documents/depositos/${depositoId}`,
          tipo: 'balanco',
          usuarioOuterRef,
        }),
      );
      aplicados += 1;
    });

    if (patchShard.length > 0) {
      const [primeiro, segundo, ...resto] = patchShard as [FieldPath, unknown, ...unknown[]];
      tx.update(shardRef, primeiro, segundo, ...resto);
    }
    return aplicados;
  });
}

/* -------------------------------------------------------------------------- */
/* The job                                                                     */
/* -------------------------------------------------------------------------- */

export type ResultadoBalanco = 'ignorado' | 'continua' | 'finalizado' | 'parado';

/**
 * The finalize worker. Idempotent at produto granularity and resumable at shard
 * granularity, so a timeout, a crash or a Cloud Tasks redelivery picks up where
 * it stopped instead of re-applying stock.
 *
 * Exported without auth so the emulator suite drives it directly, exactly like
 * `aplicarMovimento`.
 */
export async function processarBalancoJob(
  deps: BalancoDeps,
  payload: BalancoTaskPayload,
  retryCount: number,
): Promise<ResultadoBalanco> {
  const { db } = deps;
  const { balancoId } = payload;
  const inicio = deps.agora();
  const balancoRef = balancoCollection.docRef(db, {}, balancoId);

  const snap = await balancoRef.get();
  if (!snap.exists) {
    logger.warn(`aplicarBalanco: ${balancoId} não existe — tarefa descartada`);
    return 'ignorado';
  }
  const balanco = balancoCollection.parseRead(snap.data(), snap.ref.path);
  if (balanco.estado !== ESTADO_BALANCO.finalizando) {
    // A redelivery after the job already finished, or after an operator-visible
    // failure parked it. Nothing to do, and nothing to complain about.
    logger.info(`aplicarBalanco: ${balancoId} não está finalizando (${balanco.estado}) — ignorado`);
    return 'ignorado';
  }

  const depositoId = idFromRef(balanco.depositoOuterRef);
  const motivo = motivoBalanco(balanco.nome);
  const usuarioOuterRef = balanco.finalizacao?.usuarioOuterRef ?? null;
  const zerarNaoContados = balanco.finalizacao?.zerarNaoContados ?? false;

  try {
    const shards =
      balanco.finalizacao?.shards ??
      (await congelarListaTrabalho(deps, balancoId, depositoId, zerarNaoContados));

    let cursor = balanco.finalizacao?.shardCursor ?? 0;
    while (cursor < shards) {
      const shardRef = relatorioBalancoCollection.docRef(
        db,
        { balancoId },
        relatorioBalancoShardId(cursor),
      );
      const shardSnap = await shardRef.get();
      const itens = shardSnap.exists ? itensDoShard(shardSnap.data() as DocumentData) : [];

      let aplicados = 0;
      for (let i = 0; i < itens.length; i += PRODUTOS_POR_TRANSACAO) {
        aplicados += await aplicarChunk(deps, {
          balancoId,
          depositoId,
          shardRef,
          motivo,
          usuarioOuterRef,
          itens: itens.slice(i, i + PRODUTOS_POR_TRANSACAO),
        });
      }

      cursor += 1;
      await balancoRef.update({
        'finalizacao.shardCursor': cursor,
        // Exact despite retries: a re-run of an already-applied shard finds
        // every marker present and reports 0 newly-applied.
        'finalizacao.produtosAplicados': FieldValue.increment(aplicados),
      });

      if (cursor < shards && deps.agora() - inicio > ORCAMENTO_MS) {
        await deps.scheduler.enqueue({ balancoId });
        logger.info(`aplicarBalanco: ${balancoId} — pausado em ${cursor}/${shards}, reenfileirado`);
        return 'continua';
      }
    }

    await balancoRef.update({
      estado: ESTADO_BALANCO.finalizado,
      dataFinalizado: deps.agora(),
      'finalizacao.erro': null,
    });
    logger.info(`aplicarBalanco: ${balancoId} finalizado (${shards} shard(s))`);
    return 'finalizado';
  } catch (err) {
    // A movimento we cannot express as a signed delta is never worth guessing —
    // park immediately rather than burning retries on a deterministic failure.
    const fatal = err instanceof MovimentoBalancoIndefinidoError;
    if (!fatal && retryCount < BALANCO_MAX_ATTEMPTS - 1) throw err;

    const mensagem = err instanceof Error ? err.message : String(err);
    await balancoRef.update({
      estado: ESTADO_BALANCO.erro,
      'finalizacao.erro': mensagem.slice(0, 2000),
    });
    logger.error(`aplicarBalanco: ${balancoId} parado em erro — ${mensagem}`);
    return 'parado';
  }
}

/* -------------------------------------------------------------------------- */
/* Callable + worker                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Take the workflow lock and queue the job. One transaction, so two operators
 * pressing Finalizar at the same moment cannot both start.
 *
 * Exported without auth for the emulator suite.
 */
export async function tomarTravaBalanco(
  db: Firestore,
  scheduler: BalancoScheduler,
  comando: FinalizarBalancoComando,
  usuarioOuterRef: string | null,
  agoraMs: number,
): Promise<FinalizarBalancoResult> {
  const balancoRef = balancoCollection.docRef(db, {}, comando.balancoId);

  const retomado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(balancoRef);
    if (!snap.exists) throw new BalancoNaoEncontradoError(comando.balancoId);
    const balanco = balancoCollection.parseRead(snap.data(), snap.ref.path);
    if (!podeFinalizarBalanco(balanco)) throw new BalancoNaoFinalizavelError(balanco.estado);

    const eraErro = balanco.estado === ESTADO_BALANCO.erro;
    tx.update(balancoRef, {
      estado: ESTADO_BALANCO.finalizando,
      finalizacao: {
        // A retry keeps the frozen work list (`shards`/`shardCursor`) so it
        // resumes rather than re-aggregating; a fresh run has neither.
        ...(eraErro ? (balanco.finalizacao ?? {}) : {}),
        iniciadoEm: agoraMs,
        usuarioOuterRef,
        zerarNaoContados: comando.zerarNaoContados,
        erro: null,
      },
    });
    return eraErro;
  });

  try {
    await scheduler.enqueue({ balancoId: comando.balancoId });
  } catch (err) {
    // The lock is taken but nothing will ever run it — park the doc rather than
    // leave it stuck in `finalizando`, which is precisely legacy's dead end.
    await balancoRef.update({
      estado: ESTADO_BALANCO.erro,
      'finalizacao.erro': 'Não foi possível enfileirar a finalização.',
    });
    throw err;
  }
  return { balancoId: comando.balancoId, retomado };
}

export class BalancoNaoEncontradoError extends Error {
  constructor(readonly balancoId: string) {
    super(`Balanço ${balancoId} não encontrado.`);
    this.name = 'BalancoNaoEncontradoError';
  }
}

export class BalancoNaoFinalizavelError extends Error {
  constructor(readonly estado: string | null) {
    super(`Balanço não pode ser finalizado no estado ${estado ?? 'aberto'}.`);
    this.name = 'BalancoNaoFinalizavelError';
  }
}

/**
 * `finalizarBalanco` — the client's only way to turn a count into stock.
 *
 * The legacy Flutter finalize did all of this in the browser: it overwrote
 * `estoque.quantidade`, deleted estoque docs, and wrote the audit trail from
 * client-supplied values, with no server check that any of it corresponded to a
 * real balanço. Here the payload carries no quantities at all — every number is
 * derived server-side from the balanço's own movimentos, and `motivo` / `tipo` /
 * `usuarioOuterRef` are stamped from the balanço doc and this token.
 */
export const finalizarBalanco = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Usuário não autenticado.');
  }
  const token = request.auth.token as { permissions?: string; su?: boolean };
  if (token.su !== true && !hasPerm(token.permissions, PERM.estoque.write)) {
    throw new HttpsError('permission-denied', 'Sem permissão para aplicar o balanço.');
  }
  const parsed = finalizarBalancoSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Comando de balanço inválido.');
  }

  try {
    const result = await tomarTravaBalanco(
      getDb(),
      createBalancoScheduler(),
      parsed.data,
      `documents/usuarios/${request.auth.uid}`,
      Date.now(),
    );
    logger.info(
      `finalizarBalanco: ${result.balancoId} enfileirado${result.retomado ? ' (retomada)' : ''} por ${request.auth.uid}`,
    );
    return result;
  } catch (err) {
    if (err instanceof BalancoNaoEncontradoError) {
      throw new HttpsError('not-found', err.message);
    }
    if (err instanceof BalancoNaoFinalizavelError) {
      // An explicit refusal, not legacy's silent abort: the operator sees why.
      throw new HttpsError('failed-precondition', err.message);
    }
    throw err;
  }
});

/**
 * Cloud Tasks dispatcher for the finalize job. `maxConcurrentDispatches: 1`
 * because the balanço doc is the checkpoint — two dispatches of the same job
 * would race its cursor.
 *
 * ⚠️ The export name below IS the deployed function AND the queue name; it must
 * equal {@link BALANCO_QUEUE}.
 */
export const processarBalanco = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: BALANCO_MAX_ATTEMPTS,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    timeoutSeconds: 540,
  },
  async (req) => {
    let payload: BalancoTaskPayload;
    try {
      payload = balancoTaskSchema.parse(req.data);
    } catch (err) {
      if (err instanceof z.ZodError) {
        // This queue only ever receives our own `{ balancoId }` — a malformed
        // payload is an enqueue bug, and there is no doc to park.
        logger.error(`${BALANCO_QUEUE}: payload inválido, tarefa descartada — ${err.message}`);
        return;
      }
      throw err;
    }

    const resultado = await processarBalancoJob(
      {
        db: getDb(),
        scheduler: createBalancoScheduler(),
        agregar: agregarContagemPadrao,
        varrer: varrerDepositoClassico,
        agora: () => Date.now(),
      },
      payload,
      req.retryCount ?? 0,
    );
    logger.info(`${BALANCO_QUEUE}: ${payload.balancoId} → ${resultado}`);
  },
);
