/**
 * The body of the MANUAL stock push route `POST /api/marketplace/amazon/enviar-estoque`
 * (step 12, PR 12-g): an operator asks for the current stock of a hand-picked
 * set of produtos to reach their Amazon listings now, instead of waiting for
 * the five-minute tick or the daily reconcile. The route file only verifies the
 * caller (`PERM.integracao.write`), binds the deps and answers what this module
 * returns.
 *
 * ## ⚠️ Enqueue-only and valve-blind: zero Amazon calls, zero Firestore writes
 *
 * The ONE side effect is ONE NAMED patch task per SKU onto the stock queue
 * (`processAmazonStockPatch`), `origem: 'manual'`, its `referencia` the
 * request's own id ({@link DepsEnvioManualEstoqueAmazon.gerarReferencia}),
 * carrying identities only: the task computes the ERP quantity when it RUNS,
 * reads Amazon's live listing first and patches only when the two differ. So
 * every Amazon decision is the TASK's (`processarEstoque.ts`):
 *
 * - the stock valve and its canary list are NEVER read here
 *   (`AMAZON_MODO_ESTOQUE` / `AMAZON_CANARIO_ESTOQUE`): the task is the one
 *   source of truth for a write, read on the functions surface at run time, so
 *   two surfaces' copies can never disagree about what a row means. The only
 *   variable read from `ambiente` is the read switch `AMAZON_CHAMADAS`;
 * - the link's consistency (ambiguity, a link whose produto is gone, a parent
 *   pointer, a unit with variations) is the task's verdict: a SKU the route
 *   found is ENQUEUED, and the task refuses it with a line when its link fails
 *   a check;
 * - the quantity is never computed here: no estoque row is read.
 *
 * A re-send mints a NEW reference, so its tasks are new names: the duplicates
 * are harmless (each recomputes the current value).
 *
 * ## The ladder, in order
 *
 * 1. the body, STRICTLY `{ integracaoId, produtoIds }` (the conta id grammar;
 *    a non-empty list of document ids; any other key refused, never ignored) ⇒
 *    400 `AMAZON_ESTOQUE_CORPO_INVALIDO` with the field PATHS; the ids are
 *    DEDUPLICATED in request order, and more than
 *    `MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON` (50) DISTINCT ones ⇒ 400
 *    `AMAZON_ESTOQUE_SELECAO_EXCEDE_LIMITE`, `detalhes.unidade: 'produtos'`;
 * 2. the read switch not exactly `on` ⇒ 503 `AMAZON_CHAMADAS_DESLIGADAS` (one
 *    blocked-call line), NOTHING read;
 * 3. with the queue valve open, the queue's REGION, resolved and validated
 *    exactly as the producer will (`caminhoDaFilaEstoqueAmazon`): missing or
 *    malformed ⇒ ONE ERROR line naming `AMAZON_TASKS_REGION`, then the error
 *    PROPAGATES (500), NOTHING read;
 * 4. the conta, RAW and uncached (one masked by-id read): absent, not an
 *    Amazon conta, or inactive ⇒ 404 `AMAZON_ESTOQUE_CONTA_NAO_ENCONTRADA`; its
 *    depósito through the ONE parse (`depositoIdDaContaEstoqueAmazon`) names
 *    none ⇒ 400 `AMAZON_ESTOQUE_CONTA_SEM_DEPOSITO`;
 * 5. (rungs 5 and 6 are the shared selection read, `listings/selecaoManual.ts`)
 *    per selected produto, ONE masked read of its `paiId` and `nome`; a
 *    variation child hops ONE level to its anchor (the probe set's parent,
 *    `sondasDoProduto`), and every row names the ANCHOR, with the anchor's
 *    own `nome` (`produtoNome`); an anchor no selected id IS gets ONE more
 *    masked read of its `nome` alone (never a second hop). A produto with no
 *    document is answered under its own id; so is a child whose parent has
 *    no document (no family is read for that parent);
 * 6. per distinct existing anchor, its family: its children (`produtos where
 *    paiId == <anchor> orderBy nome`, keys only, on the declared `produtos
 *    (paiId ASC, nome ASC)` composite), plus every selected produto that
 *    resolved to it, and ONE listing of each member's own `prodAmazon`
 *    partition (the anchor's and each member's: no `where`, projected to the
 *    conta ref and the SKU); the conta's SKUs among them in BOTH stored ref
 *    forms (`skusDaConta`), deduplicated; an anchor with none answers every
 *    produto that resolved to it under `produtosSemEnvio`. Steps 5 and 6 keep
 *    at most {@link LARGURA_LEITURAS_ENVIO_MANUAL_ESTOQUE} reads in flight;
 * 7. THE SWITCH: more than `LIMIAR_FEED_ESTOQUE_AMAZON` (30) DISTINCT SKUs
 *    across the selection ⇒ 400 `AMAZON_ESTOQUE_SELECAO_EXCEDE_LIMITE`,
 *    `detalhes: { limite: 30, unidade: 'anuncios', encontrados }`, NOTHING
 *    enqueued: all or nothing, because a partial send would look complete, and
 *    the route only enqueues per-SKU patches. Such a family still reaches
 *    Amazon through the tick and the daily reconcile;
 * 8. per SKU: no listings path (`skuTemCaminhoAmazon`) ⇒ `pulado`; a SKU no
 *    payload can carry ⇒ `pulado`; else its task. The queue valve closed ⇒
 *    every such row `nao-tentado`, the producer never built; else ONE batch
 *    (`enfileirarLote`, at most 16 in flight), the route's budget
 *    ({@link ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS}, 40 s from the request's start,
 *    inside the web's 60-s deadline) asked before STARTING each enqueue: the
 *    ones never started are `nao-tentado` — the batch starts in list order, so
 *    they are its TAIL. ⚠️ The budget does not bound the ANSWER: the enqueues
 *    already started are awaited, and the SDK's own retries have no deadline
 *    ({@link ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS});
 * 9. 200 with the envelope (`envioEstoqueManualAmazonSchema`), built by name.
 *
 * ## An enqueue that fails
 *
 * Only the queue valve (`AmazonEstoqueTarefasDesligadasError`) is ANSWERED, as
 * `nao-tentado` rows. Everything else PROPAGATES (rule 6) and the platform
 * answers 500 — after ONE ERROR line (`resultado: 'falhou'`, `motivo:
 * 'enfileiramento/<class>'`) for each failure the route names:
 *
 * - a Cloud Tasks transient (`AmazonTarefasTransitoriasError`, already
 *   sanitized by the producer) and a region error (`MissingRegionError`,
 *   `AmazonEstoqueRegiaoDaFilaInvalidaError`) are rethrown AS THEY ARE;
 * - a RAW SDK failure (`FirebaseFunctionsError` / `FirebaseAppError`) is
 *   rethrown as {@link AmazonEstoqueEnfileiramentoFalhouError} — class, code
 *   and HTTP status, no `cause`, no `httpResponse` (the SDK's error carries
 *   the answered body as its OWN properties);
 * - anything else (a Firestore read failure, a bug) is rethrown untouched,
 *   with no line.
 *
 * Deliberately never a coded answer: part of a batch may have been enqueued
 * before the failure, so no answer can honestly say what was. A re-send is safe.
 *
 * ## Logs
 *
 * ONE line per answer, through the app's one logger: the switch refusal is the
 * shared `chamada-bloqueada` line (`rota: 'enviar-estoque'`); every other
 * answer is one `evento: 'estoque'` line (`rota`, `resultado` — the code,
 * `enfileirado`, `nada-enfileirado` or `falhou` —, `motivo`, the reference and
 * the counts) — WARNING when a listing was not tried, ERROR for a propagated
 * failure the route names, INFO otherwise. Never a SKU, a produto id or a body
 * value.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { skuTemCaminhoAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ESTOQUE_AMAZON,
  CONTA_ID_AMAZON_REGEX,
  type EnvioEstoqueManualAmazon,
  type ErroEnvioEstoqueManualAmazon,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON,
  type ResultadoEnvioEstoqueManualAmazon,
  UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON,
  type UnidadeLimiteEnvioEstoqueManualAmazon,
  type integracaoSchema,
  naoDocId,
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
  CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON,
  CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON,
  CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON,
  CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON,
  LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON,
  lerSelecaoManualAmazon,
} from '../listings/selecaoManual';
import { lerCorpoLimitado } from '../notificacoes/corpo';
import { depositoIdDaContaEstoqueAmazon } from './familiaEstoque';
import {
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
  type ProdutorEstoqueAmazon,
  caminhoDaFilaEstoqueAmazon,
} from './produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  VERSAO_TAREFA_ESTOQUE_AMAZON,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';

/** The `rota` of this route's lines (the blocked-call line included). */
export const ROTA_ENVIO_MANUAL_ESTOQUE_AMAZON = 'enviar-estoque';

const ROTULO = '[amazon] enviar-estoque';

/**
 * The largest body read: 64 KiB. A bound on the READ (an authenticated caller
 * can still send anything), far above fifty document ids and a conta id.
 */
export const MAX_CORPO_ENVIO_MANUAL_ESTOQUE_BYTES = 64 * 1024;

/**
 * The route's budget, from the request's start (module header, rung 8): the
 * web gives the call 60 s, so 40 s leaves the answer and a slow network
 * inside it.
 *
 * ⚠️ It bounds when an enqueue STARTS, never when the route answers: the batch
 * awaits every enqueue already started (at most 16), and the Admin SDK's Cloud
 * Tasks call carries no timeout of its own while it retries a 503 or a reset
 * connection up to four times, honouring a `Retry-After` of up to 60 s each.
 * One slow enqueue can therefore hold the answer past the web's deadline; the
 * caller's timeout then means UNKNOWN (part of the batch may be on the queue),
 * and a re-send is safe (a new reference, so new names; each task recomputes).
 */
export const ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS = 40_000;

/**
 * The most Firestore reads rungs 5 and 6 keep in flight: the shared selection's
 * (`listings/selecaoManual.ts`), under the stock name.
 */
export const LARGURA_LEITURAS_ENVIO_MANUAL_ESTOQUE = LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON;

/** The conta fields rung 4 reads (its by-id read is masked to them). */
export const CAMPOS_CONTA_ENVIO_MANUAL_ESTOQUE_AMAZON = [
  'tipo',
  'ativo',
  'depositoOuterRef',
] as const satisfies ReadonlyArray<keyof typeof integracaoSchema.shape>;

/** The produto fields rung 5 reads off a SELECTED produto: the parent pointer and the label. */
export const CAMPOS_PRODUTO_ENVIO_MANUAL_ESTOQUE_AMAZON = CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON;

/** The ONE field rung 5 reads off an anchor no selected id IS: its label for the rows. */
export const CAMPOS_ROTULO_ANCORA_ENVIO_MANUAL_ESTOQUE_AMAZON =
  CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON;

/** The link fields `skusDaConta` reads (rung 6's partition listings are projected to them). */
export const CAMPOS_VINCULO_ENVIO_MANUAL_ESTOQUE_AMAZON = CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON;

/**
 * The children seek's fields, in the declared composite's order: the equality
 * on the parent, then the order the index is sorted by (rung 6).
 */
export const CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_ESTOQUE_AMAZON =
  CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON;

/** Why a row or a produto was answered the way it was: the sentence it carries. */
export const MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON = {
  enfileirado: 'enfileirado',
  semCaminho: 'sem-caminho',
  foraDaTarefa: 'fora-da-tarefa',
  filaDesligada: 'fila-desligada',
  orcamentoEsgotado: 'orcamento-esgotado',
  semVinculo: 'sem-vinculo',
  produtoAusente: 'produto-ausente',
  paiAusente: 'pai-ausente',
} as const;
export type MotivoEnvioManualEstoqueAmazon =
  (typeof MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON)[keyof typeof MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON];

/** The pt-BR sentence of each motivo: the BACKEND owns this wording. */
export const MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON: Readonly<
  Record<MotivoEnvioManualEstoqueAmazon, string>
> = {
  enfileirado: 'Na fila: a quantidade é conferida com a Amazon e enviada em alguns minutos.',
  'sem-caminho': 'SKU sem caminho na API da Amazon: só o envio em lote o atualiza.',
  'fora-da-tarefa': 'SKU longo demais para a API da Amazon: nenhum envio o atualiza.',
  'fila-desligada': 'Fila de envio desligada.',
  'orcamento-esgotado': 'Tempo esgotado: envie de novo.',
  'sem-vinculo': 'Sem anúncio da Amazon vinculado nesta conta.',
  'produto-ausente': 'Produto não encontrado.',
  'pai-ausente': 'Produto pai da variação não encontrado: corrija o cadastro.',
};

/** Everything one push needs — injected, so a test drives the ladder with doubles. */
export interface DepsEnvioManualEstoqueAmazon {
  /**
   * The process environment. ONLY `AMAZON_CHAMADAS` is read from it — never the
   * stock valve or its canary list (module header).
   */
  readonly ambiente: AmbienteAmazon;
  /** Resolved LAZILY: a refusal before rung 4 never builds the handle. */
  readonly db: () => Firestore;
  /** The queue valve, as the App Hosting root read it (exactly `'1'` closes it). */
  readonly filaDesligada: boolean;
  /**
   * The stock queue's region, as the App Hosting root resolves it for its
   * producer (`MissingRegionError` when unset) — checked at rung 3.
   */
  readonly regiao: () => string;
  /** The stock producer, built only at the enqueue, and never with the valve closed. */
  readonly produtor: () => ProdutorEstoqueAmazon;
  /** The route's clock, ms: the budget is read against it. */
  readonly agora: () => number;
  /** The request's own id: every task's `referencia` (the feed core's id grammar). */
  readonly gerarReferencia: () => string;
  readonly logger: LoggerAmazon;
}

/**
 * A RAW Cloud Tasks SDK failure of the push's enqueue, sanitized (module
 * header, "An enqueue that fails"): the SDK class and code and the HTTP status
 * Cloud Tasks answered — never the SDK's message, and no `cause` or
 * `httpResponse`, which a logger of the thrown error would print whole. Still a
 * 500.
 */
export class AmazonEstoqueEnfileiramentoFalhouError extends Error {
  /** `<class>/<code>` (`descreverFalhaDoSdkDeTarefasAmazon`). */
  readonly falha: string;
  /** The status Cloud Tasks answered; `null` when no request was answered. */
  readonly httpStatus: number | null;

  constructor(falha: string, httpStatus: number | null) {
    const status = httpStatus === null ? '' : `, HTTP ${String(httpStatus)}`;
    super(
      `enqueue do estoque no Cloud Tasks falhou (${falha}${status}); o resultado é desconhecido`,
    );
    this.name = 'AmazonEstoqueEnfileiramentoFalhouError';
    this.falha = falha;
    this.httpStatus = httpStatus;
  }
}

/** The `resultado` of the ERROR line a propagated failure writes (module header). */
const FALHOU = 'falhou';

/** What the route answers: a status and the JSON body, both built here. */
export type ResultadoEnvioManualEstoqueAmazon =
  | { readonly status: 200; readonly corpo: EnvioEstoqueManualAmazon }
  | { readonly status: 400 | 404 | 503; readonly corpo: ErroEnvioEstoqueManualAmazon };

/** The body, STRICTLY (rung 1). */
const corpoEnvioManualEstoqueSchema = z
  .object({
    integracaoId: z.string().regex(CONTA_ID_AMAZON_REGEX),
    produtoIds: z
      .array(z.string().refine((id) => !naoDocId(id), { message: 'não é um id de documento' }))
      .min(1),
  })
  .strict();

/** The issue path of a refusal with no field of its own (no JSON, not an object, too big). */
const CORPO = '(corpo)';

type LeituraCorpoEnvio =
  | { readonly ok: true; readonly integracaoId: string; readonly produtoIds: readonly string[] }
  | { readonly ok: false; readonly issues: readonly string[] };

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

/** Rung 1: the bounded read, the JSON, the strict shape, the ids deduplicated in request order. */
async function lerCorpo(req: Request): Promise<LeituraCorpoEnvio> {
  const lido = await lerCorpoLimitado(
    req.body,
    req.headers.get('content-length'),
    MAX_CORPO_ENVIO_MANUAL_ESTOQUE_BYTES,
  );
  if (lido.tipo === 'grande') return { ok: false, issues: [CORPO] };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(lido.dados));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, issues: [CORPO] };
  }
  const corpo = corpoEnvioManualEstoqueSchema.safeParse(json);
  if (!corpo.success) return { ok: false, issues: caminhosDosProblemas(corpo.error) };
  return {
    ok: true,
    integracaoId: corpo.data.integracaoId,
    produtoIds: [...new Set(corpo.data.produtoIds)],
  };
}

/** The counts one answer's line carries (module header, "Logs"). */
interface ContagemEnvioManualEstoque {
  readonly produtos: number | null;
  readonly ancoras: number | null;
  readonly anuncios: number | null;
  readonly enfileirados: number;
  readonly jaEnfileirados: number;
  readonly pulados: number;
  readonly naoTentados: number;
  readonly semEnvio: number;
}

const SEM_CONTAGEM: ContagemEnvioManualEstoque = {
  produtos: null,
  ancoras: null,
  anuncios: null,
  enfileirados: 0,
  jaEnfileirados: 0,
  pulados: 0,
  naoTentados: 0,
  semEnvio: 0,
};

/** The ONE `evento: 'estoque'` line of an answer (module header). */
function registrar(
  deps: DepsEnvioManualEstoqueAmazon,
  severidade: SeveridadeAmazon,
  resultado: string,
  campos: {
    readonly motivo?: string;
    readonly contaId?: string;
    readonly referencia?: string;
    readonly contagem?: ContagemEnvioManualEstoque;
  } = {},
): void {
  const contagem = campos.contagem ?? SEM_CONTAGEM;
  registrarEventoAmazon(
    deps.logger,
    'estoque',
    severidade,
    `${ROTULO} ${resultado}`,
    {
      rota: ROTA_ENVIO_MANUAL_ESTOQUE_AMAZON,
      resultado,
      motivo: campos.motivo ?? null,
      referencia: campos.referencia ?? null,
      produtos: contagem.produtos,
      ancoras: contagem.ancoras,
      anuncios: contagem.anuncios,
      enfileirados: contagem.enfileirados,
      jaEnfileirados: contagem.jaEnfileirados,
      pulados: contagem.pulados,
      naoTentados: contagem.naoTentados,
      semEnvio: contagem.semEnvio,
    },
    {
      fluxo: FLUXO_AMAZON.estoque,
      ...(campos.contaId === undefined ? {} : { conta: campos.contaId }),
    },
  );
}

/** An error answer: the envelope, built by name. */
function erro(
  status: 400 | 404 | 503,
  code: string,
  error: string,
  extras: {
    readonly issues?: readonly string[];
    readonly detalhes?: {
      readonly limite: number;
      readonly unidade: UnidadeLimiteEnvioEstoqueManualAmazon;
      readonly encontrados: number;
    };
  } = {},
): ResultadoEnvioManualEstoqueAmazon {
  return {
    status,
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
    },
  };
}

/** A limit refusal (rungs 1 and 7): nothing was enqueued. */
function excedeLimite(
  deps: DepsEnvioManualEstoqueAmazon,
  contaId: string,
  unidade: UnidadeLimiteEnvioEstoqueManualAmazon,
  limite: number,
  encontrados: number,
  contagem: ContagemEnvioManualEstoque,
): ResultadoEnvioManualEstoqueAmazon {
  registrar(deps, 'INFO', CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE, {
    motivo: unidade,
    contaId,
    contagem,
  });
  const frase =
    unidade === UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.produtos
      ? `Selecione no máximo ${String(limite)} produtos para enviar o estoque à Amazon (foram ${String(encontrados)}); nada foi enfileirado.`
      : `Os produtos selecionados têm ${String(encontrados)} anúncios nesta conta da Amazon, e o envio manual aceita no máximo ${String(limite)}: nada foi enfileirado. Selecione menos produtos; a sincronização automática e a reconciliação diária enviam o restante.`;
  return erro(400, CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE, frase, {
    detalhes: { limite, unidade, encontrados },
  });
}

/**
 * What the caller RETHROWS for an enqueue failure other than the queue valve
 * (module header, "An enqueue that fails"), after ONE ERROR line for a failure
 * the route names: the raw SDK failure sanitized, anything else unchanged.
 */
function erroDoEnfileiramento(
  deps: DepsEnvioManualEstoqueAmazon,
  err: unknown,
  campos: {
    readonly contaId: string;
    readonly referencia: string;
    readonly contagem: ContagemEnvioManualEstoque;
  },
): unknown {
  if (ehFalhaDoSdkDeTarefasAmazon(err)) {
    const falha = descreverFalhaDoSdkDeTarefasAmazon(err);
    registrar(deps, 'ERROR', FALHOU, { ...campos, motivo: `enfileiramento/${falha}` });
    return new AmazonEstoqueEnfileiramentoFalhouError(falha, err.httpResponse?.status ?? null);
  }
  if (
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof MissingRegionError ||
    err instanceof AmazonEstoqueRegiaoDaFilaInvalidaError
  ) {
    registrar(deps, 'ERROR', FALHOU, { ...campos, motivo: `enfileiramento/${err.name}` });
  }
  return err;
}

/* -------------------------------------------------------------------------- */
/*                                 the ladder                                 */
/* -------------------------------------------------------------------------- */

/** One listing's answer, before the envelope is built by name. */
interface DesfechoSku {
  resultado: ResultadoEnvioEstoqueManualAmazon;
  motivo: MotivoEnvioManualEstoqueAmazon;
}

/**
 * Push ONE selection's stock: the ladder of the module header, answered as a
 * status and a JSON body. Throws only what it must not answer (module header,
 * "An enqueue that fails").
 */
export async function enviarEstoqueManualAmazon(
  req: Request,
  deps: DepsEnvioManualEstoqueAmazon,
): Promise<ResultadoEnvioManualEstoqueAmazon> {
  const prazoMs = deps.agora() + ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS;

  // ---- 1. the body, strictly — before anything else is read. ----
  const corpo = await lerCorpo(req);
  if (!corpo.ok) {
    registrar(deps, 'INFO', CODIGO_ERRO_ESTOQUE_AMAZON.CORPO_INVALIDO);
    return erro(
      400,
      CODIGO_ERRO_ESTOQUE_AMAZON.CORPO_INVALIDO,
      'Corpo inválido: envie apenas { integracaoId, produtoIds } — integracaoId é o id da ' +
        'conta da Amazon no ERP; produtoIds, de 1 a ' +
        `${String(MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON)} ids de produto. ` +
        'Nada foi enfileirado.',
      { issues: corpo.issues },
    );
  }
  const { integracaoId: contaId, produtoIds } = corpo;
  if (produtoIds.length > MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON) {
    return excedeLimite(
      deps,
      contaId,
      UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.produtos,
      MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON,
      produtoIds.length,
      { ...SEM_CONTAGEM, produtos: produtoIds.length },
    );
  }

  // ---- 2. the read switch — nothing read before it answers. ----
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: ROTA_ENVIO_MANUAL_ESTOQUE_AMAZON,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    return erro(
      503,
      CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      'As chamadas à Amazon estão desligadas neste backend (até a migração, ou por ' +
        'configuração); nada foi enfileirado.',
    );
  }

  // ---- 3. the queue's region — a broken deploy surfaces before any read. ----
  if (!deps.filaDesligada) {
    try {
      caminhoDaFilaEstoqueAmazon(deps.regiao());
    } catch (err) {
      if (
        err instanceof MissingRegionError ||
        err instanceof AmazonEstoqueRegiaoDaFilaInvalidaError
      ) {
        registrar(deps, 'ERROR', FALHOU, { motivo: `${TASKS_REGION_ENV}/${err.name}`, contaId });
      }
      throw err;
    }
  }

  // ---- 4. the conta, raw and uncached; its depósito through the ONE parse. ----
  const db = deps.db();
  const [snapConta] = await db.getAll(integracaoCollection.docRef(db, {}, contaId), {
    fieldMask: [...CAMPOS_CONTA_ENVIO_MANUAL_ESTOQUE_AMAZON],
  });
  const conta =
    snapConta?.exists === true ? ((snapConta.data() ?? {}) as Record<string, unknown>) : null;
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.amazon || conta.ativo === false) {
    registrar(deps, 'INFO', CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_NAO_ENCONTRADA, { contaId });
    return erro(
      404,
      CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_NAO_ENCONTRADA,
      'Conta da Amazon não encontrada, ou inativa; nada foi enfileirado.',
    );
  }
  if (depositoIdDaContaEstoqueAmazon(conta.depositoOuterRef) === null) {
    registrar(deps, 'INFO', CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_SEM_DEPOSITO, { contaId });
    return erro(
      400,
      CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_SEM_DEPOSITO,
      'A conta da Amazon não tem um depósito de estoque válido; configure o depósito da ' +
        'conta. Nada foi enfileirado.',
    );
  }

  // ---- 5 and 6. the selection's anchors and their families' SKUs. ----
  const selecao = await lerSelecaoManualAmazon(db, contaId, produtoIds);
  const skus = [...new Set([...selecao.skusDaAncora.values()].flat())];
  // Every selected produto leaves in exactly ONE place: its anchor's rows, or
  // its own entry here (no document, a parent with no document, or no listing
  // of the conta in its family).
  const semEnvio = produtoIds.flatMap(
    (id): { readonly produtoId: string; readonly motivo: MotivoEnvioManualEstoqueAmazon }[] => {
      const ancora = selecao.ancoraDe.get(id);
      if (ancora === undefined) {
        return [{ produtoId: id, motivo: MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.produtoAusente }];
      }
      if (selecao.ancorasAusentes.has(ancora)) {
        return [{ produtoId: id, motivo: MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.paiAusente }];
      }
      if ((selecao.skusDaAncora.get(ancora) ?? []).length === 0) {
        return [{ produtoId: id, motivo: MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.semVinculo }];
      }
      return [];
    },
  );
  const lidos: ContagemEnvioManualEstoque = {
    ...SEM_CONTAGEM,
    produtos: produtoIds.length,
    ancoras: selecao.skusDaAncora.size,
    anuncios: skus.length,
    semEnvio: semEnvio.length,
  };

  // ---- 7. THE SWITCH: all or nothing. ----
  if (skus.length > LIMIAR_FEED_ESTOQUE_AMAZON) {
    return excedeLimite(
      deps,
      contaId,
      UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.anuncios,
      LIMIAR_FEED_ESTOQUE_AMAZON,
      skus.length,
      lidos,
    );
  }

  // ---- 8. per SKU: skipped, or its NAMED task; then ONE batch. ----
  const referencia = deps.gerarReferencia();
  if (!ID_LOTE_FEED_AMAZON_REGEX.test(referencia)) {
    throw new RangeError('envioManualEstoque.ts: referência gerada fora da gramática');
  }
  const desfechos = new Map<string, DesfechoSku>();
  const tarefas: TarefaEstoqueAmazon[] = [];
  for (const sku of skus) {
    if (!skuTemCaminhoAmazon(sku)) {
      desfechos.set(sku, {
        resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.pulado,
        motivo: MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.semCaminho,
      });
      continue;
    }
    // Identities only: no quantity, no depósito (the task reads both when it runs).
    const tarefa = tarefaEstoqueAmazonSchema.safeParse({
      v: VERSAO_TAREFA_ESTOQUE_AMAZON,
      contaId,
      sku,
      origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.manual,
      referencia,
      depositoId: null,
    });
    if (tarefa.success) {
      tarefas.push(tarefa.data);
    } else {
      desfechos.set(sku, {
        resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.pulado,
        motivo: MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.foraDaTarefa,
      });
    }
  }

  let enfileirados = 0;
  let jaEnfileirados = 0;
  let naoTentadas = 0;
  let motivoNaoTentado: MotivoEnvioManualEstoqueAmazon =
    MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.orcamentoEsgotado;
  if (tarefas.length > 0 && deps.filaDesligada) {
    naoTentadas = tarefas.length;
    motivoNaoTentado = MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.filaDesligada;
  } else if (tarefas.length > 0) {
    try {
      const lote = await deps
        .produtor()
        .enfileirarLote(tarefas, { continuar: () => deps.agora() < prazoMs });
      enfileirados = lote.enfileiradas;
      jaEnfileirados = lote.jaEnfileiradas;
      naoTentadas = lote.naoTentadas;
    } catch (err) {
      if (!(err instanceof AmazonEstoqueTarefasDesligadasError)) {
        throw erroDoEnfileiramento(deps, err, { contaId, referencia, contagem: lidos });
      }
      // The valve closed between the root's read and the batch: nothing was enqueued.
      naoTentadas = tarefas.length;
      motivoNaoTentado = MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.filaDesligada;
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
            motivo: MOTIVO_ENVIO_MANUAL_ESTOQUE_AMAZON.enfileirado,
          }
        : { resultado: RESULTADO_ENVIO_ESTOQUE_MANUAL_AMAZON.naoTentado, motivo: motivoNaoTentado },
    );
  }

  // ---- 9. the envelope, by name: one row per (anchor, SKU). ----
  const listings = [...selecao.skusDaAncora.entries()].flatMap(([ancora, daAncora]) =>
    daAncora.map((sku) => {
      const d = desfechos.get(sku);
      if (d === undefined) throw new TypeError('envioManualEstoque.ts: um SKU sem desfecho');
      return {
        produtoId: ancora,
        produtoNome: selecao.nomeDe.get(ancora) ?? null,
        sku,
        resultado: d.resultado,
        mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON[d.motivo],
      };
    }),
  );
  const contagem: ContagemEnvioManualEstoque = {
    ...lidos,
    enfileirados,
    jaEnfileirados,
    pulados: skus.length - tarefas.length,
    naoTentados: naoTentadas,
  };
  registrar(
    deps,
    naoTentadas > 0 ? 'WARNING' : 'INFO',
    enfileirados + jaEnfileirados > 0 ? 'enfileirado' : 'nada-enfileirado',
    {
      ...(naoTentadas > 0 ? { motivo: motivoNaoTentado } : {}),
      contaId,
      referencia,
      contagem,
    },
  );
  return {
    status: 200,
    corpo: {
      listings,
      produtosSemEnvio: semEnvio.map((p) => ({
        produtoId: p.produtoId,
        produtoNome: selecao.nomeDe.get(p.produtoId) ?? null,
        mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON[p.motivo],
      })),
      pausadoAte: null,
    },
  };
}
