import type {
  DocumentData,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  estoqueCollection,
  historicoEstoqueCollection,
  incidenteCollection,
  integracaoCollection,
  operacaoCollection,
  pedidoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';
import {
  calcularAlteracoesEstoque,
  planSincronizacaoEstoque,
  temEfeitoAplicado,
  temMovimentoAplicado,
  type ItemParaEstoque,
  type PlanoSincronizacaoEstoque,
  type ProdutoParaEstoque,
} from '@delfrance/data/pedido';
import {
  ESTADOS_PEDIDO_MOVIMENTACAO,
  TIPO_INCIDENTE,
  TIPO_NFE,
  efeitoEstoquePedido,
  estadoFreteSchema,
  estadoPedidoSchema,
  estoqueAplicadoSchema,
  makeEstoqueUid,
  pedidoMeta,
  type EstadoFrete,
  type EstadoPedido,
  type EstoqueAplicado,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/* -------------------------------------------------------------------------- */
/*                Loop guards — see the PR's "Loop prevention"                */
/* -------------------------------------------------------------------------- */

/**
 * Pedido fields (dot-paths) whose change makes the sync re-evaluate — the
 * INPUTS of the desired-state computation. The trigger's fast-path compares
 * `before` vs `after` on exactly these and exits untouched otherwise.
 */
export const CAMPOS_OBSERVADOS = [
  'estado',
  'freteInicial.estado',
  'itens',
  'ehSaida',
  'operacaoPedidoOuterRef',
  'integracaoPedidoOuterRef',
] as const;

/**
 * Pedido fields the sync may WRITE. MUST stay disjoint from
 * {@link CAMPOS_OBSERVADOS} (unit-tested): the function never writes a field it
 * watches, so its own pedido update can never re-activate it — the event chain
 * is acyclic by construction, independent of the convergence guarantee.
 */
export const CAMPOS_ESCRITOS = [
  'estoqueAplicado',
  'dataIndisponivelEstoque',
  'dataRemocaoEstoque',
] as const;

function valorNoCaminho(data: DocumentData | null, caminho: string): unknown {
  if (!data) return undefined;
  let atual: unknown = data;
  for (const parte of caminho.split('.')) {
    if (atual === null || typeof atual !== 'object') return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

/** Deterministic deep stringify (sorted object keys) for change detection. */
function canonico(valor: unknown): string {
  if (valor === undefined) return 'undefined';
  return JSON.stringify(valor, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const ordenado: Record<string, unknown> = {};
      for (const chave of Object.keys(v as Record<string, unknown>).sort()) {
        ordenado[chave] = (v as Record<string, unknown>)[chave];
      }
      return ordenado;
    }
    return v;
  });
}

/**
 * Trigger fast-path: did any OBSERVED input change between the two revisions?
 * Exported (pure) for the unit tests.
 */
export function mudouCampoObservado(
  before: DocumentData | null,
  after: DocumentData | null,
): boolean {
  return CAMPOS_OBSERVADOS.some(
    (caminho) =>
      canonico(valorNoCaminho(before, caminho)) !== canonico(valorNoCaminho(after, caminho)),
  );
}

/* -------------------------------------------------------------------------- */
/*                        Tolerant pedido-doc extraction                      */
/* -------------------------------------------------------------------------- */

interface PedidoParaSync {
  estado: EstadoPedido;
  estadoFrete: EstadoFrete | null;
  itens: Record<string, ItemParaEstoque[]>;
  ehSaidaPedido: boolean;
  numero: string | null;
  integracaoId: string | null;
  operacaoId: string | null;
  aplicado: EstoqueAplicado | null;
  temMarcadorLegado: boolean;
  dataIndisponivelEstoque: number | null;
  dataRemocaoEstoque: number | null;
}

/** `'documents/<col>/<id>'` → `<id>` (outer-ref doc-path string). */
function idDeOuterRef(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length === 0) return null;
  const partes = valor.split('/').filter(Boolean);
  return partes.length > 0 ? (partes[partes.length - 1] ?? null) : null;
}

const itemLooseSchema = z.object({
  produtoUid: z.string().nullish(),
  quantidade: z.number().nullish(),
});

function extrairItens(raw: unknown): Record<string, ItemParaEstoque[]> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const itens: Record<string, ItemParaEstoque[]> = {};
  for (const [chave, lista] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(lista)) continue;
    const extraidos: ItemParaEstoque[] = [];
    for (const item of lista) {
      const parsed = itemLooseSchema.safeParse(item);
      if (parsed.success) {
        extraidos.push({
          produtoUid: parsed.data.produtoUid ?? null,
          quantidade: parsed.data.quantidade ?? 0,
        });
      }
    }
    itens[chave] = extraidos;
  }
  return itens;
}

function numeroOuNull(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * Focused, tolerant extraction of the sync's inputs from a raw pedido doc.
 * Full-schema validation is deliberately NOT used: a legacy field elsewhere in
 * the doc must not block stock movement. Returns null (with the reason) only
 * when a field the sync cannot proceed without is broken.
 */
function extrairPedido(raw: DocumentData): { pedido: PedidoParaSync } | { erro: string } {
  const estadoParse = estadoPedidoSchema.safeParse(raw.estado);
  if (!estadoParse.success) return { erro: `estado inválido: ${String(raw.estado)}` };

  const freteEstadoRaw = valorNoCaminho(raw, 'freteInicial.estado');
  const freteParse = estadoFreteSchema.safeParse(freteEstadoRaw);

  let aplicado: EstoqueAplicado | null = null;
  if (raw.estoqueAplicado != null) {
    const aplicadoParse = estoqueAplicadoSchema.safeParse(raw.estoqueAplicado);
    if (!aplicadoParse.success) return { erro: 'estoqueAplicado inválido' };
    aplicado = aplicadoParse.data;
  }

  return {
    pedido: {
      estado: estadoParse.data,
      estadoFrete: freteParse.success ? freteParse.data : null,
      itens: extrairItens(raw.itens),
      ehSaidaPedido: raw.ehSaida !== false,
      numero: typeof raw.numero === 'string' ? raw.numero : null,
      integracaoId: idDeOuterRef(raw.integracaoPedidoOuterRef),
      operacaoId: idDeOuterRef(raw.operacaoPedidoOuterRef),
      aplicado,
      temMarcadorLegado:
        aplicado === null &&
        (raw.dataIndisponivelEstoque != null || raw.dataRemocaoEstoque != null),
      dataIndisponivelEstoque: numeroOuNull(raw.dataIndisponivelEstoque),
      dataRemocaoEstoque: numeroOuNull(raw.dataRemocaoEstoque),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              The sync core                                 */
/* -------------------------------------------------------------------------- */

export type ResultadoSync =
  | { status: 'aplicado'; deltas: number }
  | { status: 'nada-a-fazer' }
  | { status: 'ignorado'; motivo: string };

export interface SincronizarOpts {
  /** Firestore event id (trigger) or a synthetic id (callable) — audit trace. */
  eventId?: string | null;
  /** Who requested a manual resync — stamped on the audit records. */
  usuarioOuterRef?: string | null;
}

function ehSaidaDaOperacao(rawOp: DocumentData, fallback: boolean): boolean {
  const tipo: unknown = rawOp.tipo;
  if (tipo === TIPO_NFE.saida) return true;
  if (tipo === TIPO_NFE.entrada) return false;
  return fallback;
}

/** Coerce a stored counter defensively (legacy docs may hold junk). */
function contadorOuZero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/**
 * Incidente payload for a drift event — the `quantidadeReservada` clamp
 * absorbing a release means something outside the sync mutated the counters
 * (#408). `tipo` stays `'o'` (Outros): the wire enum is legacy/Flutter-shared,
 * so a new value could break the Dart parser; the passthrough `subtipo` marker
 * is the structured identifier the UI filters on. Exported for the unit tests.
 */
/** `incidenteSchema.motivoDoIncidente` caps at 2000 chars — a parse throw here
 *  would abort the SYNC transaction over an audit nicety, so truncate instead. */
const MOTIVO_MAX = 2000;

export function incidenteDrift(args: {
  estoqueId: string;
  reservadaAntes: number;
  deltaReservada: number;
  pedidoNumero: string | null;
  agoraMs: number;
}): Record<string, unknown> {
  const agoraUs = args.agoraMs * 1000;
  const liberado = Math.abs(args.deltaReservada);
  const motivo =
    `[Estoque] Divergência de reserva em ${args.estoqueId}: liberação de ` +
    `${liberado} unidade(s) (delta ${args.deltaReservada}) sobre ${args.reservadaAntes} ` +
    `reservada(s) foi limitada em 0 — os contadores foram alterados fora da sincronização` +
    (args.pedidoNumero ? ` (pedido ${args.pedidoNumero})` : '') +
    `. Confira o estoque físico e ajuste via balanço.`;
  return {
    origem: null,
    tipo: TIPO_INCIDENTE.outros,
    subtipo: 'estoque-drift',
    motivoDoIncidente: motivo.length > MOTIVO_MAX ? `${motivo.slice(0, MOTIVO_MAX - 1)}…` : motivo,
    comentarios: null,
    timestamp: agoraUs,
    ultimaModificacao: agoraUs,
    externalId: null,
    resolucao: null,
  };
}

async function aplicarPlano(
  db: Firestore,
  tx: Transaction,
  plano: PlanoSincronizacaoEstoque,
  contexto: {
    pedidoId: string;
    pedidoNumero: string | null;
    eventId: string | null;
    usuarioOuterRef: string | null;
    agoraMs: number;
    /** Record an `estoque-drift` incidente when the reservada clamp fires
     *  (#408). False on the pedido-deletion reversal — the parent doc is gone. */
    registrarDrift: boolean;
    /** Deterministic historico ids (idempotent pedido-deletion reversal). */
    historicoIdPorDelta?: (produtoId: string, depositoId: string) => string;
  },
): Promise<void> {
  const refs = plano.deltas.map((delta) => ({
    delta,
    estoqueId: makeEstoqueUid(delta.produtoId, delta.depositoId),
    ref: estoqueCollection.docRef(
      db,
      { produtoId: delta.produtoId },
      makeEstoqueUid(delta.produtoId, delta.depositoId),
    ),
  }));
  const snaps = refs.length > 0 ? await tx.getAll(...refs.map((r) => r.ref)) : [];

  // Idempotency reads for deterministic historico ids (deletion reversal).
  const historicoRefs = contexto.historicoIdPorDelta
    ? refs.map(({ delta, estoqueId }) =>
        historicoEstoqueCollection.docRef(
          db,
          { produtoId: delta.produtoId, estoqueId },
          contexto.historicoIdPorDelta!(delta.produtoId, delta.depositoId),
        ),
      )
    : null;
  const historicoSnaps = historicoRefs ? await tx.getAll(...historicoRefs) : null;

  refs.forEach(({ delta, estoqueId, ref }, i) => {
    if (historicoSnaps && historicoSnaps[i]?.exists) {
      logger.info(
        `sincronizarEstoquePedido: reversão de ${contexto.pedidoId} já aplicada em ${estoqueId} — pulando`,
      );
      return;
    }

    const snap = snaps[i] as DocumentSnapshot;
    const dados = snap.exists ? (snap.data() as DocumentData) : null;
    const quantidadeAntes = contadorOuZero(dados?.quantidade);
    const reservadaAntes = contadorOuZero(dados?.quantidadeReservada);
    const quantidadeDepois = quantidadeAntes + delta.deltaQuantidade;
    const reservadaCrua = reservadaAntes + delta.deltaReservada;
    const reservadaDepois = Math.max(0, reservadaCrua);
    if (reservadaCrua < 0) {
      // The floor absorbing a release is exactly the drift the snapshot design
      // prevents — if it ever fires, something outside the sync mutated the
      // counters. Loud on purpose, and persisted as an incidente on the pedido
      // (#408) so it surfaces in the UI — a SUBcollection write, so it cannot
      // touch CAMPOS_OBSERVADOS (no loop-guard interaction).
      logger.warn(
        `sincronizarEstoquePedido: clamp de quantidadeReservada em ${estoqueId} ` +
          `(${reservadaAntes} + ${delta.deltaReservada} → 0) — pedido ${contexto.pedidoId}`,
      );
      if (contexto.registrarDrift) {
        tx.set(
          incidenteCollection.ref(db, { pedidoId: contexto.pedidoId }).doc(),
          incidenteCollection.parse(
            incidenteDrift({
              estoqueId,
              reservadaAntes,
              deltaReservada: delta.deltaReservada,
              pedidoNumero: contexto.pedidoNumero,
              agoraMs: contexto.agoraMs,
            }),
          ),
        );
      }
    }

    if (snap.exists) {
      tx.update(ref, {
        quantidade: quantidadeDepois,
        quantidadeReservada: reservadaDepois,
        ultimaModificacao: Math.max(contadorOuZero(dados?.ultimaModificacao), contexto.agoraMs),
      });
    } else {
      tx.set(
        ref,
        estoqueCollection.parse({
          parentId: delta.produtoId,
          depositoOuterRef: `documents/depositos/${delta.depositoId}`,
          localizacao: null,
          quantidade: quantidadeDepois,
          quantidadeReservada: reservadaDepois,
          dataCriacao: contexto.agoraMs,
          ultimaModificacao: contexto.agoraMs,
        }),
      );
    }

    const historicoRef =
      historicoRefs?.[i] ??
      historicoEstoqueCollection.ref(db, { produtoId: delta.produtoId, estoqueId }).doc();
    tx.set(
      historicoRef,
      historicoEstoqueCollection.parse({
        ehBalanco: null,
        quantidade: delta.deltaQuantidade,
        quantidadeReservada: delta.deltaReservada,
        motivo: delta.motivo,
        timestamp: contexto.agoraMs,
        tipo: delta.tipo,
        pedidoOuterRef: `documents/pedidos/${contexto.pedidoId}`,
        pedidoNumero: contexto.pedidoNumero,
        quantidadeAntes,
        quantidadeDepois,
        quantidadeReservadaAntes: reservadaAntes,
        quantidadeReservadaDepois: reservadaDepois,
        usuarioOuterRef: contexto.usuarioOuterRef,
        eventId: contexto.eventId,
      }),
    );
  });
}

/**
 * Converge a pedido's stock effect — the pedido→estoque sync core (exported for
 * the emulator suite and the resync callable; the trigger wraps it).
 *
 * One transaction: read pedido → (if an effect may apply) integração + operação
 * + produtos (kit expansion) → diff desired vs `estoqueAplicado` (pure planner)
 * → read affected estoques → write estoque counters + one `historicoEstoque`
 * audit record per estoque (exact before/after) + the pedido snapshot/markers.
 * Zero deltas ⇒ zero writes (loop guard 3). Re-runs converge; every skip is
 * logged with its reason (the legacy code's silent `return`s).
 */
export async function sincronizarEstoquePedido(
  db: Firestore,
  pedidoId: string,
  opts: SincronizarOpts = {},
): Promise<ResultadoSync> {
  const agoraMs = Date.now();
  const agoraUs = agoraMs * 1000;

  const resultado = await db.runTransaction(async (tx): Promise<ResultadoSync> => {
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) return { status: 'ignorado', motivo: 'pedido inexistente' };

    const extraido = extrairPedido(pedidoSnap.data() as DocumentData);
    if ('erro' in extraido) return { status: 'ignorado', motivo: extraido.erro };
    const pedido = extraido.pedido;

    // Flutter-era pedido: markers set but no snapshot — the applied quantities
    // are unknown, so this sync must not guess (see estoqueAplicadoSchema doc).
    if (pedido.temMarcadorLegado)
      return { status: 'ignorado', motivo: 'marcadores legados sem snapshot' };

    const estadoAtivo = ESTADOS_PEDIDO_MOVIMENTACAO.has(pedido.estado);
    if (!estadoAtivo && !temEfeitoAplicado(pedido.aplicado)) {
      return { status: 'nada-a-fazer' };
    }

    // Config (integração → depósito; operação → flags/direction) is needed only
    // when the pedido may APPLY an effect. A pure reversal (estado outside the
    // MOVIMENTACAO set) works from the snapshot alone — so a cancelled pedido
    // still restocks even if its integração/operação got deleted meanwhile.
    let depositoId = pedido.aplicado?.depositoId ?? null;
    let operacaoIdResolvida = pedido.aplicado?.operacaoId ?? null;
    let ehSaida = pedido.aplicado?.ehSaida ?? pedido.ehSaidaPedido;
    let movimentaEstoque = false;
    let movimentaIndisponivelEstoque = false;

    if (estadoAtivo) {
      if (!pedido.integracaoId) {
        return { status: 'ignorado', motivo: 'pedido sem integração' };
      }
      const integracaoSnap = await tx.get(integracaoCollection.docRef(db, {}, pedido.integracaoId));
      if (!integracaoSnap.exists) {
        return { status: 'ignorado', motivo: `integração ${pedido.integracaoId} inexistente` };
      }
      const integracao = integracaoSnap.data() as DocumentData;
      depositoId = idDeOuterRef(integracao.depositoOuterRef);
      if (!depositoId) {
        return { status: 'ignorado', motivo: `integração ${pedido.integracaoId} sem depósito` };
      }

      operacaoIdResolvida =
        pedido.operacaoId ??
        idDeOuterRef(
          pedido.ehSaidaPedido ? integracao.operacaoOuterRef : integracao.operacaoDevolucaoOuterRef,
        );
      if (!operacaoIdResolvida) {
        return { status: 'ignorado', motivo: 'pedido sem operação resolvível' };
      }
      const operacaoSnap = await tx.get(operacaoCollection.docRef(db, {}, operacaoIdResolvida));
      if (!operacaoSnap.exists) {
        return { status: 'ignorado', motivo: `operação ${operacaoIdResolvida} inexistente` };
      }
      const operacao = operacaoSnap.data() as DocumentData;
      movimentaEstoque = operacao.movimentaEstoque !== false;
      movimentaIndisponivelEstoque = operacao.movimentaIndisponivelEstoque !== false;
      ehSaida = ehSaidaDaOperacao(operacao, pedido.ehSaidaPedido);
    }

    const efeito = efeitoEstoquePedido({
      estado: pedido.estado,
      estadoFrete: pedido.estadoFrete,
      ehSaida,
      movimentaEstoque,
      movimentaIndisponivelEstoque,
      jaMovimentado: temMovimentoAplicado(pedido.aplicado),
    });

    let alteracoes: Record<string, number> = {};
    if (efeito.reservar || efeito.remover || efeito.adicionar) {
      const produtoIds = [
        ...new Set(
          Object.values(pedido.itens)
            .flat()
            .map((item) => item.produtoUid)
            .filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== 'NONE'),
        ),
      ];
      const produtos = new Map<string, ProdutoParaEstoque | null>();
      if (produtoIds.length > 0) {
        const snaps = await tx.getAll(
          ...produtoIds.map((id) => produtoCollection.docRef(db, {}, id)),
        );
        snaps.forEach((snap, i) => {
          const id = produtoIds[i]!;
          if (!snap.exists) {
            produtos.set(id, null);
            logger.warn(
              `sincronizarEstoquePedido: produto ${id} do pedido ${pedidoId} não existe — item sem estoque`,
            );
            return;
          }
          const dados = snap.data() as DocumentData;
          const componentes = dados.componentesKit;
          produtos.set(id, {
            ehKit: dados.ehKit === true,
            componentesKit:
              componentes !== null && typeof componentes === 'object' && !Array.isArray(componentes)
                ? (componentes as ProdutoParaEstoque['componentesKit'])
                : null,
          });
        });
      }
      alteracoes = calcularAlteracoesEstoque(pedido.itens, produtos);
    }

    const plano = planSincronizacaoEstoque({
      alteracoes,
      efeito,
      aplicado: pedido.aplicado,
      depositoId: depositoId ?? 'desconhecido',
      operacaoId: operacaoIdResolvida,
      ehSaida,
      pedidoNumero: pedido.numero ?? pedidoId,
      agora: agoraUs,
    });

    if (plano.deltas.length === 0) return { status: 'nada-a-fazer' };

    await aplicarPlano(db, tx, plano, {
      pedidoId,
      pedidoNumero: pedido.numero,
      eventId: opts.eventId ?? null,
      usuarioOuterRef: opts.usuarioOuterRef ?? null,
      agoraMs,
      registrarDrift: true,
    });

    // ⚠️ Only CAMPOS_ESCRITOS — never a field the trigger observes (loop guard 1).
    tx.update(pedidoRef, {
      estoqueAplicado: plano.aplicadoDepois,
      dataIndisponivelEstoque: plano.reservaAtiva
        ? (pedido.dataIndisponivelEstoque ?? agoraUs)
        : null,
      dataRemocaoEstoque: plano.movimentoAtivo ? (pedido.dataRemocaoEstoque ?? agoraUs) : null,
    });

    return { status: 'aplicado', deltas: plano.deltas.length };
  });

  if (resultado.status === 'aplicado') {
    logger.info(`sincronizarEstoquePedido: ${pedidoId} → ${resultado.deltas} movimento(s)`);
  } else if (resultado.status === 'ignorado') {
    logger.warn(`sincronizarEstoquePedido: ${pedidoId} ignorado — ${resultado.motivo}`);
  }
  return resultado;
}

/**
 * Revert a DELETED pedido's applied stock from its last revision (`before`
 * data). The snapshot died with the doc, so idempotency comes from
 * deterministic `historicoEstoque` ids (`exclusao-<pedidoId>`): a redelivered
 * delete event finds the audit record and skips. (A pedido recreated under the
 * same id and deleted again would be skipped too — accepted: doc ids are
 * random, that flow doesn't exist.) Exported for the emulator suite.
 */
export async function reverterEstoquePedidoExcluido(
  db: Firestore,
  pedidoId: string,
  before: DocumentData,
  eventId: string | null,
): Promise<ResultadoSync> {
  const aplicadoParse = estoqueAplicadoSchema.safeParse(before.estoqueAplicado ?? null);
  const aplicado = aplicadoParse.success ? aplicadoParse.data : null;
  if (!aplicado || !temEfeitoAplicado(aplicado)) return { status: 'nada-a-fazer' };

  const agoraMs = Date.now();
  const numero = typeof before.numero === 'string' ? before.numero : pedidoId;

  const plano = planSincronizacaoEstoque({
    alteracoes: {},
    efeito: { reservar: false, remover: false, adicionar: false },
    aplicado,
    depositoId: aplicado.depositoId,
    operacaoId: aplicado.operacaoId,
    ehSaida: aplicado.ehSaida,
    pedidoNumero: numero,
    agora: agoraMs * 1000,
    tipoOverride: 'exclusaoPedido',
  });
  if (plano.deltas.length === 0) return { status: 'nada-a-fazer' };

  await db.runTransaction(async (tx) => {
    // If the pedido reappeared (same id), the normal sync owns it again.
    const pedidoSnap = await tx.get(pedidoCollection.docRef(db, {}, pedidoId));
    if (pedidoSnap.exists) return;
    await aplicarPlano(db, tx, plano, {
      pedidoId,
      pedidoNumero: typeof before.numero === 'string' ? before.numero : null,
      eventId,
      usuarioOuterRef: null,
      agoraMs,
      registrarDrift: false,
      historicoIdPorDelta: () => `exclusao-${pedidoId}`,
    });
  });

  logger.info(
    `sincronizarEstoquePedido: pedido ${pedidoId} excluído — ${plano.deltas.length} reversão(ões)`,
  );
  return { status: 'aplicado', deltas: plano.deltas.length };
}

/* -------------------------------------------------------------------------- */
/*                              Entry points                                  */
/* -------------------------------------------------------------------------- */

/**
 * The pedido→estoque trigger. Fires on EVERY pedido write (create/update/
 * delete), from any writer — the web editor, marketplace order ingestion,
 * scripts — and converges the stock effect. Guards: see CAMPOS_OBSERVADOS /
 * CAMPOS_ESCRITOS. Targets the NAMED `default` database (gotcha #8).
 */
export const onPedidoEstoqueSync = onDocumentWritten(
  {
    document: `${pedidoMeta.collectionPath}/{pedidoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { pedidoId } = event.params;
    const before = event.data?.before.exists ? (event.data.before.data() as DocumentData) : null;
    const after = event.data?.after.exists ? (event.data.after.data() as DocumentData) : null;

    if (!after) {
      if (before) await reverterEstoquePedidoExcluido(getDb(), pedidoId, before, event.id);
      return;
    }
    // Fast-path (loop guard 2): the sync's own write never touches an observed
    // field, so its retrigger exits here — no reads, no writes, no next event.
    if (before && !mudouCampoObservado(before, after)) return;

    await sincronizarEstoquePedido(getDb(), pedidoId, { eventId: event.id });
  },
);

const resincronizarInputSchema = z.object({ pedidoId: z.string().min(1) });

/**
 * Manual heal/backfill entry — re-runs the convergent sync for one pedido (the
 * safe replacement for the legacy `force: true`: it cannot double-apply, only
 * converge). Same auth model as `aplicarEstoque`.
 */
export const resincronizarEstoquePedido = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Usuário não autenticado.');
  }
  const token = request.auth.token as { permissions?: string; su?: boolean };
  if (token.su !== true && !hasPerm(token.permissions, PERM.estoque.write)) {
    throw new HttpsError('permission-denied', 'Sem permissão para movimentar estoque.');
  }
  const parsed = resincronizarInputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'pedidoId inválido.');
  }

  const resultado = await sincronizarEstoquePedido(getDb(), parsed.data.pedidoId, {
    eventId: `resync:${request.auth.uid}:${Date.now()}`,
    usuarioOuterRef: `documents/usuarios/${request.auth.uid}`,
  });
  logger.info(
    `resincronizarEstoquePedido: ${parsed.data.pedidoId} → ${resultado.status} (por ${request.auth.uid})`,
  );
  return resultado;
});
