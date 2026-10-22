/**
 * The paid re-check of a Loja Integrada pedido (master plan step 15, #1825): the core of
 * `GET /api/marketplace/loja-integrada/pedidos/[pedidoId]/pagamento`.
 *
 * Before an imported order is dispatched — the checkout commit, a Melhor Envio label buy, a
 * reprint, a generic label — the web asks what the order's CURRENT Loja Integrada situação is.
 * The ERP's own `pago` is not enough: a dispute keeps the pedido `pago`, and a refund after an
 * applied stock removal keeps its stored estado. Only the live read, or the ERP's contested mirror,
 * sees those.
 *
 * ## The order — ERP reads first; nothing reaches Loja Integrada before the switch
 *
 *  1. the pedido, read RAW by id; absent ⇒ `pedido-nao-encontrado`;
 *  2. its conta (`contaIdDoPedidoLi` over `integracaoPedidoOuterRef`) and its canonical `numero`
 *     (`inteiroPositivoCanonicoLi`: the import stores it as text, a duplicate as `null`); either
 *     missing ⇒ `aplicavel: false`;
 *  3. the identity: the id must be the import's own digest of that conta and numero
 *     (`idPedidoLi`), else `aplicavel: false` — a duplicate, a devolução or a manual pedido never
 *     wakes Loja Integrada, and a client-supplied pair can never name another store's order;
 *  4. the context loader (`core/contexto.ts`), whose FIRST act is the read switch: off ⇒ no
 *     Firestore read of the conta, no client, no call. Then the conta, its state, its credential,
 *     and the pacer's 2 s wait before the request;
 *  5. ONE `buscarPedidoLi` — the order detail — and two identity checks on what came back: the
 *     body's `numero`, and, when both sides have one, the first shipment's id against the
 *     pedido's `freteInicial.externalId` (both through `inteiroPositivoCanonicoLi`, so `'801'` ≡
 *     `801`). A mismatch is another order (a token of another store), `pedidoDivergente`;
 *  6. the verdict, by the codigo alone (`veredictoDoCodigoLi`), with the codigo's own contested
 *     motivo. NOTHING else from the body leaves this module: it carries the buyer's personal data;
 *  7. when step 4 or 5 cannot produce an answer for a reason that says nothing about the order
 *     (the switch, the conta, the credential, a throttle, a timeout, an outage), the ERP MIRROR:
 *     the `lojaIntegradaPedidoContestado` aviso of this pedido, read by its id (the import's own
 *     key, `chaveDoAvisoDoPedidoLi`). Open ⇒ `contestado` from the ERP; otherwise the coded error.
 *     The live answer, when there is one, always wins: a dispute closed in the painel would
 *     otherwise keep blocking until the next import.
 *
 * ## The errors (root rule 6)
 *
 * {@link falhaDaLeituraLi} narrows each class to its code and answers `null` for anything else,
 * which the caller rethrows (a 500): `LiTimeoutError` BEFORE `LiNetworkError`, its parent; the
 * `LiHttpError` subclasses before `LiHttpError`; never the `LiError` base, so our own
 * misconfiguration (`LiConfigError`) stays loud. A 401/403 parks the conta first
 * (`tratarFalhaDeAutenticacao`, the step-2 park) and is answered as the park found it. The
 * caller's own abort is matched by IDENTITY (`err === sinal.reason`): the package rethrows exactly
 * that object, so any other failure after an abort is still rethrown.
 *
 * | What failed | Answer | Class |
 * | --- | --- | --- |
 * | the switch, the conta, its credential, a park (`core/erros.ts`) | the shared mapper (`respond.ts`) | not verifiable, configuration |
 * | the park losing its precondition | 503 `estacionamentoEmConflito` | not verifiable, transient |
 * | 429 | 503 `limiteDeChamadas` (no retry here) | not verifiable, transient |
 * | the deadline | 504 `tempoEsgotadoLoja` | not verifiable, transient |
 * | the network, a 5xx, a body off the schema | 502 `lojaIndisponivel` | not verifiable, transient |
 * | 404 | 409 `pedidoAusenteNaLoja` (imported orders do not vanish: the credential) | not authorised |
 * | another order in the answer | 502 `pedidoDivergente` | not authorised |
 *
 * Only a "not verifiable" class reads the mirror; a "not authorised" one is already a refusal.
 *
 * ## Rule 7
 *
 * No write of its own. The only write a run can make is the park's (a tier-1 precondition write
 * on the credential, `core/estacionamento.ts`). The answer is a check-then-act across a network
 * call: the dispatch it authorises happens later, in another request, and nothing here can hold
 * the order still meanwhile — the residual is the seconds between this answer and that commit.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write call — not even in
 * a comment (`estrutura.test.ts`). Next-free, `db` a parameter, no process environment: the route
 * passes the environment in (`deps.ambiente`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { avisoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  LiAuthError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
  buscarPedidoLi,
  type PedidoLi,
  type RespostaLi,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI,
  TIPO_AVISO,
  VEREDITO_PAGAMENTO_LI,
  contaIdDoPedidoLi,
  inteiroPositivoCanonicoLi,
  motivoPedidoContestadoLiSchema,
  situacaoLi,
  veredictoDoCodigoLi,
  type CodigoErroLi,
  type MotivoPedidoContestadoLi,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';

import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import {
  LiAppError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiEstacionamentoEmConflitoError,
} from '../core/erros';
import { type TratarFalhaDeps, tratarFalhaDeAutenticacao } from '../core/estacionamento';
import type { EscritorLogLi } from '../core/log';
import type { RitmoLi } from '../core/ritmo';
import type { AmbienteLi } from '../core/valvulas';
import { chaveDoAvisoDoPedidoLi } from './avisosPedidoLi';
import { idPedidoLi } from './orderIdsLi';

/** The flow every line of this check carries (`jsonPayload.fluxo`). */
export const FLUXO_CONFERENCIA_PAGAMENTO_LI = 'conferencia-pagamento';

export interface ConferenciaPagamentoDeps extends TratarFalhaDeps {
  readonly db: Firestore;
  /** The process environment, from the route — read by the context loader for the switch only. */
  readonly ambiente: AmbienteLi;
  /** The pacer (`core/ritmo.ts`): the wait before the request. */
  readonly ritmo: RitmoLi;
  /** The caller's cancellation (the request's own signal). */
  readonly sinal?: AbortSignal;
  /** Test seam, forwarded to the context's client. Production passes nothing. */
  readonly fetch?: typeof globalThis.fetch;
  /** Test sink for the call and switch lines; production writes them to stdout. */
  readonly escrever?: EscritorLogLi;
}

/** How a failure weighs on the gates: it picks whether the mirror is read. */
export type ClasseFalhaConferenciaLi =
  /** The check could not run, and retrying will not change that: the conta, its credential. */
  | 'configuracao'
  /** The check could not run this time: a throttle, a timeout, an outage, contention. */
  | 'transitorio'
  /** The check ran and points at a problem with THIS order: a refusal, never a retry. */
  | 'nao-autorizado';

/** Why there is no verdict. */
export type FalhaConferenciaLi =
  /** An app error (`core/erros.ts`), answered by the shared mapper (`respond.ts`). */
  | {
      readonly tipo: 'conta';
      readonly classe: ClasseFalhaConferenciaLi;
      readonly erro: LiAppError;
    }
  /** A failure of Loja Integrada's read, answered with this route's own code. */
  | {
      readonly tipo: 'loja';
      readonly classe: ClasseFalhaConferenciaLi;
      readonly status: number;
      readonly code: CodigoErroLi;
      /** A fixed pt-BR sentence: never a path, a numero, an id or a body. */
      readonly mensagem: string;
    };

/** How one check ended. */
export type ResultadoConferenciaPagamentoLi =
  /** No pedido with this id (404). */
  | { readonly tipo: 'pedido-nao-encontrado' }
  /** The 200 answer — not applicable, the live verdict, or the mirror's `contestado`. */
  | {
      readonly tipo: 'resposta';
      readonly resposta: RespostaConferenciaPagamentoLi;
      /** The pedido's conta, or `null` when the check does not apply. */
      readonly contaId: string | null;
      /** When the mirror answered: what kept the live read from running (for the log line). */
      readonly naoVerificavel: FalhaConferenciaLi | null;
    }
  /** No answer: the error envelope. `espelhoLido`: the mirror was read and holds nothing open. */
  | {
      readonly tipo: 'falha';
      readonly contaId: string;
      readonly falha: FalhaConferenciaLi;
      readonly espelhoLido: boolean;
    }
  /** The caller went away during the read (499). */
  | { readonly tipo: 'cancelado'; readonly contaId: string };

/** A plain object (never null, never an array), or `null`. */
function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

function loja(
  classe: ClasseFalhaConferenciaLi,
  status: number,
  code: CodigoErroLi,
  mensagem: string,
): FalhaConferenciaLi {
  return { tipo: 'loja', classe, status, code, mensagem };
}

const DIVERGENTE = loja(
  'nao-autorizado',
  502,
  CODIGO_ERRO_LI.pedidoDivergente,
  'A Loja Integrada devolveu outro pedido. Confira a credencial da conta.',
);

/**
 * A failure of the context or of the read, as this route answers it — or `null` for anything it
 * does not own, which the caller rethrows (module header, "The errors"). Pure: the 401/403 park
 * and the caller's abort are the caller's, decided before this runs (a `LiAuthError` reaching here
 * answers `null`).
 */
export function falhaDaLeituraLi(err: unknown): FalhaConferenciaLi | null {
  if (err instanceof LiAppError) {
    const classe = err instanceof LiEstacionamentoEmConflitoError ? 'transitorio' : 'configuracao';
    return { tipo: 'conta', classe, erro: err };
  }
  // The `LiHttpError` subclasses BEFORE `LiHttpError` itself.
  if (err instanceof LiAuthError) return null;
  if (err instanceof LiNotFoundError) {
    return loja(
      'nao-autorizado',
      409,
      CODIGO_ERRO_LI.pedidoAusenteNaLoja,
      'A Loja Integrada não encontrou este pedido. Confira a credencial da conta.',
    );
  }
  if (err instanceof LiThrottleError) {
    return loja(
      'transitorio',
      503,
      CODIGO_ERRO_LI.limiteDeChamadas,
      'A Loja Integrada limitou as chamadas desta conta. Tente de novo em instantes.',
    );
  }
  if (err instanceof LiHttpError) {
    // A 5xx (Loja Integrada's 52x included) is an outage; any other status is a refusal of OUR
    // request, which must stay loud.
    return err.transitorio
      ? loja(
          'transitorio',
          502,
          CODIGO_ERRO_LI.lojaIndisponivel,
          'A Loja Integrada está indisponível. Tente de novo em instantes.',
        )
      : null;
  }
  // The deadline BEFORE the network: a `LiTimeoutError` is a `LiNetworkError` too.
  if (err instanceof LiTimeoutError) {
    return loja(
      'transitorio',
      504,
      CODIGO_ERRO_LI.tempoEsgotadoLoja,
      'A Loja Integrada não respondeu a tempo. Tente de novo em instantes.',
    );
  }
  if (err instanceof LiNetworkError) {
    return loja(
      'transitorio',
      502,
      CODIGO_ERRO_LI.lojaIndisponivel,
      'Não foi possível falar com a Loja Integrada. Tente de novo em instantes.',
    );
  }
  if (err instanceof LiSchemaError) {
    return loja(
      'transitorio',
      502,
      CODIGO_ERRO_LI.lojaIndisponivel,
      'A Loja Integrada respondeu fora do formato esperado. Tente de novo em instantes.',
    );
  }
  return null;
}

/**
 * A 401/403: park the conta (or find it parked), then answer as the park found it — the conta's
 * own app errors, so the shared mapper answers them. `null` = rethrow the original error.
 *
 * - parked now, or already ⇒ `LiContaParadaError` (409 `reconexaoPendente`);
 * - the refused token is no longer the stored one (saved meanwhile) ⇒ `LiCredencialAlteradaError`
 *   (409 `credencialAlterada`: a retry runs with the new one), and nothing is parked;
 * - no credential any more ⇒ `LiCredencialAusenteError`;
 * - a corrupt credential, or the park's own contention, ⇒ that app error;
 * - an error carrying no usable ref (unreachable: the package builds it from a request) ⇒ `null`.
 */
async function falhaDaRecusaDeCredencial(
  deps: ConferenciaPagamentoDeps,
  err: LiAuthError,
  contexto: ContextoLojaIntegrada,
): Promise<FalhaConferenciaLi | null> {
  const { integracaoId, conta } = contexto;
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await tratarFalhaDeAutenticacao(
      deps.db,
      { integracaoId, lojaNome: conta.nome === '' ? integracaoId : conta.nome },
      err,
      deps,
    );
  } catch (falha) {
    if (falha instanceof LiAppError) return falhaDaLeituraLi(falha);
    throw falha;
  }
  const r = tratamento.estacionamento;
  if (r === null) return null;
  switch (r.tipo) {
    case 'estacionado':
    case 'ja-estacionado':
      return falhaDaLeituraLi(new LiContaParadaError(integracaoId, r.status, r.desdeMs));
    case 'credencial-substituida':
      return falhaDaLeituraLi(new LiCredencialAlteradaError(integracaoId));
    case 'sem-credencial':
      return falhaDaLeituraLi(new LiCredencialAusenteError(integracaoId));
  }
}

/**
 * The mirror (module header, step 7): this pedido's contested aviso, read by its id. Its motivo is
 * read tolerantly — one this build does not know is `null`, never a refusal. `null` when there is
 * no open row.
 */
async function lerEspelhoContestadoLi(
  db: Firestore,
  contaId: string,
  pedidoId: string,
): Promise<{ readonly motivo: MotivoPedidoContestadoLi | null } | null> {
  const chave = chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoContestado, contaId, pedidoId);
  const snap = await avisoCollection.docRef(db, {}, chave).get();
  const aviso = snap.exists ? comoObjeto(snap.data()) : null;
  if (aviso === null || aviso.resolvidoEm != null) return null;
  const motivo = motivoPedidoContestadoLiSchema.safeParse(aviso.motivo);
  return { motivo: motivo.success ? motivo.data : null };
}

/** A failure that keeps the live read from answering: the mirror, when the class allows it. */
async function comEspelho(
  deps: ConferenciaPagamentoDeps,
  contaId: string,
  pedidoId: string,
  falha: FalhaConferenciaLi,
): Promise<ResultadoConferenciaPagamentoLi> {
  if (falha.classe === 'nao-autorizado') {
    return { tipo: 'falha', contaId, falha, espelhoLido: false };
  }
  const espelho = await lerEspelhoContestadoLi(deps.db, contaId, pedidoId);
  if (espelho === null) return { tipo: 'falha', contaId, falha, espelhoLido: true };
  return {
    tipo: 'resposta',
    resposta: {
      aplicavel: true,
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
      veredito: VEREDITO_PAGAMENTO_LI.contestado,
      codigo: null,
      motivoContestacao: espelho.motivo,
      conferidoEmMs: null,
      correlationId: null,
    },
    contaId,
    naoVerificavel: falha,
  };
}

/** The answer is about THIS order (module header, step 5): `null` when it is, else the refusal. */
function divergencia(
  corpo: PedidoLi,
  numero: string,
  freteInicial: unknown,
): FalhaConferenciaLi | null {
  if (inteiroPositivoCanonicoLi(corpo.numero) !== numero) return DIVERGENTE;
  const envioNaLoja = inteiroPositivoCanonicoLi(corpo.envios[0]?.id);
  const envioNoErp = inteiroPositivoCanonicoLi(comoObjeto(freteInicial)?.externalId);
  if (envioNaLoja !== null && envioNoErp !== null && envioNaLoja !== envioNoErp) return DIVERGENTE;
  return null;
}

/**
 * Check one pedido (module header). Everything it cannot answer is rethrown: a Firestore failure,
 * our own misconfiguration, an error after the caller's abort that is not that abort.
 */
export async function conferirPagamentoLi(
  deps: ConferenciaPagamentoDeps,
  pedidoId: string,
): Promise<ResultadoConferenciaPagamentoLi> {
  // 1. The pedido, raw by id.
  const snap = await pedidoCollection.docRef(deps.db, {}, pedidoId).get();
  const pedido = snap.exists ? comoObjeto(snap.data()) : null;
  if (pedido === null) return { tipo: 'pedido-nao-encontrado' };

  // 2-3. The conta, the numero and the identity: ERP data only, before the switch.
  const contaId = contaIdDoPedidoLi(pedido.integracaoPedidoOuterRef);
  const numero = inteiroPositivoCanonicoLi(pedido.numero);
  if (contaId === null || numero === null || idPedidoLi(contaId, Number(numero)) !== pedidoId) {
    return {
      tipo: 'resposta',
      resposta: { aplicavel: false, motivo: MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI.naoImportado },
      contaId: null,
      naoVerificavel: null,
    };
  }

  // 4-5. The context (the switch first), then the one read.
  let contexto: ContextoLojaIntegrada | null = null;
  let lida: RespostaLi<PedidoLi>;
  try {
    contexto = await loadLojaIntegradaContext(deps.db, contaId, {
      ambiente: deps.ambiente,
      ritmo: deps.ritmo,
      registro: {
        fluxo: FLUXO_CONFERENCIA_PAGAMENTO_LI,
        tentativa: null,
        ...(deps.escrever === undefined ? {} : { escrever: deps.escrever }),
      },
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
    lida = await buscarPedidoLi(
      contexto.cliente,
      numero,
      deps.sinal === undefined ? {} : { sinal: deps.sinal },
    );
  } catch (err) {
    // The caller's own abort, by identity — anything else after it is still rethrown.
    if (deps.sinal?.aborted === true && err === deps.sinal.reason) {
      return { tipo: 'cancelado', contaId };
    }
    const falha =
      err instanceof LiAuthError && contexto !== null
        ? await falhaDaRecusaDeCredencial(deps, err, contexto)
        : falhaDaLeituraLi(err);
    if (falha === null) throw err;
    // 7. Not verifiable ⇒ the mirror.
    return comEspelho(deps, contaId, pedidoId, falha);
  }

  // 5. The identity of what came back.
  const divergente = divergencia(lida.dados, numero, pedido.freteInicial);
  if (divergente !== null) return { tipo: 'falha', contaId, falha: divergente, espelhoLido: false };

  // 6. The verdict, by the codigo alone; nothing else from the body.
  const codigo = lida.dados.situacao.codigo;
  const veredito = veredictoDoCodigoLi(codigo);
  return {
    tipo: 'resposta',
    resposta: {
      aplicavel: true,
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
      // A live codigo is never `contestado` (only the mirror says that); were the shared verdict
      // ever to say it, `desconhecido` refuses at the hard gates all the same.
      veredito:
        veredito === VEREDITO_PAGAMENTO_LI.contestado
          ? VEREDITO_PAGAMENTO_LI.desconhecido
          : veredito,
      codigo,
      motivoContestacao: situacaoLi(codigo)?.motivoContestacao ?? null,
      conferidoEmMs: deps.agoraMs(),
      correlationId: lida.correlationId,
    },
    contaId,
    naoVerificavel: null,
  };
}
