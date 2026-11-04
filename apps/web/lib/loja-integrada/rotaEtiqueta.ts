import { FirebaseError } from 'firebase/app';
import { getDoc, type Firestore } from 'firebase/firestore';
import {
  CODIGO_ERRO_LI,
  INTEGRACAO_FRETE,
  INTEGRACAO_FRETE_LABELS,
  MOTIVO_ROTA_ETIQUETA_LI,
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  classificarDocDoFreteLi,
  concluirRotaEtiquetaLi,
  idIntFreteDaRefLi,
  planejarRotaEtiquetaLi,
  recusaDoDocLiParaRotaLi,
  recusaDoPedidoParaRotaLi,
  type MotivoRotaEtiquetaLi,
  type Pedido,
  type RespostaRotaEtiquetaLi,
  type TipoAlvoMapaFreteLi,
} from '@delfrance/schemas';

import { intFreteCollection } from '@/lib/data/intFreteCollection';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  type LojaIntegradaClient,
} from './client';

/**
 * The web half of the Loja Integrada label routing (master plan step 15, #1825).
 *
 * A pedido imported from Loja Integrada may still point its freight at its
 * conta's Loja Integrada `int_frete` doc, which prints nothing: the
 * `apps/loja-integrada` backend's `PUT …/pedidos/[pedidoId]/rota-etiqueta` route
 * re-points it at the label target the conta's `mapa` (or the operator's pick)
 * names — server-side, with a guarded write — and answers what it did. Two
 * things live here:
 *
 * - {@link rotearEtiquetaLi} — that call, every answer and failure turned into
 *   the operator's copy, as data (never a throw for an expected failure);
 * - {@link preverRotaEtiquetaLi} — the SAME pure questions the route asks
 *   (`planejarRotaEtiquetaLi` and the guards in `@delfrance/schemas`), over
 *   plain READS, so a screen can say before the stock leaves that a label will
 *   not be possible. It writes nothing and is never the authority: the route
 *   re-derives everything from its own reads when it runs.
 *
 * ⚠️ The browser never calls Loja Integrada, here or anywhere: the route itself
 * makes no call outside the ERP.
 */

/* -------------------------------------------------------------------------- */
/*                                   The copy                                  */
/* -------------------------------------------------------------------------- */

/** The operator copy of every refusal the route can answer — total by type. */
export const MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI: Readonly<Record<MotivoRotaEtiquetaLi, string>> = {
  [MOTIVO_ROTA_ETIQUETA_LI.semMapeamento]:
    'Esta forma de envio não está mapeada para uma transportadora. Mapeie-a na conta Loja ' +
    'Integrada (aba Mapeamento do Frete) ou escolha a transportadora deste pedido.',
  [MOTIVO_ROTA_ETIQUETA_LI.semChave]:
    'O pedido não guarda a forma de envio da Loja Integrada, então o mapeamento não se aplica. ' +
    'Escolha a transportadora deste pedido.',
  [MOTIVO_ROTA_ETIQUETA_LI.mapaInvalido]:
    'O Mapeamento do Frete desta conta está corrompido (não é uma lista). Revise-o na conta ' +
    'Loja Integrada.',
  [MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente]:
    'O frete deste pedido aponta para uma integração Loja Integrada inativa ou de outra conta.',
  [MOTIVO_ROTA_ETIQUETA_LI.semRotaLi]:
    'O frete deste pedido mudou desde que a lista foi carregada. Recarregue a página.',
  [MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago]:
    'Só é possível definir a transportadora de um pedido Pago.',
  [MOTIVO_ROTA_ETIQUETA_LI.semFrete]:
    'Este pedido está sem frete (modalidade 9): não há etiqueta a gerar.',
  [MOTIVO_ROTA_ETIQUETA_LI.alvoAusente]:
    'A transportadora mapeada para esta forma de envio não existe mais. Revise o mapeamento na ' +
    'conta Loja Integrada.',
  [MOTIVO_ROTA_ETIQUETA_LI.alvoInativo]:
    'A transportadora mapeada para esta forma de envio está inativa. Revise o mapeamento na ' +
    'conta Loja Integrada.',
  [MOTIVO_ROTA_ETIQUETA_LI.alvoSemServico]:
    'Para o Melhor Envio é preciso um serviço. Escolha o serviço no mapeamento da conta para ' +
    'esta forma de envio.',
  [MOTIVO_ROTA_ETIQUETA_LI.tipoNaoSuportado]:
    'O mapeamento aponta para uma integração que não emite etiqueta para pedidos da Loja ' +
    'Integrada.',
  [MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido]:
    'A transportadora definida manualmente neste pedido não existe, está inativa ou não é ' +
    'suportada. Escolha outra.',
  [MOTIVO_ROTA_ETIQUETA_LI.semEndereco]:
    'Pedido sem endereço de entrega: só é possível definir uma transportadora de retirada na loja.',
  [MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada]:
    'Este pedido já tem uma etiqueta comprada sem transportadora registrada no ERP. Confira no ' +
    'painel do Melhor Envio antes de comprar outra.',
};

const MOTIVOS: ReadonlySet<string> = new Set<string>(Object.values(MOTIVO_ROTA_ETIQUETA_LI));

/**
 * The copy of a refusal as it arrives on the wire: a plain string, so a motivo
 * a newer backend added reads as a refusal with neutral copy, never as a crash
 * or as `undefined` (the set lookup is prototype-safe: `'toString'` is unknown).
 */
export function mensagemDoMotivoRotaEtiquetaLi(motivo: string): string {
  return MOTIVOS.has(motivo)
    ? MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[motivo as MotivoRotaEtiquetaLi]
    : `A transportadora deste pedido não pôde ser definida (${motivo}). Recarregue a página e ` +
        'tente de novo.';
}

const MENSAGEM_INDISPONIVEL =
  'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.';

/** Pickup and recipient-paid freight print their label at the checkout, never from the row. */
const ETIQUETA_NO_CHECKOUT: ReadonlySet<TipoAlvoMapaFreteLi> = new Set<TipoAlvoMapaFreteLi>([
  INTEGRACAO_FRETE.fob,
  INTEGRACAO_FRETE.retiradaNaLoja,
]);

type Roteado = Extract<RespostaRotaEtiquetaLi, { tipo: 'roteado' | 'ja-roteado' }>;

function mensagemDeSucesso(alvo: Roteado['alvo']): string {
  const base = `Transportadora definida: ${alvo.nome ?? alvo.id} (${INTEGRACAO_FRETE_LABELS[alvo.tipo]}).`;
  return ETIQUETA_NO_CHECKOUT.has(alvo.tipo) ? `${base} A etiqueta é impressa no checkout.` : base;
}

/* -------------------------------------------------------------------------- */
/*                                  The call                                   */
/* -------------------------------------------------------------------------- */

/** Why the call produced no decision. */
export type CausaErroRotaEtiquetaLi =
  /** 401/403: the operator lacks `frete.write` (or the session is gone). */
  | 'sem-permissao'
  /** The route answered 404 `pedidoNaoEncontrado`. */
  | 'nao-encontrado'
  /** 503 `rotaEmConflito`: three lost races in a row; nothing was written. */
  | 'conflito'
  /** The ID token could not be obtained. */
  | 'sessao'
  /** No client, the network, the deadline, an older backend, an unreadable answer. */
  | 'indisponivel';

/** How one routing call ended, with the copy the operator reads. */
export type ResultadoRotaEtiquetaLi =
  | (Roteado & { readonly mensagem: string })
  | { readonly tipo: 'recusado'; readonly motivo: string; readonly mensagem: string }
  | { readonly tipo: 'erro'; readonly causa: CausaErroRotaEtiquetaLi; readonly mensagem: string };

const MENSAGEM_DA_CAUSA: Readonly<Record<CausaErroRotaEtiquetaLi, string>> = {
  'sem-permissao': 'Você não tem permissão para definir a transportadora deste pedido.',
  'nao-encontrado': 'Pedido não encontrado.',
  conflito: 'O pedido foi alterado por outra ação ao mesmo tempo. Tente de novo.',
  sessao: 'Não foi possível confirmar a sua sessão. Recarregue a página e tente de novo.',
  indisponivel: MENSAGEM_INDISPONIVEL,
};

const erro = (causa: CausaErroRotaEtiquetaLi): ResultadoRotaEtiquetaLi => ({
  tipo: 'erro',
  causa,
  mensagem: MENSAGEM_DA_CAUSA[causa],
});

/** The cause a client error stands for, or `null` for one that is not the call's (rethrown). */
function causaDoErro(err: unknown): CausaErroRotaEtiquetaLi | null {
  // `RespostaInvalida` is a subclass of the HTTP error, so it lands below, as
  // "indisponível" — the page and the backend disagree, nothing to retry yet.
  if (err instanceof LojaIntegradaClientHttpError) {
    if (err.status === 401 || err.status === 403) return 'sem-permissao';
    if (err.code === CODIGO_ERRO_LI.pedidoNaoEncontrado) return 'nao-encontrado';
    if (err.code === CODIGO_ERRO_LI.rotaEmConflito) return 'conflito';
    return 'indisponivel';
  }
  // The deadline is a subclass of the network error: both are "não respondeu".
  if (err instanceof LojaIntegradaClientNetworkError) return 'indisponivel';
  if (err instanceof FirebaseError) return 'sessao';
  return null;
}

/**
 * Route one pedido through the backend's `rota-etiqueta` route: `escolha` is the
 * operator's pick (an `int_frete` doc id), `null` lets the stored override or
 * the conta's `mapa` decide.
 *
 * - `roteado` / `ja-roteado` — the pedido now names a label target; `rota` holds
 *   its routing fields, so the caller can repaint it without a read;
 * - `recusado` — a decision: the route refused, with its motivo's copy;
 * - `erro` — no decision: the copy says what to do.
 *
 * Anything that is not one of the client's own errors is rethrown (rule 6).
 */
export async function rotearEtiquetaLi(
  client: LojaIntegradaClient | null,
  pedidoId: string,
  escolha: string | null,
): Promise<ResultadoRotaEtiquetaLi> {
  if (client === null) return erro('indisponivel');
  let resposta: RespostaRotaEtiquetaLi;
  try {
    resposta = await client.rotearEtiqueta(pedidoId, { escolha });
  } catch (err) {
    const causa = causaDoErro(err);
    if (causa === null) throw err;
    return erro(causa);
  }
  if (resposta.tipo === TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado) {
    return {
      tipo: 'recusado',
      motivo: resposta.motivo,
      mensagem: mensagemDoMotivoRotaEtiquetaLi(resposta.motivo),
    };
  }
  return { ...resposta, mensagem: mensagemDeSucesso(resposta.alvo) };
}

/* -------------------------------------------------------------------------- */
/*                             The read-only preview                           */
/* -------------------------------------------------------------------------- */

/** The pedido fields the preview reads — the route's own guard inputs. */
export type PedidoParaRotaLi = Pick<Pedido, 'estado' | 'integracaoPedidoOuterRef'> & {
  readonly freteInicial: unknown;
};

/** What the route WOULD do, if it ran now. */
export type PrevisaoRotaEtiquetaLi =
  /** The pedido already names a label target: nothing to route. */
  | { readonly tipo: 'ja-roteado'; readonly tipoAlvo: TipoAlvoMapaFreteLi }
  /** It would route to this target. */
  | {
      readonly tipo: 'rota';
      readonly alvoId: string;
      readonly tipoAlvo: TipoAlvoMapaFreteLi;
      readonly externalOptionId: string | null;
    }
  /** It would refuse, with this motivo's copy. */
  | { readonly tipo: 'recusa'; readonly motivo: MotivoRotaEtiquetaLi; readonly mensagem: string };

/** Reads an `int_frete` doc by id, RAW — `null`/`undefined` when it does not exist. */
export type LerIntFreteLi = (id: string) => Promise<unknown>;

const recusa = (motivo: MotivoRotaEtiquetaLi): PrevisaoRotaEtiquetaLi => ({
  tipo: 'recusa',
  motivo,
  mensagem: MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[motivo],
});

function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * {@link preverRotaEtiquetaLi} over any reader — the route's order (§4.3 of the
 * step plan), with every decision taken by the shared pure functions:
 *
 *  1. the doc the pedido's ref names (`idIntFreteDaRefLi`, the planner's own
 *     `int_frete` ref reader — a ref naming none is `sem-rota-li` with no
 *     read — then `classificarDocDoFreteLi`): a target ⇒ `ja-roteado`;
 *     neither a target nor the Loja Integrada doc ⇒ `sem-rota-li`;
 *  2. the Loja Integrada doc guard (`recusaDoDocLiParaRotaLi`);
 *  3. the pedido guard (`recusaDoPedidoParaRotaLi`);
 *  4. the plan (`planejarRotaEtiquetaLi`, over the doc's RAW `mapa`), the
 *     target read — and the method row's target when the plan needs its tipo,
 *     read once when it IS the target — then `concluirRotaEtiquetaLi`.
 *
 * At most three reads; none after a refusal.
 */
export async function preverRotaEtiquetaLiCom(
  ler: LerIntFreteLi,
  pedido: PedidoParaRotaLi,
): Promise<PrevisaoRotaEtiquetaLi> {
  const frete = comoObjeto(pedido.freteInicial);
  const idDoFrete = idIntFreteDaRefLi(frete?.integracaoFreteOuterRef);
  if (idDoFrete === null) return recusa(MOTIVO_ROTA_ETIQUETA_LI.semRotaLi);
  const docDoFrete = await ler(idDoFrete);

  const classe = classificarDocDoFreteLi(docDoFrete);
  if (classe.tipo === 'alvo') return { tipo: 'ja-roteado', tipoAlvo: classe.tipoAlvo };
  if (classe.tipo === 'sem-rota-li') return recusa(MOTIVO_ROTA_ETIQUETA_LI.semRotaLi);

  const doDoc = recusaDoDocLiParaRotaLi(docDoFrete, pedido.integracaoPedidoOuterRef);
  if (doDoc !== null) return recusa(doDoc);
  const doPedido = recusaDoPedidoParaRotaLi(pedido);
  if (doPedido !== null) return recusa(doPedido);

  const plano = planejarRotaEtiquetaLi(frete, comoObjeto(docDoFrete)?.mapa, null);
  if (plano.tipo === 'recusa') return recusa(plano.motivo);
  const alvo = await ler(plano.alvoId);
  const linha =
    plano.lerLinha === null
      ? null
      : plano.lerLinha === plano.alvoId
        ? alvo
        : await ler(plano.lerLinha);

  const conclusao = concluirRotaEtiquetaLi(plano, alvo, linha);
  if (conclusao.tipo === 'recusa') return recusa(conclusao.motivo);
  return {
    tipo: 'rota',
    alvoId: conclusao.alvoId,
    tipoAlvo: conclusao.tipoAlvo,
    externalOptionId: conclusao.externalOptionId,
  };
}

/**
 * What the routing route would answer for this pedido right now — read-only,
 * for a pre-save warning (the checkout's "a etiqueta deste pedido não poderá
 * ser gerada"). Every `int_frete` read is RAW and by id through the collection
 * handle, under the `d_frete` read grant `resolverIntFrete` already relies on,
 * so the shared resolver sees exactly what the route sees: a stored `mapa`
 * that is not a list stays one, instead of being parsed into something else.
 */
export function preverRotaEtiquetaLi(
  db: Firestore,
  pedido: PedidoParaRotaLi,
): Promise<PrevisaoRotaEtiquetaLi> {
  return preverRotaEtiquetaLiCom(async (id) => {
    const snap = await getDoc(intFreteCollection.docRef(db, {}, id).withConverter(null));
    return snap.data();
  }, pedido);
}
