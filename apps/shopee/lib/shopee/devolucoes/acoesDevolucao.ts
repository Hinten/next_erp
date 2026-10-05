/**
 * Reading and ANSWERING one Shopee return — the domain half of the two
 * `reclamacao/{estado,acao}` routes (#1525, step 17). The ML twin is
 * `apps/mercado-livre/lib/marketplace/claims/claimResolve.ts`.
 *
 * ⚠️ **`deps` deliberately has no `db` and no scheduler, and that absence IS the
 * enforcement** (rule 7, tier 0). The importer (`importarDevolucao.ts`) is the
 * SINGLE writer of the incidente: it re-reads `get_return_detail` and decides
 * under its own watermarked transaction. A state written here would either be
 * clobbered by the next code 29 or win a race and permanently disagree with
 * Shopee — so after a successful action the ROUTE enqueues a synthetic code 29
 * (`origem: 'acao-vendedor'`) and the importer reflects it. A module holding no
 * Firestore handle cannot become a second writer by accident;
 * `acoesDevolucao.test.ts` pins both the deps type and the imports.
 *
 * ⚠️ **Every action re-reads the return LIVE, immediately before the write**,
 * and runs THE gate (`estadoDevolucao.ts`) on that read — never on what the
 * panel loaded. Availability moves as the buyer and Shopee act, and the panel's
 * "what you saw" echo (`valorExibidoMinor`, `solucaoExibida`) is refused (409)
 * the moment the live value differs: a counter-offer landing between the read
 * and the click is never accepted unseen (rule 7, tier 3 — tell the human).
 *
 * ⚠️ **Shopee's own refusals PROPAGATE.** This module throws exactly one class
 * of its own, {@link DevolucaoAcaoRecusadaError} (our gate). A `ShopeeApiError`
 * from any of the reads or the write reaches the route untouched, which
 * classifies it through `classificarRecusaDevolucaoShopee` (409 with the
 * motivo, else a 502 carrying the code through `codigoSeguro`) — the one
 * exception is the estado's SIDE read, below.
 *
 * ⚠️ **Money crosses ONCE, here** (R-14): the HTTP wire carries integer
 * CENTAVOS (`valorReembolsoMinor`), Shopee's `offer` takes REAIS. Converted by
 * `roundReais(minor / 100)` and ASSERTED back through `centavosDeReais` — a
 * value that does not survive the round trip is refused, never rounded.
 */
import { centavosDeReais, roundReais } from '@delfrance/core/money';
import {
  ShopeeApiError,
  shopeeReturnSolutionSchema,
  type ShopeeClient,
  type ShopeeReturnAvailableSolutions,
  type ShopeeReturnSolution,
  type ShopeeReturnWriteResponse,
} from '@delfrance/integrations-shopee';
import { ehReturnSnShopee } from '@delfrance/schemas';

import { codigoSeguro } from '../nfe/redacaoNfe';
import {
  ACAO_DEVOLUCAO_SHOPEE,
  acaoDevolucaoShopeeSchema,
  acoesDisponiveisDe,
  avaliarAcoesDevolucao,
  projetarEstadoDevolucao,
  recusaDaAcaoPedida,
  recusaGeralDaDevolucao,
  recusaPreviaDaAcao,
  type AcaoDevolucaoShopee,
  type EstadoDevolucaoShopee,
} from './estadoDevolucao';
import {
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
  classificarRecusaDevolucaoShopee,
  type MotivoRecusaDevolucao,
} from './recusaDevolucao';

/** The five Shopee operations this module may call — and nothing else. */
export interface DevolucaoResolveDeps {
  readonly client: Pick<
    ShopeeClient,
    | 'getReturnDetail'
    | 'getReturnAvailableSolutions'
    | 'confirmReturn'
    | 'offerReturn'
    | 'acceptReturnOffer'
  >;
}

/**
 * OUR gate refused the action — the route's 409 `SHOPEE_RECLAMACAO_ACAO_RECUSADA`.
 * `message` is `FRASE_RECUSA_DEVOLUCAO[motivo]`, the sentence the panel shows
 * verbatim; `acoesDisponiveis` is the gate's list on the SAME live read.
 *
 * ⚠️ For `confirmar` / `aceitar-oferta` the solutions are not read (only
 * `ofertar` pays that call), so `ofertar` is never in this list for them — it is
 * a hint, and the panel refetches the estado on every 409 anyway.
 */
export class DevolucaoAcaoRecusadaError extends Error {
  constructor(
    readonly motivo: MotivoRecusaDevolucao,
    readonly acoesDisponiveis: readonly AcaoDevolucaoShopee[],
  ) {
    super(FRASE_RECUSA_DEVOLUCAO[motivo]);
    this.name = 'DevolucaoAcaoRecusadaError';
  }
}

/* -------------------------------------------------------------------------- */
/*                               the contract                                  */
/* -------------------------------------------------------------------------- */

/**
 * A caller-contract violation. The route validates the body first (400
 * `SHOPEE_RECLAMACAO_BODY_INVALIDO`), so reaching one here is a BUG, and it is a
 * `RangeError` (500), never a 409 the operator would read as Shopee's answer.
 * ⚠️ The message names the FIELD only — never a value (a return_sn identifies a
 * buyer's return).
 */
function violacao(campo: string, regra: string): RangeError {
  return new RangeError(`acoesDevolucao: ${campo} ${regra}`);
}

function exigirTexto(campo: string, valor: unknown): void {
  if (typeof valor !== 'string' || valor.trim() === '')
    throw violacao(campo, 'precisa ser um texto');
}

function exigirReturnSn(valor: unknown): void {
  if (!ehReturnSnShopee(valor)) throw violacao('returnSn', 'não tem o formato de um return_sn');
}

/** An echo: a safe integer `>= 0` (centavos), or `null` (nothing was shown). */
function exigirEcoDeValor(valor: unknown): void {
  if (valor === null) return;
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 0) {
    throw violacao('valorExibidoMinor', 'precisa ser centavos inteiros >= 0 ou null');
  }
}

function exigirAusente(campo: string, valor: unknown, acao: AcaoDevolucaoShopee): void {
  if (valor !== undefined) throw violacao(campo, `não vai com a ação ${acao}`);
}

/* -------------------------------------------------------------------------- */
/*                                  reading                                    */
/* -------------------------------------------------------------------------- */

/**
 * The refusals of the SIDE read (`get_available_solutions`) that degrade the
 * estado to "no offerable solution" instead of failing the panel — each one
 * says "no offer is possible on this return now". The page names the first
 * ("Type of return does not allow seller to offer refund", reconcile §2.8); the
 * others are the same pages' state refusals, and losing the whole panel over a
 * side read would hide the status, the deadlines and the other two actions (the
 * ML `expected-resolutions` lesson).
 *
 * ⚠️ Everything else PROPAGATES: an unclassified code, a rate limit, a dead
 * grant, a network failure — and `devolucao-inexistente` / `parametro-invalido`,
 * which after a successful detail read say something is wrong with the
 * REQUEST, not with the return.
 */
const RECUSAS_QUE_ESVAZIAM_AS_SOLUCOES: ReadonlySet<MotivoRecusaDevolucao> =
  new Set<MotivoRecusaDevolucao>([
    MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite,
    MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee,
    MOTIVO_RECUSA_DEVOLUCAO.evidenciaInicialPendente,
    MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite,
    MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa,
  ]);

/**
 * The live estado of one return — at most TWO Shopee reads, ZERO writes.
 *
 * `get_return_detail`, then `get_available_solutions` ONLY when the status
 * leaves the actions to the per-action rules ({@link recusaGeralDaDevolucao} is
 * `null`): a terminal, disputed or unknown status opens no action, so its
 * solutions could change nothing on the panel and the call is not paid.
 *
 * Logs ONE line — ids, the status token, each SUCCESS envelope's raw `error`
 * value (`erroEnvelope`, register 231's instrument — the transport admits only
 * `''`/`' '`/`'-'` there) and a degraded side read's code through
 * `codigoSeguro` (`nfe/redacaoNfe.ts`), never raw and never a Shopee sentence.
 */
export async function lerEstadoDevolucaoShopee(
  deps: DevolucaoResolveDeps,
  p: { integracaoId: string; returnSn: string },
): Promise<EstadoDevolucaoShopee> {
  exigirTexto('integracaoId', p.integracaoId);
  exigirReturnSn(p.returnSn);

  const envelope = await deps.client.getReturnDetail({ returnSn: p.returnSn });
  const detalhe = envelope.response;

  let solucoes: ShopeeReturnAvailableSolutions | null = null;
  let erroEnvelopeSolucoes: string | null = null;
  let recusaDasSolucoes: { motivo: MotivoRecusaDevolucao; codigo: string | null } | null = null;
  if (recusaGeralDaDevolucao(detalhe) === null) {
    try {
      const envSolucoes = await deps.client.getReturnAvailableSolutions({
        returnSn: p.returnSn,
      });
      solucoes = envSolucoes.response;
      erroEnvelopeSolucoes = envSolucoes.error;
    } catch (err) {
      if (!(err instanceof ShopeeApiError)) throw err;
      const motivo = classificarRecusaDevolucaoShopee(err);
      if (motivo === null || !RECUSAS_QUE_ESVAZIAM_AS_SOLUCOES.has(motivo)) throw err;
      // The code through the app's ONE gate — the classifier forgave padding and
      // a module segment, and the log must not carry what the fold forgave.
      recusaDasSolucoes = { motivo, codigo: codigoSeguro(err.code) };
    }
  }

  const estado = projetarEstadoDevolucao({ integracaoId: p.integracaoId, detalhe, solucoes });
  // eslint-disable-next-line no-console -- expected on every healthy read; a warn nobody can act on is what hides the real ones
  console.info('[shopee/devolucao] estado lido', {
    integracaoId: p.integracaoId,
    returnSn: p.returnSn,
    status: estado.status,
    erroEnvelope: envelope.error,
    erroEnvelopeSolucoes,
    solucoesRecusadas: recusaDasSolucoes,
    acoesDisponiveis: estado.acoesDisponiveis,
  });
  return estado;
}

/* -------------------------------------------------------------------------- */
/*                                  answering                                  */
/* -------------------------------------------------------------------------- */

/**
 * One seller action, as the `reclamacao/acao` route hands it over (its strict
 * body, already validated; re-validated here so a FUTURE caller cannot bypass
 * the guard — the `claimResolve.ts` rule).
 */
export interface PedidoDeAcaoDevolucao {
  readonly integracaoId: string;
  /** The pedido the panel was opened from — cross-checked against the LIVE `order_sn`. */
  readonly pedidoId: string;
  readonly returnSn: string;
  readonly acao: AcaoDevolucaoShopee;
  /** REQUIRED with `ofertar`, forbidden otherwise. */
  readonly solucao?: ShopeeReturnSolution;
  /** `ofertar` only — integer CENTAVOS > 0. Absent ⇒ no amount is proposed (no key on the wire). */
  readonly valorReembolsoMinor?: number;
  /** REQUIRED with `confirmar` and `aceitar-oferta` — centavos `>= 0`, or `null` (none shown). */
  readonly valorExibidoMinor?: number | null;
  /** REQUIRED with `aceitar-oferta` — the buyer's solution the panel showed, or `null`. */
  readonly solucaoExibida?: ShopeeReturnSolution | null;
}

/** The per-action shape of the request — see {@link PedidoDeAcaoDevolucao}. */
function validarPedidoDeAcao(p: PedidoDeAcaoDevolucao): void {
  exigirTexto('integracaoId', p.integracaoId);
  exigirTexto('pedidoId', p.pedidoId);
  exigirReturnSn(p.returnSn);
  const acao = acaoDevolucaoShopeeSchema.safeParse(p.acao);
  if (!acao.success) throw violacao('acao', 'não é uma ação de devolução');

  switch (acao.data) {
    case ACAO_DEVOLUCAO_SHOPEE.confirmar:
      if (p.valorExibidoMinor === undefined) throw violacao('valorExibidoMinor', 'é obrigatório');
      exigirEcoDeValor(p.valorExibidoMinor);
      exigirAusente('solucao', p.solucao, acao.data);
      exigirAusente('valorReembolsoMinor', p.valorReembolsoMinor, acao.data);
      exigirAusente('solucaoExibida', p.solucaoExibida, acao.data);
      return;
    case ACAO_DEVOLUCAO_SHOPEE.ofertar: {
      if (!shopeeReturnSolutionSchema.safeParse(p.solucao).success) {
        throw violacao('solucao', 'é obrigatória e precisa ser RETURN_REFUND ou REFUND');
      }
      const valor: unknown = p.valorReembolsoMinor;
      if (
        valor !== undefined &&
        (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0)
      ) {
        throw violacao('valorReembolsoMinor', 'precisa ser centavos inteiros > 0');
      }
      exigirAusente('valorExibidoMinor', p.valorExibidoMinor, acao.data);
      exigirAusente('solucaoExibida', p.solucaoExibida, acao.data);
      return;
    }
    case ACAO_DEVOLUCAO_SHOPEE.aceitarOferta:
      if (p.valorExibidoMinor === undefined) throw violacao('valorExibidoMinor', 'é obrigatório');
      exigirEcoDeValor(p.valorExibidoMinor);
      if (p.solucaoExibida === undefined) throw violacao('solucaoExibida', 'é obrigatória');
      if (
        p.solucaoExibida !== null &&
        !shopeeReturnSolutionSchema.safeParse(p.solucaoExibida).success
      ) {
        throw violacao('solucaoExibida', 'precisa ser RETURN_REFUND, REFUND ou null');
      }
      exigirAusente('solucao', p.solucao, acao.data);
      exigirAusente('valorReembolsoMinor', p.valorReembolsoMinor, acao.data);
      return;
  }
}

/**
 * Integer centavos → the REAIS Shopee's `offer` takes — the ONE conversion
 * (R-14, the `claimResolve.ts` shape) — asserted back through `centavosDeReais`.
 * ⚠️ Never a hand-rolled `Math.round(x * 100)` (`no-ad-hoc-money-rounding`).
 */
function reaisDeCentavos(minor: number): number {
  const reais = roundReais(minor / 100);
  if (centavosDeReais(reais) !== minor) {
    throw violacao('valorReembolsoMinor', 'não sobrevive à volta centavos → reais → centavos');
  }
  return reais;
}

/** What a done action reports — `erroEnvelope` is the WRITE's raw `error` value (register 231). */
export interface ResultadoAcaoDevolucao {
  readonly returnSn: string;
  readonly orderSn: string;
  readonly acao: AcaoDevolucaoShopee;
  readonly erroEnvelope: string;
}

/**
 * Run ONE seller action on a Shopee return.
 *
 * 1. the request's shape (a `RangeError` — a bug, see {@link violacao});
 * 2. `get_return_detail`, LIVE; for `ofertar` also `get_available_solutions`,
 *    but only once the pedido cross-check and the status rows have passed;
 * 3. THE gate (`recusaDaAcaoPedida`) on that read ⇒
 *    {@link DevolucaoAcaoRecusadaError};
 * 4. exactly ONE write — `confirm`, `offer` or `accept_offer` — with the
 *    `return_sn` VERBATIM; `offer` carries `proposed_adjusted_refund_amount`
 *    only when an amount was given.
 *
 * Writes NOTHING to Firestore and enqueues nothing: the route does the
 * post-action refresh. Every Shopee error propagates (see the module header).
 */
export async function executarAcaoDevolucaoShopee(
  deps: DevolucaoResolveDeps,
  p: PedidoDeAcaoDevolucao,
): Promise<ResultadoAcaoDevolucao> {
  validarPedidoDeAcao(p);
  const alvo = { returnSn: p.returnSn };

  const detalhe = (await deps.client.getReturnDetail(alvo)).response;
  let solucoes: ShopeeReturnAvailableSolutions | null = null;
  if (p.acao === ACAO_DEVOLUCAO_SHOPEE.ofertar && recusaPreviaDaAcao(detalhe, p) === null) {
    solucoes = (await deps.client.getReturnAvailableSolutions(alvo)).response;
  }

  const motivo = recusaDaAcaoPedida(detalhe, solucoes, p);
  if (motivo !== null) {
    throw new DevolucaoAcaoRecusadaError(
      motivo,
      acoesDisponiveisDe(avaliarAcoesDevolucao(detalhe, solucoes)),
    );
  }

  let resposta: ShopeeReturnWriteResponse;
  switch (p.acao) {
    case ACAO_DEVOLUCAO_SHOPEE.confirmar:
      resposta = await deps.client.confirmReturn(alvo);
      break;
    case ACAO_DEVOLUCAO_SHOPEE.ofertar: {
      // Both guaranteed by `validarPedidoDeAcao` and the gate above.
      const solucao = p.solucao as ShopeeReturnSolution;
      resposta = await deps.client.offerReturn(
        p.valorReembolsoMinor === undefined
          ? { returnSn: p.returnSn, proposedSolution: solucao }
          : {
              returnSn: p.returnSn,
              proposedSolution: solucao,
              proposedAdjustedRefundAmount: reaisDeCentavos(p.valorReembolsoMinor),
            },
      );
      break;
    }
    case ACAO_DEVOLUCAO_SHOPEE.aceitarOferta:
      resposta = await deps.client.acceptReturnOffer(alvo);
      break;
  }

  return {
    returnSn: p.returnSn,
    orderSn: detalhe.order_sn,
    acao: p.acao,
    erroEnvelope: resposta.error,
  };
}
