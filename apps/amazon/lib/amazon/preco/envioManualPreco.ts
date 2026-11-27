/**
 * The bodies of the four PRICE routes (step 13, PR 13-g): the manual push
 * `POST /api/marketplace/amazon/enviar-precos`, and the conta run's start
 * `POST …/atualizar-precos`, its status `GET …/atualizar-precos/status` and its
 * cancel `POST …/atualizar-precos/cancelar`. Each route file only verifies the
 * caller (`PERM.integracao.write`), binds the deps and answers what this module
 * returns.
 *
 * ## ⚠️ Enqueue-only and valve-blind: zero Amazon calls
 *
 * Every send is a TASK's or a RUN's. The manual push enqueues ONE NAMED price
 * task per SKU onto the jobs queue (`processAmazonListingsJob`, `tipo:
 * 'preco-sku'`, `origem: 'manual'`), carrying identities, the operator's
 * consent (`baixarPreco`) and the request's clock (`solicitadoEmMs`) — never a
 * price: the task computes the faixa when it RUNS, reads Amazon's live offer
 * first and patches only when the two differ. The run routes call the run's
 * claim, status and cancel (`inicioExecucaoPreco.ts`) and map their typed
 * answers to HTTP; they decide nothing those functions decide. So:
 *
 * - the price write valve, its canary list and the preview flag are NEVER
 *   read here: the task and the run read them on the functions surface at run
 *   time, so two surfaces' copies can never disagree about what an answer
 *   means. The only variable read from `ambiente` is the read switch
 *   `AMAZON_CHAMADAS`;
 * - no price is computed, compared or answered: no produto price is read, and
 *   the 200 envelope has no price field (`envioPrecoManualAmazonSchema`);
 * - the link's consistency is the task's verdict: a SKU the push found is
 *   ENQUEUED, and the task refuses it with a line when its link fails a check.
 *
 * The only Firestore writes are the run's: the claim and the cancel, each
 * through the run's ONE write (rule 7 tier 1, `execucaoPrecoFirestore.ts`).
 * The manual push writes nothing.
 *
 * ## The manual push, in order ({@link enviarPrecoManualAmazon})
 *
 * 1. the body, STRICTLY `{ integracaoId, produtoIds, baixarPreco? }` (the conta
 *    id grammar; a non-empty list of document ids; `baixarPreco` a JSON
 *    boolean, absent ⇒ `false`; any other key refused, never ignored) ⇒ 400
 *    `AMAZON_PRECO_CORPO_INVALIDO` with the field PATHS; the ids DEDUPLICATED
 *    in request order, and more than `MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON`
 *    (50) DISTINCT ones ⇒ 400 `AMAZON_PRECO_SELECAO_EXCEDE_LIMITE`,
 *    `detalhes.unidade: 'produtos'`;
 * 2. the read switch not exactly `on` ⇒ 503 `AMAZON_CHAMADAS_DESLIGADAS` (one
 *    blocked-call line), NOTHING read;
 * 3. with the queue valve open, the jobs queue's REGION, resolved and
 *    validated exactly as the producer will (`caminhoDaFilaLotesAmazon`):
 *    missing or malformed ⇒ ONE ERROR line naming `AMAZON_TASKS_REGION`, then
 *    the error PROPAGATES (500), NOTHING read;
 * 4. the conta, RAW and uncached (one masked by-id read): absent, not an
 *    Amazon conta, or inactive ⇒ 404 `AMAZON_PRECO_CONTA_NAO_ENCONTRADA`; its
 *    normal tabela through the ONE parse (`tabelasDePrecoDaContaAmazon`) names
 *    none ⇒ 400 `AMAZON_PRECO_CONTA_SEM_TABELA_NORMAL` (the task would refuse
 *    every SKU);
 * 5. the shared selection read (`listings/selecaoManual.ts`): each selected
 *    produto's anchor (ONE hop), the anchors' labels, and each anchor's
 *    family's SKUs of the conta in both stored ref forms. A produto with no
 *    document, a child whose parent has none, or a family with no listing of
 *    the conta is answered under its own id in `produtosSemEnvio`;
 * 6. per distinct SKU: outside the price task's own target grammar
 *    (`skuAlvoAmazon`) ⇒ `pulado`; no listings path (`skuTemCaminhoAmazon`) ⇒
 *    `pulado` (only a feed carries it); else SENDABLE;
 * 7. THE SWITCH: more than `LIMIAR_FEED_PRECO_AMAZON` (30) SENDABLE SKUs ⇒ 400
 *    `AMAZON_PRECO_SELECAO_EXCEDE_LIMITE`, `detalhes: { limite: 30, unidade:
 *    'anuncios', encontrados }`, NOTHING enqueued: all or nothing, because a
 *    partial send would look complete. Such a family is reached by the conta
 *    run, which is diff-based;
 * 8. per sendable SKU its task, then ONE batch (`enfileirarLote`, at most 16 in
 *    flight), the route's budget ({@link ORCAMENTO_ENVIO_MANUAL_PRECO_MS}, 40 s
 *    from the request's start) asked before STARTING each enqueue: the ones
 *    never started are `nao-tentado`, the batch's TAIL. The queue valve closed
 *    ⇒ every such row `nao-tentado`, the producer never built. ⚠️ The budget
 *    does not bound the ANSWER: the enqueues already started are awaited, and
 *    the SDK's own retries have no deadline;
 * 9. 200 with the envelope (`envioPrecoManualAmazonSchema`), built by name;
 * 10. ONE `evento: 'preco'` line (`rota: 'enviar-precos'`, the reference and
 *    the counts, never a SKU).
 *
 * Why the ladder is shaped so: the conta's gate is its normal tabela (the task
 * prices from it); a SKU outside the task's target grammar is `pulado`, so a
 * row never says `enviado` for a SKU that no valve setting lets its task write;
 * the switch counts SENDABLE SKUs (a `pulado` one is never a task, so it never
 * holds the queue); and each task carries the consent and the request's clock.
 *
 * ## An enqueue that fails (the manual push)
 *
 * Only the queue valve (`AmazonLotesTarefasDesligadasError`) is ANSWERED, as
 * `nao-tentado` rows. Everything else PROPAGATES (rule 6) and the platform
 * answers 500 — after ONE ERROR line (`resultado: 'falhou'`, `motivo:
 * 'enfileiramento/<class>'`) for each failure the route names: a Cloud Tasks
 * transient (`AmazonTarefasTransitoriasError`) and a region error
 * (`MissingRegionError`, `AmazonLotesRegiaoDaFilaInvalidaError`) rethrown AS
 * THEY ARE; a RAW SDK failure rethrown as
 * {@link AmazonPrecoEnfileiramentoFalhouError} (class, code and HTTP status,
 * nothing of the answered body). Anything else is rethrown untouched, with no
 * line. Part of a batch may have been enqueued before the failure, so no answer
 * can honestly say what was; a re-send mints a new reference, so it is safe.
 *
 * ## The run routes
 *
 * - **Start** ({@link iniciarAtualizacaoPrecosAmazon}): the strict body
 *   `{ integracaoId, baixarPreco?, confirmarReducaoEmMassa? }` (both JSON
 *   booleans, absent ⇒ `false`), then steps 2–4, then the claim with the
 *   caller's uid as `solicitadaPor`. The claim checks the queue valve FIRST
 *   (closed ⇒ 503 `AMAZON_PRECO_ENFILEIRAMENTO_FALHOU`, `motivo:
 *   'fila-desligada'`, nothing claimed), and answers 202 `{ execucaoId,
 *   retomada }`, 409 `AMAZON_PRECO_EXECUCAO_EM_CURSO` with the live run's id,
 *   or 503 `AMAZON_PRECO_ENFILEIRAMENTO_FALHOU` with what it knows (`motivo`).
 *   ⚠️ A re-kick (`retomada: true`) CONTINUES the stalled run under its STORED
 *   `baixarPreco`, `confirmarReducaoEmMassa` and `solicitadaPor`: the
 *   request's flags and caller are not applied (the status shows both flags).
 *   To change them, cancel the run, then start: that claims a new one.
 * - **Status** ({@link resumoAtualizacaoPrecosAmazon}): the query STRICTLY
 *   `?integracaoId=` (once; any other parameter refused), then steps 2 and 4
 *   without the tabela rule, then the summary: 200, or 404
 *   `AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA` with no run.
 * - **Cancel** ({@link cancelarAtualizacaoPrecosAmazon}): the strict body
 *   `{ integracaoId }`, then steps 2 and 4 without the tabela rule, then the
 *   cancel: 200 `{ execucaoId, fase }` (cancelled, or an ended run with nothing
 *   in flight answered unchanged), or 404 with no run.
 *
 * The status and the cancel skip the tabela rule on purpose: they send
 * nothing, and the view of a run and its stop must never be refused for a
 * configuration the run's own pages already close on. Neither needs the queue's
 * region: neither enqueues. What the run's functions throw (a stored run or
 * lease that no longer parses, every attempt of a write losing its
 * precondition, a Firestore failure) PROPAGATES: a 500, never a coded answer.
 *
 * ## Logs
 *
 * ONE line per answer the routes decide here, through the app's one logger:
 * the switch refusal is the shared `chamada-bloqueada` line; every other
 * refusal, and the manual push's answer, is one `evento: 'preco'` line (`rota`,
 * `resultado` — the code, `enfileirado`, `nada-enfileirado` or `falhou` —,
 * `motivo`, the counts). The claim and the cancel write their own line; the
 * status writes none (a read that changes nothing). Never a SKU, a produto id
 * or a body value.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { skuTemCaminhoAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_PRECO_AMAZON,
  CONTA_ID_AMAZON_REGEX,
  type CodigoErroPrecoAmazon,
  type EnvioPrecoManualAmazon,
  type ErroPrecoAmazon,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  LIMIAR_FEED_PRECO_AMAZON,
  MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON,
  type RespostaCancelamentoExecucaoPrecoAmazon,
  type RespostaInicioExecucaoPrecoAmazon,
  type ResultadoEnvioEstoqueManualAmazon,
  type ResumoExecucaoPrecoAmazon,
  UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON,
  type UnidadeLimiteEnvioEstoqueManualAmazon,
  type integracaoSchema,
  naoDocId,
  tabelasDePrecoDaContaAmazon,
} from '@delfrance/schemas';
import { type ZodError, z } from 'zod';

import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import { type LoggerAmazon, type SeveridadeAmazon, registrarEventoAmazon } from '../core/log';
import {
  CHAMADAS_ENV_AMAZON,
  FLUXO_AMAZON,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from '../core/valvulas';
import { type AmbienteAmazon, TASKS_REGION_ENV } from '../env';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
  caminhoDaFilaLotesAmazon,
} from '../feeds/agendadorLotes';
import { VERSAO_TAREFA_LOTE_AMAZON } from '../feeds/tarefaLote';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import { lerSelecaoManualAmazon, skuAlvoAmazon } from '../listings/selecaoManual';
import { lerCorpoLimitado } from '../notificacoes/corpo';
import {
  type DepsExecucaoPrecoAmazon,
  MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON,
  type ProdutorExecucaoPrecoAmazon,
  cancelarExecucaoPrecoAmazon,
  iniciarExecucaoPrecoAmazon,
  resumoExecucaoPrecoAmazon,
} from './inicioExecucaoPreco';
import type { ProdutorPrecoAmazon } from './produtorPreco';
import {
  ORIGEM_TAREFA_PRECO_AMAZON,
  TIPO_TAREFA_PRECO_AMAZON,
  type TarefaPrecoSkuAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

/* -------------------------------------------------------------------------- */
/*                                 The numbers                                */
/* -------------------------------------------------------------------------- */

/** The `rota` of each route's lines (the blocked-call line included). */
export const ROTA_PRECO_AMAZON = {
  envioManual: 'enviar-precos',
  inicio: 'atualizar-precos',
  resumo: 'atualizar-precos/status',
  cancelamento: 'atualizar-precos/cancelar',
} as const;
export type RotaPrecoAmazon = (typeof ROTA_PRECO_AMAZON)[keyof typeof ROTA_PRECO_AMAZON];

/**
 * The largest body read: 64 KiB. A bound on the READ (an authenticated caller
 * can still send anything), far above fifty document ids and a conta id.
 */
export const MAX_CORPO_ROTA_PRECO_BYTES = 64 * 1024;

/**
 * The manual push's budget, from the request's start (module header, step 8):
 * the web gives the call 60 s, so 40 s leaves the answer and a slow network
 * inside it. ⚠️ It bounds when an enqueue STARTS, never when the route answers:
 * the batch awaits every enqueue already started, and the Admin SDK's Cloud
 * Tasks call retries a 503 or a reset connection with no deadline of its own.
 * A caller's timeout therefore means UNKNOWN, and a re-send is safe (a new
 * reference, so new names; each task recomputes).
 */
export const ORCAMENTO_ENVIO_MANUAL_PRECO_MS = 40_000;

/**
 * The conta fields step 4 reads (its by-id read is masked to them): the gate's
 * two, and the normal tabela's ref for the ONE parse. Never the promotional
 * tabela, the depósito or a credential field.
 */
export const CAMPOS_CONTA_ROTA_PRECO_AMAZON = [
  'tipo',
  'ativo',
  'tabelaNormalOuterRef',
] as const satisfies ReadonlyArray<keyof typeof integracaoSchema.shape>;

/** The HTTP status of each price route code: every code of the closed set has exactly one. */
export const STATUS_DO_CODIGO_PRECO_AMAZON = {
  [CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO]: 400,
  [CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE]: 400,
  [CODIGO_ERRO_PRECO_AMAZON.CONTA_NAO_ENCONTRADA]: 404,
  [CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL]: 400,
  [CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO]: 409,
  [CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA]: 404,
  [CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU]: 503,
} as const satisfies Record<CodigoErroPrecoAmazon, 400 | 404 | 409 | 503>;

/** Why a row or a produto was answered the way it was: the sentence it carries. */
export const MOTIVO_ENVIO_MANUAL_PRECO_AMAZON = {
  enfileirado: 'enfileirado',
  foraDoFormato: 'fora-do-formato',
  semCaminho: 'sem-caminho',
  filaDesligada: 'fila-desligada',
  orcamentoEsgotado: 'orcamento-esgotado',
  semVinculo: 'sem-vinculo',
  produtoAusente: 'produto-ausente',
  paiAusente: 'pai-ausente',
} as const;
export type MotivoEnvioManualPrecoAmazon =
  (typeof MOTIVO_ENVIO_MANUAL_PRECO_AMAZON)[keyof typeof MOTIVO_ENVIO_MANUAL_PRECO_AMAZON];

/** The pt-BR sentence of each motivo: the BACKEND owns this wording. */
export const MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON: Readonly<
  Record<MotivoEnvioManualPrecoAmazon, string>
> = {
  enfileirado: 'Na fila: o preço é conferido com a Amazon e enviado em alguns minutos.',
  'fora-do-formato': 'SKU fora do formato aceito pela Amazon.',
  'sem-caminho': 'SKU sem caminho na API da Amazon: só o envio em lote o atualiza.',
  'fila-desligada': 'Fila de envio desligada.',
  'orcamento-esgotado': 'Tempo esgotado: envie de novo.',
  'sem-vinculo': 'Sem anúncio da Amazon vinculado nesta conta.',
  'produto-ausente': 'Produto não encontrado.',
  'pai-ausente': 'Produto pai da variação não encontrado: corrija o cadastro.',
};

/* -------------------------------------------------------------------------- */
/*                                  The deps                                  */
/* -------------------------------------------------------------------------- */

/** What every price route reads before its own work. */
interface DepsRotaPrecoAmazon {
  /**
   * The process environment. ONLY `AMAZON_CHAMADAS` is read from it — never
   * the price valve, its canary list or the preview flag (module header).
   */
  readonly ambiente: AmbienteAmazon;
  /** Resolved LAZILY: a refusal before step 4 never builds the handle. */
  readonly db: () => Firestore;
  readonly logger: LoggerAmazon;
}

/** Everything the manual push needs — injected, so a test drives the ladder with doubles. */
export interface DepsEnvioManualPrecoAmazon extends DepsRotaPrecoAmazon {
  /** The queue valve, as the App Hosting root read it (exactly `'1'` closes it). */
  readonly filaDesligada: boolean;
  /** The jobs queue's region, as the App Hosting root resolves it for its producers. */
  readonly regiao: () => string;
  /** The price task's producer, built only at the enqueue, and never with the valve closed. */
  readonly produtor: () => ProdutorPrecoAmazon;
  /** The route's clock, ms: the budget and every task's `solicitadoEmMs`. */
  readonly agora: () => number;
  /** The request's own id: every task's `referencia` (the feed core's id grammar). */
  readonly gerarReferencia: () => string;
}

/** Everything the run's start needs. */
export interface DepsInicioAtualizacaoPrecosAmazon extends DepsRotaPrecoAmazon {
  /** The queue valve, as the App Hosting root read it: the claim reads it FIRST. */
  readonly filaDesligada: boolean;
  /** The jobs queue's region, as the App Hosting root resolves it for its producers. */
  readonly regiao: () => string;
  /** The run's page producer, built only at an enqueue, never with the valve closed. */
  readonly produtor: () => ProdutorExecucaoPrecoAmazon;
  /** Now, in ms. */
  readonly agora: () => number;
  /** A fresh run id, under the feed core's id grammar. */
  readonly gerarExecucaoId: () => string;
}

/** Everything the status and the cancel need. */
export interface DepsConsultaAtualizacaoPrecosAmazon extends DepsRotaPrecoAmazon {
  /** Now, in ms. */
  readonly agora: () => number;
}

/* -------------------------------------------------------------------------- */
/*                                 The answers                                */
/* -------------------------------------------------------------------------- */

/** An error answer: a status and the envelope. */
export interface RecusaPrecoAmazon {
  readonly status: 400 | 404 | 409 | 503;
  readonly corpo: ErroPrecoAmazon;
}

/** What the manual push answers. */
export type ResultadoEnvioManualPrecoAmazon =
  | { readonly status: 200; readonly corpo: EnvioPrecoManualAmazon }
  | RecusaPrecoAmazon;

/** What the run's start answers. */
export type ResultadoInicioAtualizacaoPrecosAmazon =
  | { readonly status: 202; readonly corpo: RespostaInicioExecucaoPrecoAmazon }
  | RecusaPrecoAmazon;

/** What the status answers. */
export type ResultadoResumoAtualizacaoPrecosAmazon =
  | { readonly status: 200; readonly corpo: ResumoExecucaoPrecoAmazon }
  | RecusaPrecoAmazon;

/** What the cancel answers. */
export type ResultadoCancelamentoAtualizacaoPrecosAmazon =
  | { readonly status: 200; readonly corpo: RespostaCancelamentoExecucaoPrecoAmazon }
  | RecusaPrecoAmazon;

/**
 * A RAW Cloud Tasks SDK failure of the manual push's enqueue, sanitized (module
 * header, "An enqueue that fails"): the SDK class and code and the HTTP status
 * Cloud Tasks answered — never the SDK's message, and no `cause` or
 * `httpResponse`, which a logger of the thrown error would print whole. Still a
 * 500.
 */
export class AmazonPrecoEnfileiramentoFalhouError extends Error {
  /** `<class>/<code>` (`descreverFalhaDoSdkDeTarefasAmazon`). */
  readonly falha: string;
  /** The status Cloud Tasks answered; `null` when no request was answered. */
  readonly httpStatus: number | null;

  constructor(falha: string, httpStatus: number | null) {
    const status = httpStatus === null ? '' : `, HTTP ${String(httpStatus)}`;
    super(`enqueue do preço no Cloud Tasks falhou (${falha}${status}); o resultado é desconhecido`);
    this.name = 'AmazonPrecoEnfileiramentoFalhouError';
    this.falha = falha;
    this.httpStatus = httpStatus;
  }
}

/** The `resultado` of the ERROR line a propagated failure writes (module header). */
const FALHOU = 'falhou';

/** The extras an envelope may carry, each only when set. */
interface ExtrasRecusa {
  readonly issues?: readonly string[];
  readonly detalhes?: {
    readonly limite: number;
    readonly unidade: UnidadeLimiteEnvioEstoqueManualAmazon;
    readonly encontrados: number;
  };
  readonly execucaoId?: string | null;
  readonly motivo?: string;
}

/** A coded refusal: its status from {@link STATUS_DO_CODIGO_PRECO_AMAZON}, the envelope by name. */
function recusa(
  code: CodigoErroPrecoAmazon,
  error: string,
  extras: ExtrasRecusa = {},
): RecusaPrecoAmazon {
  return {
    status: STATUS_DO_CODIGO_PRECO_AMAZON[code],
    corpo: {
      error,
      code,
      ...(extras.issues === undefined ? {} : { issues: [...extras.issues] }),
      ...(extras.detalhes === undefined
        ? {}
        : {
            detalhes: {
              limite: extras.detalhes.limite,
              unidade: extras.detalhes.unidade,
              encontrados: extras.detalhes.encontrados,
            },
          }),
      ...(extras.execucaoId === undefined ? {} : { execucaoId: extras.execucaoId }),
      ...(extras.motivo === undefined ? {} : { motivo: extras.motivo }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The lines                                 */
/* -------------------------------------------------------------------------- */

/** The counts the manual push's line carries (module header, "Logs"). */
interface ContagemEnvioManualPreco {
  readonly produtos: number | null;
  readonly ancoras: number | null;
  readonly anuncios: number | null;
  readonly enviaveis: number | null;
  readonly enfileirados: number;
  readonly jaEnfileirados: number;
  readonly pulados: number;
  readonly naoTentados: number;
  readonly semEnvio: number;
}

const SEM_CONTAGEM: ContagemEnvioManualPreco = {
  produtos: null,
  ancoras: null,
  anuncios: null,
  enviaveis: null,
  enfileirados: 0,
  jaEnfileirados: 0,
  pulados: 0,
  naoTentados: 0,
  semEnvio: 0,
};

/** The ONE `evento: 'preco'` line of an answer (module header, "Logs"). */
function registrar(
  logger: LoggerAmazon,
  rota: RotaPrecoAmazon,
  severidade: SeveridadeAmazon,
  resultado: string,
  campos: {
    readonly motivo?: string;
    readonly contaId?: string;
    readonly referencia?: string;
    readonly baixarPreco?: boolean;
    readonly contagem?: ContagemEnvioManualPreco;
  } = {},
): void {
  const contagem = campos.contagem;
  registrarEventoAmazon(
    logger,
    'preco',
    severidade,
    `[amazon] ${rota} ${resultado}`,
    {
      rota,
      resultado,
      motivo: campos.motivo ?? null,
      ...(campos.referencia === undefined ? {} : { referencia: campos.referencia }),
      ...(campos.baixarPreco === undefined ? {} : { baixarPreco: campos.baixarPreco }),
      ...(contagem === undefined
        ? {}
        : {
            produtos: contagem.produtos,
            ancoras: contagem.ancoras,
            anuncios: contagem.anuncios,
            enviaveis: contagem.enviaveis,
            enfileirados: contagem.enfileirados,
            jaEnfileirados: contagem.jaEnfileirados,
            pulados: contagem.pulados,
            naoTentados: contagem.naoTentados,
            semEnvio: contagem.semEnvio,
          }),
    },
    {
      fluxo: FLUXO_AMAZON.preco,
      ...(campos.contaId === undefined ? {} : { conta: campos.contaId }),
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                          Steps 1–4, shared by all four                     */
/* -------------------------------------------------------------------------- */

/** The issue path of a refusal with no field of its own (no JSON, not an object, too big). */
const CORPO = '(corpo)';

/** The field PATHS a refusal names — an unknown KEY is a path too; never a value. */
function caminhosDosProblemas(err: ZodError): string[] {
  const caminhos = new Set<string>();
  for (const issue of err.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const chave of issue.keys) caminhos.add(chave);
    } else {
      caminhos.add(issue.path.length === 0 ? CORPO : issue.path.map(String).join('.'));
    }
  }
  return [...caminhos].sort();
}

type LeituraEntrada<T> =
  | { readonly ok: true; readonly dados: T }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Step 1: the bounded read, the JSON, the strict shape. */
async function lerCorpoJson<T>(req: Request, schema: z.ZodType<T>): Promise<LeituraEntrada<T>> {
  const lido = await lerCorpoLimitado(
    req.body,
    req.headers.get('content-length'),
    MAX_CORPO_ROTA_PRECO_BYTES,
  );
  if (lido.tipo === 'grande') return { ok: false, issues: [CORPO] };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(lido.dados));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, issues: [CORPO] };
  }
  const corpo = schema.safeParse(json);
  return corpo.success
    ? { ok: true, dados: corpo.data }
    : { ok: false, issues: caminhosDosProblemas(corpo.error) };
}

/** A conta id under its grammar: the one field every price route names its conta by. */
const integracaoIdSchema = z.string().regex(CONTA_ID_AMAZON_REGEX);

/** The manual push's body, STRICTLY (module header, step 1). */
const corpoEnvioManualPrecoSchema = z
  .object({
    integracaoId: integracaoIdSchema,
    produtoIds: z
      .array(z.string().refine((id) => !naoDocId(id), { message: 'não é um id de documento' }))
      .min(1),
    baixarPreco: z.boolean().default(false),
  })
  .strict();

/** The run start's body, STRICTLY (module header, "The run routes"). */
const corpoInicioAtualizacaoPrecosSchema = z
  .object({
    integracaoId: integracaoIdSchema,
    baixarPreco: z.boolean().default(false),
    confirmarReducaoEmMassa: z.boolean().default(false),
  })
  .strict();

/** The cancel's body, and the status's query, STRICTLY. */
const contaApenasSchema = z.object({ integracaoId: integracaoIdSchema }).strict();

/** The status's query as an object: a parameter given twice is a list, which the schema refuses. */
function consultaDaUrl(req: Request): Record<string, unknown> {
  const parametros = new URL(req.url).searchParams;
  const consulta: Record<string, unknown> = {};
  for (const chave of new Set(parametros.keys())) {
    const valores = parametros.getAll(chave);
    consulta[chave] = valores.length === 1 ? valores[0] : valores;
  }
  return consulta;
}

/** Step 1's refusal: 400 with the field paths, nothing read. */
function corpoInvalido(
  logger: LoggerAmazon,
  rota: RotaPrecoAmazon,
  issues: readonly string[],
  frase: string,
): RecusaPrecoAmazon {
  registrar(logger, rota, 'INFO', CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO);
  return recusa(CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO, frase, { issues });
}

/** Step 2: the read switch — `null` when it is on, else the 503 (nothing read). */
function chaveDesligada(
  deps: DepsRotaPrecoAmazon,
  rota: RotaPrecoAmazon,
): RecusaPrecoAmazon | null {
  if (lerChaveDeChamadasAmazon(deps.ambiente)) return null;
  registrarChamadaBloqueadaAmazon(deps.logger, { rota, valor: deps.ambiente[CHAMADAS_ENV_AMAZON] });
  return {
    status: 503,
    corpo: {
      error:
        'As chamadas à Amazon estão desligadas neste backend (até a migração, ou por ' +
        'configuração).',
      code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
    },
  };
}

/**
 * Step 3: the jobs queue's region, exactly as the producer resolves it — a
 * broken deploy surfaces before any read. Only with the valve open (a closed
 * valve never resolves the queue).
 */
function exigirRegiao(
  deps: Pick<DepsEnvioManualPrecoAmazon, 'regiao' | 'filaDesligada' | 'logger'>,
  rota: RotaPrecoAmazon,
  contaId: string,
): void {
  if (deps.filaDesligada) return;
  try {
    caminhoDaFilaLotesAmazon(deps.regiao());
  } catch (err) {
    if (err instanceof MissingRegionError || err instanceof AmazonLotesRegiaoDaFilaInvalidaError) {
      registrar(deps.logger, rota, 'ERROR', FALHOU, {
        motivo: `${TASKS_REGION_ENV}/${err.name}`,
        contaId,
      });
    }
    throw err;
  }
}

/**
 * Step 4: the conta, RAW and uncached, ONE masked by-id read — `null` when it
 * passes, else the refusal. `comTabela` adds the normal tabela's rule (the
 * two routes that send).
 */
async function recusaDaConta(
  db: Firestore,
  logger: LoggerAmazon,
  rota: RotaPrecoAmazon,
  contaId: string,
  comTabela: boolean,
): Promise<RecusaPrecoAmazon | null> {
  const [snap] = await db.getAll(integracaoCollection.docRef(db, {}, contaId), {
    fieldMask: [...CAMPOS_CONTA_ROTA_PRECO_AMAZON],
  });
  const conta = snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.amazon || conta.ativo === false) {
    registrar(logger, rota, 'INFO', CODIGO_ERRO_PRECO_AMAZON.CONTA_NAO_ENCONTRADA, { contaId });
    return recusa(
      CODIGO_ERRO_PRECO_AMAZON.CONTA_NAO_ENCONTRADA,
      'Conta da Amazon não encontrada, ou inativa.',
    );
  }
  if (comTabela && tabelasDePrecoDaContaAmazon(conta).normalId === null) {
    registrar(logger, rota, 'INFO', CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL, { contaId });
    return recusa(
      CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL,
      'A conta da Amazon não tem uma tabela de preço normal válida; configure a tabela ' +
        'normal da conta. Nada foi enfileirado.',
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                               The manual push                              */
/* -------------------------------------------------------------------------- */

/** A limit refusal (steps 1 and 7): nothing was enqueued. */
function excedeLimite(
  deps: DepsEnvioManualPrecoAmazon,
  contaId: string,
  unidade: UnidadeLimiteEnvioEstoqueManualAmazon,
  limite: number,
  encontrados: number,
  contagem: ContagemEnvioManualPreco,
): RecusaPrecoAmazon {
  registrar(
    deps.logger,
    ROTA_PRECO_AMAZON.envioManual,
    'INFO',
    CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
    { motivo: unidade, contaId, contagem },
  );
  const frase =
    unidade === UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.produtos
      ? `Selecione no máximo ${String(limite)} produtos para enviar o preço à Amazon (foram ${String(encontrados)}); nada foi enfileirado.`
      : `Os produtos selecionados têm ${String(encontrados)} anúncios desta conta da Amazon que o envio de preço pode atualizar, e o envio manual aceita no máximo ${String(limite)}: nada foi enfileirado. Selecione menos produtos, ou atualize os preços da conta inteira.`;
  return recusa(CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE, frase, {
    detalhes: { limite, unidade, encontrados },
  });
}

/**
 * What the caller RETHROWS for an enqueue failure other than the queue valve
 * (module header, "An enqueue that fails"), after ONE ERROR line for a failure
 * the route names: the raw SDK failure sanitized, anything else unchanged.
 */
function erroDoEnfileiramento(
  deps: DepsEnvioManualPrecoAmazon,
  err: unknown,
  campos: {
    readonly contaId: string;
    readonly referencia: string;
    readonly baixarPreco: boolean;
    readonly contagem: ContagemEnvioManualPreco;
  },
): unknown {
  const rota = ROTA_PRECO_AMAZON.envioManual;
  if (ehFalhaDoSdkDeTarefasAmazon(err)) {
    const falha = descreverFalhaDoSdkDeTarefasAmazon(err);
    registrar(deps.logger, rota, 'ERROR', FALHOU, { ...campos, motivo: `enfileiramento/${falha}` });
    return new AmazonPrecoEnfileiramentoFalhouError(falha, err.httpResponse?.status ?? null);
  }
  if (
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof MissingRegionError ||
    err instanceof AmazonLotesRegiaoDaFilaInvalidaError
  ) {
    registrar(deps.logger, rota, 'ERROR', FALHOU, {
      ...campos,
      motivo: `enfileiramento/${err.name}`,
    });
  }
  return err;
}

/** One listing's answer, before the envelope is built by name. */
interface DesfechoSku {
  readonly resultado: ResultadoEnvioEstoqueManualAmazon;
  readonly motivo: MotivoEnvioManualPrecoAmazon;
}

/**
 * Push ONE selection's prices: the ladder of the module header, answered as a
 * status and a JSON body. Throws only what it must not answer (module header,
 * "An enqueue that fails").
 */
export async function enviarPrecoManualAmazon(
  req: Request,
  deps: DepsEnvioManualPrecoAmazon,
): Promise<ResultadoEnvioManualPrecoAmazon> {
  const rota = ROTA_PRECO_AMAZON.envioManual;
  const inicioMs = deps.agora();
  const prazoMs = inicioMs + ORCAMENTO_ENVIO_MANUAL_PRECO_MS;

  // ---- 1. the body, strictly — before anything else is read. ----
  const corpo = await lerCorpoJson(req, corpoEnvioManualPrecoSchema);
  if (!corpo.ok) {
    return corpoInvalido(
      deps.logger,
      rota,
      corpo.issues,
      'Corpo inválido: envie apenas { integracaoId, produtoIds, baixarPreco? } — integracaoId ' +
        'é o id da conta da Amazon no ERP; produtoIds, de 1 a ' +
        `${String(MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON)} ids de produto; baixarPreco, ` +
        'true ou false. Nada foi enfileirado.',
    );
  }
  const { integracaoId: contaId, baixarPreco } = corpo.dados;
  const produtoIds = [...new Set(corpo.dados.produtoIds)];
  if (produtoIds.length > MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON) {
    return excedeLimite(
      deps,
      contaId,
      UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.produtos,
      MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON,
      produtoIds.length,
      { ...SEM_CONTAGEM, produtos: produtoIds.length },
    );
  }

  // ---- 2. the read switch — nothing read before it answers. ----
  const desligada = chaveDesligada(deps, rota);
  if (desligada !== null) return desligada;

  // ---- 3. the jobs queue's region — a broken deploy surfaces before any read. ----
  exigirRegiao(deps, rota, contaId);

  // ---- 4. the conta, raw and uncached; its normal tabela through the ONE parse. ----
  const db = deps.db();
  const daConta = await recusaDaConta(db, deps.logger, rota, contaId, true);
  if (daConta !== null) return daConta;

  // ---- 5. the selection's anchors and their families' SKUs. ----
  const selecao = await lerSelecaoManualAmazon(db, contaId, produtoIds);
  const skus = [...new Set([...selecao.skusDaAncora.values()].flat())];
  // Every selected produto leaves in exactly ONE place: its anchor's rows, or
  // its own entry here (no document, a parent with no document, or no listing
  // of the conta in its family).
  const semEnvio = produtoIds.flatMap(
    (id): { readonly produtoId: string; readonly motivo: MotivoEnvioManualPrecoAmazon }[] => {
      const ancora = selecao.ancoraDe.get(id);
      if (ancora === undefined) {
        return [{ produtoId: id, motivo: MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.produtoAusente }];
      }
      if (selecao.ancorasAusentes.has(ancora)) {
        return [{ produtoId: id, motivo: MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.paiAusente }];
      }
      if ((selecao.skusDaAncora.get(ancora) ?? []).length === 0) {
        return [{ produtoId: id, motivo: MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.semVinculo }];
      }
      return [];
    },
  );

  // ---- 6. per SKU: skipped, or sendable. ----
  const desfechos = new Map<string, DesfechoSku>();
  const enviaveis: string[] = [];
  for (const sku of skus) {
    if (!skuAlvoAmazon(FLUXO_LISTING_AMAZON.preco, sku)) {
      desfechos.set(sku, {
        resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.pulado,
        motivo: MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.foraDoFormato,
      });
    } else if (!skuTemCaminhoAmazon(sku)) {
      desfechos.set(sku, {
        resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.pulado,
        motivo: MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.semCaminho,
      });
    } else {
      enviaveis.push(sku);
    }
  }
  const lidos: ContagemEnvioManualPreco = {
    ...SEM_CONTAGEM,
    produtos: produtoIds.length,
    ancoras: selecao.skusDaAncora.size,
    anuncios: skus.length,
    enviaveis: enviaveis.length,
    pulados: skus.length - enviaveis.length,
    semEnvio: semEnvio.length,
  };

  // ---- 7. THE SWITCH, on the sendable SKUs: all or nothing. ----
  if (enviaveis.length > LIMIAR_FEED_PRECO_AMAZON) {
    return excedeLimite(
      deps,
      contaId,
      UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.anuncios,
      LIMIAR_FEED_PRECO_AMAZON,
      enviaveis.length,
      lidos,
    );
  }

  // ---- 8. per sendable SKU its NAMED task; then ONE batch. ----
  const referencia = deps.gerarReferencia();
  if (!ID_LOTE_FEED_AMAZON_REGEX.test(referencia)) {
    throw new RangeError('envioManualPreco.ts: referência gerada fora da gramática');
  }
  // Identities, the consent and the request's clock only: no price, ever (the
  // task computes the faixa when it runs). A refusal here is a bug: the SKU
  // already passed the task's own target grammar.
  const tarefas: TarefaPrecoSkuAmazon[] = enviaveis.map((sku) =>
    tarefaPrecoSkuAmazonSchema.parse({
      v: VERSAO_TAREFA_LOTE_AMAZON,
      tipo: TIPO_TAREFA_PRECO_AMAZON.sku,
      contaId,
      sku,
      origem: ORIGEM_TAREFA_PRECO_AMAZON.manual,
      referencia,
      parte: null,
      baixarPreco,
      solicitadoEmMs: inicioMs,
      codigosAntes: [],
    }),
  );

  let enfileirados = 0;
  let jaEnfileirados = 0;
  let naoTentadas = 0;
  let motivoNaoTentado: MotivoEnvioManualPrecoAmazon =
    MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.orcamentoEsgotado;
  if (tarefas.length > 0 && deps.filaDesligada) {
    naoTentadas = tarefas.length;
    motivoNaoTentado = MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.filaDesligada;
  } else if (tarefas.length > 0) {
    try {
      const lote = await deps
        .produtor()
        .enfileirarLote(tarefas, { continuar: () => deps.agora() < prazoMs });
      enfileirados = lote.enfileiradas;
      jaEnfileirados = lote.jaEnfileiradas;
      naoTentadas = lote.naoTentadas;
    } catch (err) {
      if (!(err instanceof AmazonLotesTarefasDesligadasError)) {
        throw erroDoEnfileiramento(deps, err, {
          contaId,
          referencia,
          baixarPreco,
          contagem: lidos,
        });
      }
      // The valve closed between the root's read and the batch: nothing was enqueued.
      naoTentadas = tarefas.length;
      motivoNaoTentado = MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.filaDesligada;
    }
  }
  // The batch starts in list order: the ones it never started are its TAIL.
  const tentadas = tarefas.length - naoTentadas;
  for (const [i, tarefa] of tarefas.entries()) {
    desfechos.set(
      tarefa.sku,
      i < tentadas
        ? {
            resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.enviado,
            motivo: MOTIVO_ENVIO_MANUAL_PRECO_AMAZON.enfileirado,
          }
        : { resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.naoTentado, motivo: motivoNaoTentado },
    );
  }

  // ---- 9. the envelope, by name: one row per (anchor, SKU), no price. ----
  const listings = [...selecao.skusDaAncora.entries()].flatMap(([ancora, daAncora]) =>
    daAncora.map((sku) => {
      const d = desfechos.get(sku);
      if (d === undefined) throw new TypeError('envioManualPreco.ts: um SKU sem desfecho');
      return {
        produtoId: ancora,
        produtoNome: selecao.nomeDe.get(ancora) ?? null,
        sku,
        resultado: d.resultado,
        mensagem: MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON[d.motivo],
      };
    }),
  );

  // ---- 10. ONE line. ----
  registrar(
    deps.logger,
    rota,
    naoTentadas > 0 ? 'WARNING' : 'INFO',
    enfileirados + jaEnfileirados > 0 ? 'enfileirado' : 'nada-enfileirado',
    {
      ...(naoTentadas > 0 ? { motivo: motivoNaoTentado } : {}),
      contaId,
      referencia,
      baixarPreco,
      contagem: { ...lidos, enfileirados, jaEnfileirados, naoTentados: naoTentadas },
    },
  );
  return {
    status: 200,
    corpo: {
      listings,
      produtosSemEnvio: semEnvio.map((p) => ({
        produtoId: p.produtoId,
        produtoNome: selecao.nomeDe.get(p.produtoId) ?? null,
        mensagem: MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON[p.motivo],
      })),
      pausadoAte: null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                The run routes                              */
/* -------------------------------------------------------------------------- */

/**
 * Start a conta run (module header, "The run routes"): steps 1–4, then the
 * claim, its typed answer mapped to HTTP. `solicitadaPor` is the verified
 * caller's uid.
 */
export async function iniciarAtualizacaoPrecosAmazon(
  req: Request,
  solicitadaPor: string,
  deps: DepsInicioAtualizacaoPrecosAmazon,
): Promise<ResultadoInicioAtualizacaoPrecosAmazon> {
  const rota = ROTA_PRECO_AMAZON.inicio;
  const corpo = await lerCorpoJson(req, corpoInicioAtualizacaoPrecosSchema);
  if (!corpo.ok) {
    return corpoInvalido(
      deps.logger,
      rota,
      corpo.issues,
      'Corpo inválido: envie apenas { integracaoId, baixarPreco?, confirmarReducaoEmMassa? } — ' +
        'integracaoId é o id da conta da Amazon no ERP; os outros dois, true ou false. ' +
        'Nada foi iniciado.',
    );
  }
  const { integracaoId: contaId, baixarPreco, confirmarReducaoEmMassa } = corpo.dados;

  const desligada = chaveDesligada(deps, rota);
  if (desligada !== null) return desligada;
  exigirRegiao(deps, rota, contaId);
  const db = deps.db();
  const daConta = await recusaDaConta(db, deps.logger, rota, contaId, true);
  if (daConta !== null) return daConta;

  const depsExecucao: DepsExecucaoPrecoAmazon = {
    filaDesligada: deps.filaDesligada,
    produtor: deps.produtor,
    agora: deps.agora,
    gerarExecucaoId: deps.gerarExecucaoId,
    logger: deps.logger,
  };
  const r = await iniciarExecucaoPrecoAmazon(
    db,
    contaId,
    { baixarPreco, confirmarReducaoEmMassa, solicitadaPor },
    depsExecucao,
  );
  if (r.ok) return { status: 202, corpo: r.corpo };
  if (r.codigo === CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO) {
    return recusa(
      r.codigo,
      'Uma atualização de preços desta conta já está em andamento; acompanhe-a ou cancele-a ' +
        'antes de iniciar outra.',
      { execucaoId: r.execucaoId },
    );
  }
  return recusa(
    r.codigo,
    r.motivo === MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.filaDesligada
      ? 'A fila de tarefas está desligada neste backend; nenhuma atualização de preços foi ' +
          'iniciada.'
      : 'Não foi possível enfileirar a atualização de preços (não se sabe se a tarefa chegou ' +
          'à fila); acompanhe o status e tente de novo.',
    { execucaoId: r.execucaoId, motivo: r.motivo },
  );
}

/** The status's and the cancel's 404: the conta has no run. */
function semExecucao(): RecusaPrecoAmazon {
  return recusa(
    CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA,
    'Nenhuma atualização de preços encontrada para esta conta.',
  );
}

/**
 * The conta run's summary (module header, "The run routes"): the strict
 * query, steps 2 and 4 without the tabela rule, then the summary.
 */
export async function resumoAtualizacaoPrecosAmazon(
  req: Request,
  deps: DepsConsultaAtualizacaoPrecosAmazon,
): Promise<ResultadoResumoAtualizacaoPrecosAmazon> {
  const rota = ROTA_PRECO_AMAZON.resumo;
  const consulta = contaApenasSchema.safeParse(consultaDaUrl(req));
  if (!consulta.success) {
    return corpoInvalido(
      deps.logger,
      rota,
      caminhosDosProblemas(consulta.error),
      'Consulta inválida: envie apenas ?integracaoId=<id da conta da Amazon no ERP>, uma vez.',
    );
  }
  const contaId = consulta.data.integracaoId;
  const desligada = chaveDesligada(deps, rota);
  if (desligada !== null) return desligada;
  const db = deps.db();
  const daConta = await recusaDaConta(db, deps.logger, rota, contaId, false);
  if (daConta !== null) return daConta;

  const resumo = await resumoExecucaoPrecoAmazon(db, contaId, { agora: deps.agora });
  return resumo === null ? semExecucao() : { status: 200, corpo: resumo };
}

/**
 * Cancel the conta run (module header, "The run routes"): the strict body,
 * steps 2 and 4 without the tabela rule, then the cancel.
 */
export async function cancelarAtualizacaoPrecosAmazon(
  req: Request,
  deps: DepsConsultaAtualizacaoPrecosAmazon,
): Promise<ResultadoCancelamentoAtualizacaoPrecosAmazon> {
  const rota = ROTA_PRECO_AMAZON.cancelamento;
  const corpo = await lerCorpoJson(req, contaApenasSchema);
  if (!corpo.ok) {
    return corpoInvalido(
      deps.logger,
      rota,
      corpo.issues,
      'Corpo inválido: envie apenas { integracaoId } — o id da conta da Amazon no ERP. ' +
        'Nada foi cancelado.',
    );
  }
  const contaId = corpo.dados.integracaoId;
  const desligada = chaveDesligada(deps, rota);
  if (desligada !== null) return desligada;
  const db = deps.db();
  const daConta = await recusaDaConta(db, deps.logger, rota, contaId, false);
  if (daConta !== null) return daConta;

  const r = await cancelarExecucaoPrecoAmazon(db, contaId, {
    agora: deps.agora,
    logger: deps.logger,
  });
  return r.ok ? { status: 200, corpo: r.corpo } : semExecucao();
}
