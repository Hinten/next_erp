/**
 * The label routing of a Loja Integrada pedido (master plan step 15, #1825): the core of
 * `PUT /api/marketplace/loja-integrada/pedidos/[pedidoId]/rota-etiqueta`.
 *
 * A pedido imported from Loja Integrada may still name its conta's Loja Integrada `int_frete` doc
 * in `freteInicial.integracaoFreteOuterRef` — a doc no label path can print through. This re-points
 * it at the label target the conta's `mapa` (or the operator's choice) resolves, so every Melhor
 * Envio and generic label path, and the Melhor Envio webhook that derives its account from that
 * ref, then runs unchanged. The written shape is exactly the one a pedido routed at import has.
 *
 * ## Every decision is the shared module's, in the shared order
 *
 * The questions and their answers come from `@delfrance/schemas` (`mapaFreteLojaIntegrada.ts`),
 * the same functions the web's read-only preview (`apps/web/lib/loja-integrada/rotaEtiqueta.ts`)
 * calls in the same order, over the same raw reads — so a pre-save warning never predicts a route
 * this core would not take. One attempt:
 *
 *  1. the pedido, read RAW by id; absent ⇒ `pedido-nao-encontrado`;
 *  2. the `int_frete` doc its ref names (the shared ref reader: a ref naming none is `sem-rota-li`
 *     with no read), classified: a label target ⇒ `ja-roteado`, nothing written, whatever the
 *     escolha — an escolha re-points only a pedido still on its Loja Integrada doc; neither a
 *     target nor that doc ⇒ `sem-rota-li`;
 *  3. the Loja Integrada doc guard (active, and the pedido's own conta's);
 *  4. the pedido guard (`pago`, no label bought, a pedido that ships something);
 *  5. the plan over the doc's RAW `mapa`, the target read (and the method row's own target when the
 *     plan needs its tipo, read once when it IS the target), the conclusion — the label policy,
 *     the Melhor Envio service, the endereço.
 *
 * At most four reads, all by id, none cached: every one feeds the write.
 *
 * ## Rule 7: tier 1 — one pedido write per attempt
 *
 * `update({ freteInicial: B }, { lastUpdateTime: S.updateTime })` against the attempt's OWN pedido
 * read `S`. Every guard (`estado === pago`, no `printLabelId`, `modalidade !== '9'`, the Loja
 * Integrada doc active and the conta's, the endereço unless the target is a pickup) and every
 * written value is re-derived from that read and the by-id reads after it.
 *
 *  - `B` is `S`'s RAW `freteInicial` with only these keys replaced: `integracaoFreteOuterRef`
 *    (`documents/int_frete/<alvo>`), `externalOptionId` (the Melhor Envio service, else `null`: the
 *    option belongs to its ref), `integracaoTargetOuterRef` for an operator's escolha only, and
 *    `estado: aguardandoRetirada` when the shared retirada rule says so (a checked-out pedido
 *    routed to a pickup). Never re-parsed: a migrated block's unmodelled keys and Timestamps are
 *    written back as read (`rotaEtiqueta.firestore.test.ts` pins it on the emulator). Under the
 *    stamp a whole-block update and a dotted one write the same VALUES, though not always the same
 *    wire types: the SDK re-encodes every safe-integer number as an integer, so an untouched
 *    sibling stored as an integral double (a migrated `30.0`) comes back as the integer `30`, equal
 *    in every comparison and query (Firestore compares numbers numerically); an integer beyond
 *    2^53 is read, and so written back, lossily (a dotted update would leave both untouched).
 *  - Never written: `valorCobrado`, the cost fields, `externalOptionData` (the mapa key),
 *    `externalOptionIntegracao`, `codRastreio`, `ultimaModificacao`, any field outside the block.
 *  - `FAILED_PRECONDITION` (9) or `NOT_FOUND` (5): something wrote the pedido after our read — the
 *    importer, the Melhor Envio buy anchoring a label, another tab, an editor save — or removed it
 *    (the stamp replaces the SDK's own existence check, so a removed pedido fails 9). RE-READ and
 *    RE-DECIDE everything from step 1; the block that lost is never re-applied. A removal answers
 *    `pedido-nao-encontrado` on the next attempt, and an `update` never resurrects a document.
 *  - At most {@link MAX_TENTATIVAS_ROTA_ETIQUETA_LI} attempts, then
 *    {@link LiRotaEtiquetaEmConflitoError} (503 `rotaEmConflito`): persistent contention on one
 *    pedido is something to surface, and the caller may retry.
 *  - No transaction (the multi-document read-and-write API), so no transaction-inventory row, and
 *    no call outside the ERP between the read and the write. The `int_frete` reads are
 *    configuration, outside the precondition: a mapa edit or a target deactivation that lands
 *    meanwhile orders after this route ("route, then edit"), exactly as it does for a pedido
 *    routed at import.
 *
 * ⚠️ This module must never name the Admin SDK's call for that API — not even in a comment
 * (`estrutura.test.ts`; `firestore-transaction-inventory.test.js` would demand a class for a site
 * that does not exist).
 *
 * ## What it never does (D17)
 *
 * It builds no Loja Integrada client, reads no credential, passes no read switch and calls
 * nothing outside the ERP: routing works while the switch stays off. `estrutura.test.ts` walks
 * the route's run-time import closure to keep it that way. Next-free, `db` a parameter, no
 * process environment.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { intFreteCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  ESTADO_FRETE,
  MOTIVO_ROTA_ETIQUETA_LI,
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  avancaParaRetirada,
  classificarDocDoFreteLi,
  concluirRotaEtiquetaLi,
  estadoFreteSchema,
  idIntFreteDaRefLi,
  inteiroPositivoCanonicoLi,
  planejarRotaEtiquetaLi,
  recusaDoDocLiParaRotaLi,
  recusaDoPedidoParaRotaLi,
  toOuterRef,
  type EstadoFrete,
  type MotivoRotaEtiquetaLi,
  type OuterRef,
  type RespostaRotaEtiquetaLi,
} from '@delfrance/schemas';

/** Read-decide-write attempts before giving up. */
export const MAX_TENTATIVAS_ROTA_ETIQUETA_LI = 3;

/**
 * The routing write lost its precondition on every attempt (module header). Not an app error of
 * the conta family (`core/erros.ts`): it is about one pedido, like the mapa registration's own
 * conflict error. The route answers it with 503 `rotaEmConflito` (`core/respond.ts`).
 */
export class LiRotaEtiquetaEmConflitoError extends Error {
  readonly pedidoId: string;
  readonly tentativas: number;

  constructor(pedidoId: string, tentativas: number) {
    super(
      `Não foi possível definir a transportadora do pedido ${pedidoId}: ` +
        `${String(tentativas)} escritas seguidas perderam a precondição.`,
    );
    this.name = 'LiRotaEtiquetaEmConflitoError';
    this.pedidoId = pedidoId;
    this.tentativas = tentativas;
  }
}

export interface RotaEtiquetaDeps {
  readonly db: Firestore;
}

/** How one routing call ended. `tentativas` is the attempt that decided (1-based). */
export type ResultadoRotaEtiquetaLi =
  | { readonly tipo: 'pedido-nao-encontrado'; readonly tentativas: number }
  /** A decision: routed now, already routed, or refused — the wire answer, as is. */
  | {
      readonly tipo: 'resposta';
      readonly resposta: RespostaRotaEtiquetaLi;
      readonly tentativas: number;
    };

type Roteado = Extract<RespostaRotaEtiquetaLi, { readonly tipo: 'roteado' }>;
type AlvoDaRota = Roteado['alvo'];
type CamposDaRota = Roteado['rota'];

/** What one attempt decided before any write. */
type Decisao =
  | { readonly tipo: 'pedido-nao-encontrado' }
  | { readonly tipo: 'responder'; readonly resposta: RespostaRotaEtiquetaLi }
  | {
      readonly tipo: 'escrever';
      /** The pedido's commit stamp as THIS attempt read it — the precondition. */
      readonly versao: Timestamp;
      /** The raw `freteInicial` read, with only the routing keys replaced. */
      readonly bloco: Readonly<Record<string, unknown>>;
      readonly resposta: RespostaRotaEtiquetaLi;
    };

/** A plain object (never null, never an array), or `null`. */
function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

const recusa = (motivo: MotivoRotaEtiquetaLi): Decisao => ({
  tipo: 'responder',
  resposta: { tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado, motivo },
});

/** An `int_frete` doc read RAW by id: its data, or `undefined` when it does not exist. */
async function lerIntFrete(db: Firestore, id: string): Promise<unknown> {
  const snap = await intFreteCollection.docRef(db, {}, id).get();
  return snap.data();
}

/** The target as the answer names it: never the document, which may hold credentials. */
function alvoDaRota(id: string, tipo: AlvoDaRota['tipo'], lido: unknown): AlvoDaRota {
  const nome = comoObjeto(lido)?.nome;
  return { id, tipo, nome: typeof nome === 'string' ? nome : null };
}

/** A stored freight estado when it is one the schema knows, else `null` (the wire's own rule). */
function estadoOuNull(valor: unknown): EstadoFrete | null {
  const lido = estadoFreteSchema.safeParse(valor);
  return lido.success ? lido.data : null;
}

/** `documents/int_frete/<id>`: the canonical ref of an `int_frete` doc id. */
function refIntFrete(id: string): OuterRef {
  return toOuterRef(`int_frete/${id}`);
}

/**
 * A stored option in the wire's type: a string VERBATIM (never canonicalised); a number only when
 * it is a positive safe integer, as its decimal (`inteiroPositivoCanonicoLi`, the reading the
 * planner gives a stored service) — so a service a migrated block holds as `3` reaches the caller
 * as `'3'` instead of being dropped; anything else `null`.
 */
function opcaoDoBloco(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : inteiroPositivoCanonicoLi(valor);
}

/**
 * The routing fields of a block, for the answer — as written (`roteado`) or as found
 * (`ja-roteado`): the freight ref canonical (the caller passes it), the stored option
 * ({@link opcaoDoBloco}), the stored override as the `int_frete` doc it names, read through the
 * planner's own ref reader (`idIntFreteDaRefLi`: canonical, or `null` when it names no `int_frete`
 * doc), and the estado (`null` when the schema does not know it).
 */
function camposDaRota(
  bloco: Readonly<Record<string, unknown>>,
  integracaoFreteOuterRef: OuterRef,
): CamposDaRota {
  const idDoOverride = idIntFreteDaRefLi(bloco.integracaoTargetOuterRef);
  return {
    integracaoFreteOuterRef,
    externalOptionId: opcaoDoBloco(bloco.externalOptionId),
    integracaoTargetOuterRef: idDoOverride === null ? null : refIntFrete(idDoOverride),
    estado: estadoOuNull(bloco.estado),
  };
}

/** One attempt's reads and decision (module header, steps 1-5). Writes nothing. */
async function decidir(db: Firestore, pedidoId: string, escolha: string | null): Promise<Decisao> {
  const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const pedido = snap.exists ? comoObjeto(snap.data()) : null;
  const versao = snap.updateTime;
  if (pedido === null || versao === undefined) return { tipo: 'pedido-nao-encontrado' };

  const frete = comoObjeto(pedido.freteInicial);
  const idDoFrete = frete === null ? null : idIntFreteDaRefLi(frete.integracaoFreteOuterRef);
  if (frete === null || idDoFrete === null) return recusa(MOTIVO_ROTA_ETIQUETA_LI.semRotaLi);
  const docDoFrete = await lerIntFrete(db, idDoFrete);

  const classe = classificarDocDoFreteLi(docDoFrete);
  if (classe.tipo === 'alvo') {
    return {
      tipo: 'responder',
      resposta: {
        tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.jaRoteado,
        alvo: alvoDaRota(idDoFrete, classe.tipoAlvo, docDoFrete),
        rota: camposDaRota(frete, refIntFrete(idDoFrete)),
      },
    };
  }
  if (classe.tipo === 'sem-rota-li') return recusa(MOTIVO_ROTA_ETIQUETA_LI.semRotaLi);

  const doDoc = recusaDoDocLiParaRotaLi(docDoFrete, pedido.integracaoPedidoOuterRef);
  if (doDoc !== null) return recusa(doDoc);
  const doPedido = recusaDoPedidoParaRotaLi(pedido);
  if (doPedido !== null) return recusa(doPedido);

  const plano = planejarRotaEtiquetaLi(frete, comoObjeto(docDoFrete)?.mapa, escolha);
  if (plano.tipo === 'recusa') return recusa(plano.motivo);
  const alvo = await lerIntFrete(db, plano.alvoId);
  const linha =
    plano.lerLinha === null
      ? null
      : plano.lerLinha === plano.alvoId
        ? alvo
        : await lerIntFrete(db, plano.lerLinha);

  const conclusao = concluirRotaEtiquetaLi(plano, alvo, linha);
  if (conclusao.tipo === 'recusa') return recusa(conclusao.motivo);

  const bloco: Readonly<Record<string, unknown>> = {
    ...frete,
    integracaoFreteOuterRef: conclusao.integracaoFreteOuterRef,
    externalOptionId: conclusao.externalOptionId,
    ...(conclusao.targetEscolhido === null
      ? {}
      : { integracaoTargetOuterRef: conclusao.targetEscolhido }),
    ...(avancaParaRetirada(frete.estado, conclusao.tipoAlvo)
      ? { estado: ESTADO_FRETE.aguardandoRetirada }
      : {}),
  };
  return {
    tipo: 'escrever',
    versao,
    bloco,
    resposta: {
      tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado,
      alvo: alvoDaRota(conclusao.alvoId, conclusao.tipoAlvo, alvo),
      rota: camposDaRota(bloco, conclusao.integracaoFreteOuterRef),
    },
  };
}

/**
 * Route one pedido's label (module header): `escolha` is the `int_frete` doc id the operator
 * picked, `null` to route by the stored override or the conta's `mapa`.
 *
 * @throws {LiRotaEtiquetaEmConflitoError} after {@link MAX_TENTATIVAS_ROTA_ETIQUETA_LI} lost
 *   preconditions — nothing of ours landed.
 */
export async function rotearEtiquetaLi(
  deps: RotaEtiquetaDeps,
  pedidoId: string,
  escolha: string | null,
): Promise<ResultadoRotaEtiquetaLi> {
  const ref = pedidoCollection.docRef(deps.db, {}, pedidoId);
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_ROTA_ETIQUETA_LI; tentativa += 1) {
    // Every decision below is derived from THIS attempt's reads.
    const decisao = await decidir(deps.db, pedidoId, escolha);
    if (decisao.tipo === 'pedido-nao-encontrado') {
      return { tipo: 'pedido-nao-encontrado', tentativas: tentativa };
    }
    if (decisao.tipo === 'responder') {
      return { tipo: 'resposta', resposta: decisao.resposta, tentativas: tentativa };
    }
    try {
      await ref.update({ freteInicial: decisao.bloco }, { lastUpdateTime: decisao.versao });
      return { tipo: 'resposta', resposta: decisao.resposta, tentativas: tentativa };
    } catch (err) {
      // Lost the race, or the pedido was removed (9, or 5 — header): loop, re-read, re-decide.
      // Never re-apply this block.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  throw new LiRotaEtiquetaEmConflitoError(pedidoId, MAX_TENTATIVAS_ROTA_ETIQUETA_LI);
}
