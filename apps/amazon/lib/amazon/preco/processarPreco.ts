/**
 * The price task (step 13, PR 13-d): ONE price send for ONE SKU of one conta,
 * a `preco-sku` task on the jobs queue (`processAmazonListingsJob`), P0–P11 in
 * this exact order. The jobs root binds the deps ({@link DepsProcessarPrecoAmazon},
 * the preview flag among them) and rethrows a throw through the app's
 * sanitizing boundary; the ONE `evento: 'preco'` dispatch line is written HERE
 * ({@link registrarDespachoPrecoAmazon}), on every end this body decides — a
 * deliberate throw for the queue's retry included.
 *
 * ## The ladder
 *
 * - **P0** — `tarefaPrecoSkuAmazonSchema` (`.strict()`): an invalid payload is
 *   dropped with a WARNING, nothing read. The payload carries identities, the
 *   consent and its clock only: the prices are computed when the task RUNS.
 * - **P1** — the price valve, read ONCE (`lerValvula`) and logged, with the
 *   preview flag applied (`valvulaPrecoEfetiva`, `modoPreco.ts`: the flag with
 *   `on` + `*` reads `dry-run` and makes this line an ERROR), then the target
 *   (`decidirAlvo`, the SKU). `off` ⇒ `desligado` with ZERO Firestore reads.
 * - **P2** — before the context (no LWA exchange for a task that ends here):
 *   - a RUN's task (`origem: 'execucao'`) reads its run by id, masked to
 *     `execucaoId` and `fase`: another run's id (or no run) ⇒
 *     `execucao-substituida`; a phase other than `decidindo`/`concluida` ⇒
 *     `execucao-cancelada`. A cancelled or superseded run's task stands down
 *     before waiting behind anything;
 *   - ONE by-id read of the PRICE lease (never the stock one), masked,
 *     classified by `decidirTomadaDaVez` under the task's own name: `ocupada`
 *     (a healthy price feed in flight, younger than
 *     `ESPERA_MAXIMA_ATRAS_DE_FEED_MS`) ⇒ the payload re-enqueued UNNAMED
 *     after 300 s (`aguardando-feed`), zero Amazon calls. Any other
 *     classification proceeds; the same read gives the end of the conta's
 *     last price feed (the feed-recent rule). An unreadable lease proceeds.
 * - **P3** — the context (the read switch first); then the conta's tabelas
 *   off ONE raw by-id read of the conta, masked to the two refs and never
 *   cached (`tabelasDePrecoDaContaAmazon`): an operator who switches tabelas
 *   and pushes gets the new one at once. No normal tabela ⇒
 *   `conta-sem-tabela-normal`.
 * - **P4** — the link, every read masked (`listings/resolverVinculo.ts` with
 *   the price masks: the unit's ONE `precos.<tabela>` entry per tabela, and
 *   its parent), then the shared verdict bound to price
 *   ({@link REGRA_VINCULO_PRECO_AMAZON}). A refusal ⇒ one line, end. A CHECK
 *   (`origem: 'verificacao'`) goes on only while the link's latest price
 *   outcome is the very patch it checks (its `submissionId` is the payload's
 *   reference): otherwise `superado`, zero Amazon calls.
 * - **P5** — the faixa, NOW (`faixaDePrecoAmazon`): `sem-preco` ⇒ end;
 *   `faixa-invertida` ⇒ the conta aviso `preco-faixa-invertida` raised
 *   (clocked by P3's conta read, the shared resolver answering no read time),
 *   end, zero Amazon calls.
 *   A check whose ERP faixa is no longer the offer it checks ⇒ `erp-mudou`,
 *   end: it never sends a value nobody pushed. A run's task reads its part by
 *   id and takes its member's page-time `base` as the consent FLOOR; a part or
 *   a member that is gone ⇒ `desconhecido` (`parte-ausente`), and every
 *   decrease of `our_price` is refused.
 * - **P6** — `skuTemCaminhoAmazon` false ⇒ `sem-caminho` (only a feed carries
 *   the SKU).
 * - **P7** — the write engine's single-target entry (`executarEscritaAmazon`):
 *   the live read (summaries, attributes, issues, relationships; its own 404 ⇒
 *   `nao-listado`), the shared listing gate, the listing's `productType` (a
 *   malformed one ⇒ `tipo-produto-ilegivel`), then the plan:
 *   - a send: `planejarPrecoAmazon` (`planoPreco.ts`) with the consent
 *     (`baixarPreco` inside its window from `solicitadoEmMs`), the floor, the
 *     link's last price outcome and the feed's end;
 *   - a check: `planejarVerificacaoPrecoAmazon` — a NEW blocking price issue
 *     ⇒ `recusado`, Amazon holding the offer ⇒ `aceito` (or
 *     `aceito-com-avisos` while a blocking one read before the send
 *     persists), a price a person must confirm ⇒ `recusado`: each REFINES the
 *     checked entry (its own `emMs` and `submissionId`), with no PATCH;
 *     otherwise ONE re-send of the STORED offer, planned as a send of its own
 *     with the original consent and no floor.
 *   The write is ONE offer PATCH, in this order:
 *     1. the WRITE-AHEAD record — `{ via: 'patch', emMs, oferta, resultado:
 *        'incerto' }` written back BEFORE the PATCH (never under the preview
 *        flag), its `emMs` our clock raised past every stored `emMs` the
 *        write-back will compare it with, read raw off P4's link docs
 *        ({@link instanteDoRegistroPrevio}). Not recorded (a Firestore
 *        failure, a link doc still in conflict, or none written: a newer
 *        outcome kept it out, or the link doc is gone) ⇒ no PATCH and a throw
 *        for the retry: nothing was sent (`vinculo-mudou` on the line, a
 *        Firestore failure aside);
 *     2. the PATCH, through the write client whose credential getter is
 *        wrapped by `listings/escritaListing.ts`: with the credential IN HAND,
 *        past {@link ORCAMENTO_ANTES_DO_PATCH_PRECO_MS} since the dispatch
 *        began ⇒ no PATCH, `prazo-da-tarefa`, a throw for the retry (which
 *        recomputes). The outcome's `emMs` is our clock at that instant, raised
 *        to one past the write-ahead's, so the answer always replaces its own
 *        record. Under the preview flag the PATCH is a `VALIDATION_PREVIEW`.
 * - **P8** — after an answer, a NO-THROW boundary: the outcome written back
 *   (`ACCEPTED` ⇒ `aceito` / `aceito-com-avisos`, `INVALID` ⇒ `recusado`); on
 *   `INVALID` the conta aviso `preco-recusado-pela-amazon` only when a
 *   BLOCKING price issue is among the answer's issues, clocked by the
 *   write-back's link-doc read, and only when this outcome is, or may be, the
 *   link's latest. A preview writes nothing back. A write-back lost (every
 *   attempt losing its precondition) leaves the write-ahead's `incerto` in
 *   place: the SKU's next push re-sends.
 * - **P9** — inside the boundary, after `ACCEPTED` and a write-back that
 *   LANDED (never for a check, its re-send or a preview): ONE check task, 900
 *   s later, named after Amazon's `submissionId`.
 * - **P10** — the failures, by CLASS (root `CLAUDE.md` rule 6): a 429 ⇒ the
 *   payload re-enqueued UNNAMED 60 s later, no throw; a read-side failure
 *   through `classificarFalhaDeLeituraAmazon`; a cut, 5xx, dropped or
 *   off-schema PATCH ⇒ the write-ahead already says `incerto`:
 *   `escrita-incerta` and a throw; any other 4xx ⇒ `escrita-falhou`, ERROR,
 *   end (the write-ahead stays: it can only ADD a send).
 *   ⚠️ A CHECK's re-send is never handed back once its own write-ahead landed:
 *   that record replaces the entry the check is bound to, so a retry or a
 *   paused copy could only end `superado`. Its 429, its budget, a cut PATCH
 *   or a transient after that point END the dispatch, with `reenvioPerdido`
 *   on a WARNING line and nothing re-enqueued; the `incerto` record makes the
 *   SKU's next push re-send.
 * - **P11** — ONE dispatch line: the origem, the SKU, the closed motivo, the
 *   faixa sent and the live offer (three numbers each, or `null`), the
 *   direction of `our_price`, the offer's flags, the product type, Amazon's
 *   status and issue codes through their grammar, the error class and
 *   `limiteTaxa` (the lowest `x-amzn-RateLimit-Limit` of the answers, `null`
 *   when none carried it). Never an issue message, a seller id or a body.
 *
 * ## The no-throw boundary
 *
 * Everything after a PATCH Amazon answered CONTAINS its named failures — a
 * Firestore error, the jobs producer's own classes, a missing or malformed
 * region — and names the first one in the line (`perda`): a throw there would
 * read as the write failing, and its retry would send again. An unnamed
 * failure is a bug, and crosses.
 *
 * ## Rule 7
 *
 * The PATCH body is an ABSOLUTE offer computed at dispatch from fresh reads;
 * the jobs queue's concurrency 1 orders a conta's price writes, and the budget
 * keeps a stale execution from sending after a fresher dispatch. The Firestore
 * writes are the price outcome on the link docs (`envioPrecoAmazon`, tier 2 on
 * `emMs` through a tier-1 precondition, the shared write-back bound by
 * {@link CAMPO_DO_ENVIO_PRECO_AMAZON}: the same-send refinement and the 5-min
 * future tolerance on) and the conta avisos (the shared seam). The write-ahead
 * record closes the lost-answer residue: a dispatch that dies after its PATCH
 * left still leaves a recent send for the next task to judge by. No
 * transaction.
 *
 * ⚠️ D11: nothing here reaches Amazon while the read switch is off (the context
 * refuses first), and a PATCH also needs the price valve `on` and a canary hit.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import {
  divergenciaPrecoAmazonCollection,
  integracaoCollection,
  precoAmazonCollection,
  vezFeedAmazonCollection,
} from '@delfrance/data/admin/collections';
import {
  AmazonHttpError,
  AmazonThrottleError,
  type IssueListingAmazon,
  type ListingAmazon,
  MODO_ENVIO_LISTING_AMAZON,
  type OfertaListingAmazon,
  ofertaDoListingAmazon,
  skuTemCaminhoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  FLUXO_FEED_AMAZON,
  type FaixaPrecoAmazon,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  type ResultadoEnvioEstoqueAmazon,
  TIPO_FAIXA_PRECO_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  type TabelasDePrecoAmazon,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioPrecoAmazonSchema,
  type execucaoPrecoAmazonSchema,
  faixaDePrecoAmazon,
  faseExecucaoPrecoAmazonSchema,
  fontesPrecoDaUnidadeAmazon,
  idDivergenciaPrecoAmazon,
  idVezFeedAmazon,
  type integracaoSchema,
  itemDivergenciaPrecoAmazonSchema,
  tabelasDePrecoDaContaAmazon,
  type VezFeedAmazon,
  vezFeedAmazonSchema,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_LISTINGS_AMAZON,
  type MotivoContaPrecoAmazon,
  sincronizarAvisoContaListingsAmazon,
} from '../avisos/avisos';
import type { ContextoAmazon, ContextoAmazonDeps } from '../core/contexto';
import { type ResultadoEscritaAmazon, executarEscritaAmazon } from '../core/escrita';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { CODIGO_OUTRO, codigoDeErroSeguro, passaPredicadoAmazon } from '../core/redacao';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  type MotivoDryRunAmazon,
  decidirAlvo,
  lerValvula,
  registrarValvulaAmazon,
} from '../core/valvulas';
import {
  type AmbienteAmazon,
  LEITURA_PRECO_SO_VALIDACAO_AMAZON,
  PRECO_SO_VALIDACAO_ENV,
  lerPrecoSoValidacaoAmazon,
} from '../env';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
  FILA_LOTES_AMAZON,
} from '../feeds/agendadorLotes';
import { TOMADA_DA_VEZ, type TipoTomadaDaVez, decidirTomadaDaVez } from '../feeds/vezFeed';
import { marcaDaguaEnvioListing } from '../listings/envioListing';
import {
  type CampoEnvioListingAmazon,
  type ResultadoGravacaoEnvioListingAmazon,
  gravarEnvioListingAmazon,
} from '../listings/envioListingFirestore';
import {
  classeDaFalhaListingAmazon,
  contextoDaEscritaComOrcamentoListingAmazon,
  contidoListingAmazon,
  envioRecusadoListingAmazon,
  envioTalvezAplicadoListingAmazon,
  falhaContidaListingAmazon,
  pausarListingAmazon,
} from '../listings/escritaListing';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import { type LeituraListingAmazon, avaliarGateListingAmazon } from '../listings/gateListing';
import {
  type EnvioComTaxaListingNaAmazon,
  INCLUIR_LEITURA_PRECO,
  type LeituraComTaxaListingNaAmazon,
  enviarOfertaComTaxaNaAmazon,
  lerListingComTaxaNaAmazon,
} from '../listings/listingsAmazon';
import {
  camposDoResolverListingAmazon,
  lerVinculoListingAmazon,
} from '../listings/resolverVinculo';
import {
  CAMPO_ENVIO_LISTING_AMAZON,
  MOTIVO_VINCULO_LISTING_AMAZON,
  type RecusaVinculoListingAmazon,
  type RegraVinculoListingAmazon,
  type VinculoAptoListingAmazon,
  avaliarVinculoListingAmazon,
} from '../listings/vinculoListing';
import {
  FALHA_LEITURA_AMAZON,
  type FalhaLeituraAmazon,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import {
  codigosPrecoAmazon,
  ehIssuePrecoAmazon,
  temIssuePrecoBloqueanteAmazon,
} from './issuesPreco';
import { type VereditoValvulaPrecoAmazon, valvulaPrecoEfetiva } from './modoPreco';
import {
  MOTIVO_PRECO_AMAZON,
  type MotivoPrecoAmazon,
  RECUSAS_VINCULO_PRECO_AMAZON,
} from './motivosPreco';
import { compravelNoBrPrecoAmazon, tipoProdutoDoListingPrecoAmazon } from './paginaPreco';
import {
  DECISAO_PLANO_PRECO_AMAZON,
  DECISAO_VERIFICACAO_PRECO_AMAZON,
  type DirecaoPrecoAmazon,
  PISO_DESCONHECIDO_PRECO_AMAZON,
  type PisoConsentimentoPrecoAmazon,
  type RegraEscritaPrecoAmazon,
  consentimentoValidoPrecoAmazon,
  erpMudouPrecoAmazon,
  planejarPrecoAmazon,
  planejarVerificacaoPrecoAmazon,
} from './planoPreco';
import type { ProdutorPrecoAmazon, ResultadoEnfileiramentoPrecoAmazon } from './produtorPreco';
import {
  ORIGEM_TAREFA_PRECO_AMAZON,
  type OrigemTarefaPrecoAmazon,
  REFERENCIA_SUBMISSAO_PRECO_REGEX,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/**
 * The task's own budget before its PATCH, in ms (module header, P7), checked
 * with the write's credential in hand before EVERY PATCH (the forced refresh's
 * second one included): far inside the jobs queue's 540-s timeout, with the
 * PATCH, its forced refresh and a second PATCH on top.
 */
export const ORCAMENTO_ANTES_DO_PATCH_PRECO_MS = 200_000;

/**
 * How far ahead of the clock a STORED price outcome's `emMs` may sit and still
 * be a watermark (5 min): a value further ahead is set aside and logged, so a
 * client-forged future `emMs` neither freezes the field nor keeps the
 * write-ahead record out.
 */
export const FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS = 300_000;

/** The conta fields P3 reads: the two tabela refs. */
export const CAMPOS_CONTA_PRECO_AMAZON = [
  'tabelaNormalOuterRef',
  'tabelaPromocionalOuterRef',
] as const satisfies readonly (keyof typeof integracaoSchema.shape)[];

/** The run fields a run's task reads (P2). */
export const CAMPOS_EXECUCAO_TAREFA_PRECO_AMAZON = [
  'execucaoId',
  'fase',
] as const satisfies readonly (keyof typeof execucaoPrecoAmazonSchema.shape)[];

/** The price lease fields P2 reads: what the classification and the feed-recent rule need. */
export const CAMPOS_VEZ_TAREFA_PRECO_AMAZON = [
  'estado',
  'execucaoId',
  'feedId',
  'antesDoEnvioMs',
  'ateMs',
  'atualizadoEmMs',
  'ultimoEnvioMs',
  'ultimoFeedConcluidoEmMs',
] as const satisfies readonly (keyof typeof vezFeedAmazonSchema.shape)[];

/** The part field a run's task reads (P5): its members. */
export const CAMPO_ITENS_PARTE_PRECO_AMAZON = 'itens';

/** The submission statuses a PATCH answer is read by, as the model spells them. */
export const STATUS_ENVIO_PRECO_AMAZON = {
  aceito: 'ACCEPTED',
  invalido: 'INVALID',
  /** A validation preview's answer: valid, nothing persisted. */
  valido: 'VALID',
} as const;

/** The issue severity that is kept first in a stored outcome, as Amazon spells it. */
const SEVERIDADE_ERRO_AMAZON = 'ERROR';

/** The price outcome stored on a link doc, parsed; `null` when absent or refused by its schema. */
function lerEnvioPreco(valor: unknown): EnvioPrecoAmazon | null {
  const lido = envioPrecoAmazonSchema.safeParse(valor);
  return lido.success ? lido.data : null;
}

/** The price flow's binding of the shared link verdict: refusals 1–4, `envioPrecoAmazon` read. */
export const REGRA_VINCULO_PRECO_AMAZON: RegraVinculoListingAmazon<EnvioPrecoAmazon> = {
  fluxo: FLUXO_LISTING_AMAZON.preco,
  lerEnvio: lerEnvioPreco,
};

/**
 * The price flow's binding of the shared outcome write-back: the price field
 * alone, parsed by `envioPrecoAmazonSchema`, with the same-send refinement (a
 * check refining the entry its send left) and the future tolerance on.
 */
export const CAMPO_DO_ENVIO_PRECO_AMAZON: CampoEnvioListingAmazon<EnvioPrecoAmazon> = {
  fluxo: FLUXO_LISTING_AMAZON.preco,
  schema: envioPrecoAmazonSchema,
  rotulo: 'processarPreco.ts',
  refinaMesmoEnvio: true,
  futuroToleradoMs: FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS,
};

/** The queue dispatch this run is: its 0-based attempt and its task id. */
export interface RegistroPrecoAmazon {
  readonly tentativa: number;
  readonly idTarefa: string | null;
}

/** The context loader, as `core/contexto.ts` exports it (`loadAmazonContext`). */
export type CarregadorDeContextoPrecoAmazon = (
  db: Firestore,
  integracaoId: string,
  deps: ContextoAmazonDeps,
) => Promise<ContextoAmazon>;

/** Everything one dispatch needs — bound by the jobs root, doubles in the tests. */
export interface DepsProcessarPrecoAmazon {
  readonly db: Firestore;
  /** The process environment: the read switch, the LWA pair, the price valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS (the budget, the plan's instant, the outcome's `emMs`). */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The context loader (the read switch FIRST). */
  readonly carregarContexto: CarregadorDeContextoPrecoAmazon;
  /** The price producer (the check, the wait, the pause) — built only when one is due. */
  readonly produtor: () => ProdutorPrecoAmazon;
  /** The validation-preview flag (`AMAZON_PRECO_SO_VALIDACAO`), as the root read it. */
  readonly soValidacao: boolean;
  readonly registro: RegistroPrecoAmazon;
  /** Test seams, forwarded to the context and the write engine as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/**
 * The preview flag of ONE dispatch, as the jobs root binds it into
 * {@link DepsProcessarPrecoAmazon.soValidacao}: `env.ts`'s one reader over the
 * dispatch's own environment, exactly `1` ⇒ on. Any other non-empty value is
 * OFF, so this dispatch's PATCH would be REAL: ONE WARNING says so, naming the
 * flag and the token `ignorado`, never the value.
 */
export function soValidacaoDoDespachoPrecoAmazon(
  ambiente: AmbienteAmazon,
  logger: LoggerAmazon,
  registro: RegistroPrecoAmazon,
): boolean {
  const lida = lerPrecoSoValidacaoAmazon(ambiente);
  if (lida.leitura === LEITURA_PRECO_SO_VALIDACAO_AMAZON.ignorado) {
    registrarEventoAmazon(
      logger,
      'preco',
      'WARNING',
      `[amazon] tarefa de preço: ${PRECO_SO_VALIDACAO_ENV} ignorada (só o valor exato 1 liga a prévia)`,
      { etapa: 'previa', previa: false, leitura: lida.leitura },
      { fluxo: FLUXO_AMAZON.preco, tentativa: registro.tentativa, idTarefa: registro.idTarefa },
    );
  }
  return lida.ligado;
}

/** What one dispatch did (closed). */
export type AcaoTarefaPrecoAmazon =
  /** P0: the payload is not this task's — dropped, WARNING. */
  | 'payload-invalido'
  /**
   * Ended with no PATCH sent: the valve, a refusal, an equal offer, a check's
   * refinement — or a check's re-send not handed back (`reenvioPerdido`).
   */
  | 'encerrado'
  /** A dry-run (or `on` outside the canary): the live read and the engine's diff line only. */
  | 'simulado'
  /** ONE PATCH, and Amazon answered it (a validation preview included). */
  | 'enviado'
  /** A healthy price feed in flight: the same payload re-enqueued unnamed. */
  | 'aguardando'
  /** A 429: the same payload re-enqueued unnamed, no attempt spent. */
  | 'pausado'
  /** A deliberate throw for the queue's retry (a transient, the budget, a PATCH that may have landed). */
  | 'retentar';

export const ACAO_TAREFA_PRECO_AMAZON = {
  payloadInvalido: 'payload-invalido',
  encerrado: 'encerrado',
  simulado: 'simulado',
  enviado: 'enviado',
  aguardando: 'aguardando',
  pausado: 'pausado',
  retentar: 'retentar',
} as const satisfies Record<string, AcaoTarefaPrecoAmazon>;

/** A side effect lost INSIDE the no-throw boundary, or a wait's re-enqueue refused. */
export type EfeitoPerdidoPrecoAmazon = 'gravacao' | 'aviso' | 'verificacao' | 'pausa' | 'espera';

/** What the outcome write-back came to. */
export type GravacaoPrecoAmazon = 'gravada' | 'mantida' | 'perdida';

/** What the check's enqueue came to. */
export type VerificacaoPrecoAmazon =
  | ResultadoEnfileiramentoPrecoAmazon
  /** Amazon's `submissionId` is absent or outside the task-name grammar: no check. */
  | 'sem-submissao'
  /** The enqueue failed inside the no-throw boundary (`perda` names it). */
  | 'perdida';

/** Amazon's offer as the live read saw it, for the line. */
export interface OfertaLidaPrecoAmazon {
  readonly tipo: OfertaListingAmazon['tipo'];
  readonly base: number | null;
  readonly minimo: number | null;
  readonly maximo: number | null;
  readonly temPrecoComDesconto: boolean;
  readonly temOfertaB2B: boolean;
  readonly fechada: boolean;
}

/** The dispatch's result, logged ONCE ({@link registrarDespachoPrecoAmazon}). */
export interface ResultadoTarefaPrecoAmazon {
  readonly acao: AcaoTarefaPrecoAmazon;
  /** The closed outcome; `null` only for `payload-invalido`. */
  readonly motivo: MotivoPrecoAmazon | null;
  readonly contaId: string | null;
  readonly sku: string | null;
  readonly origem: OrigemTarefaPrecoAmazon | null;
  /** The faixa this dispatch sends (or would): computed NOW, or a check's stored offer. */
  readonly faixa: FaixaPrecoAmazon | null;
  /** Amazon's live offer, once read. */
  readonly oferta: OfertaLidaPrecoAmazon | null;
  /** `our_price`, from the plan's reference to the faixa. */
  readonly direcao: DirecaoPrecoAmazon | null;
  /** Why the plan writes (`null` when it does not, or was never made). */
  readonly regra: RegraEscritaPrecoAmazon | null;
  /** The listing's product type the PATCH carries, once read and legible. */
  readonly tipoProduto: string | null;
  /** Why a dry-run did not write (the valve, the canary). */
  readonly dryRun: MotivoDryRunAmazon | null;
  /** The preview flag shaped the valve: every PATCH is a validation preview. */
  readonly previa: boolean;
  /** `validacao-com-todos` when the flag met `on` + `*` (an ERROR line). */
  readonly veredito: VereditoValvulaPrecoAmazon | null;
  /** How the price lease read (`ilegivel` when it does not parse). */
  readonly vez: TipoTomadaDaVez | 'ilegivel' | null;
  /** A run's task found its part or its member gone (every decrease refused). */
  readonly parteAusente: boolean;
  /** Amazon's submission status, raw (the line keeps only the ones it reads). */
  readonly status: string | null;
  /** The answer's issue codes, raw (the line keeps them through their grammar). */
  readonly problemas: readonly string[];
  /** An HTTP failure's codes, raw (the line keeps only the closed ones). */
  readonly codigos: readonly string[];
  /** The shared ladder's token of a read-side failure. */
  readonly falha: FalhaLeituraAmazon | null;
  /** A failure's CLASS (and gRPC/SDK code) — never its message. */
  readonly erro: string | null;
  /** The lowest `x-amzn-RateLimit-Limit` of the answers; `null` when none carried it. */
  readonly limiteTaxa: number | null;
  /** The shapes the verdict and the gate only COUNT. */
  readonly contagens: readonly string[];
  /** The outcome write-back (or a check's refinement), when one ran. */
  readonly gravacao: GravacaoPrecoAmazon | null;
  readonly gravados: number | null;
  readonly emConflito: number | null;
  /** Whether a conta aviso was raised. */
  readonly avisoLevantado: boolean;
  readonly verificacao: VerificacaoPrecoAmazon | null;
  /**
   * A check's re-send ended after its own write-ahead landed, without being
   * handed back (module header, P10): the SKU's next push re-sends it.
   */
  readonly reenvioPerdido: boolean;
  /** The first side effect lost, and its class. */
  readonly perda: { readonly efeito: EfeitoPerdidoPrecoAmazon; readonly erro: string } | null;
}

/**
 * The budget before the PATCH was spent (module header, P7): NOTHING was sent.
 * Its own class, so the retry it asks for is never mistaken for a PATCH that
 * may have landed.
 */
export class AmazonPrecoPrazoDaTarefaError extends Error {
  constructor() {
    super(
      '[amazon/preco] o orçamento da tarefa antes do PATCH acabou; nada foi enviado ' +
        '(a nova tentativa recalcula a faixa)',
    );
    this.name = 'AmazonPrecoPrazoDaTarefaError';
  }
}

/**
 * The write-ahead record did not land (module header, P7): a link doc still in
 * conflict after the shared write-back's attempts, or none written (a newer
 * outcome kept it out, or the link doc is gone). NO PATCH was sent. Thrown for
 * the queue's retry, which re-reads and re-decides, after the dispatch line
 * (`vinculo-mudou`, the write-back's counts): the shared write-back itself
 * writes a WARNING for a conflict only.
 */
export class AmazonPrecoRegistroPrevioPerdidoError extends Error {
  readonly gravados: number;
  readonly emConflito: number;

  constructor(gravacao: Pick<ResultadoGravacaoEnvioListingAmazon, 'gravados' | 'emConflito'>) {
    super(
      '[amazon/preco] o registro prévio do envio não foi gravado; nada foi enviado ' +
        '(a nova tentativa relê e decide de novo)',
    );
    this.name = 'AmazonPrecoRegistroPrevioPerdidoError';
    this.gravados = gravacao.gravados;
    this.emConflito = gravacao.emConflito;
  }
}

/* -------------------------------------------------------------------------- */
/*                               the dispatch line                            */
/* -------------------------------------------------------------------------- */

/** Ends a person must read the log for. */
const MOTIVOS_EM_WARNING: ReadonlySet<string> = new Set<string>([
  ...RECUSAS_VINCULO_PRECO_AMAZON,
  MOTIVO_PRECO_AMAZON.asinDivergente,
  MOTIVO_PRECO_AMAZON.contaIndisponivel,
  MOTIVO_PRECO_AMAZON.contaSemTabelaNormal,
  MOTIVO_PRECO_AMAZON.semPreco,
  MOTIVO_PRECO_AMAZON.faixaInvertida,
  MOTIVO_PRECO_AMAZON.tipoProdutoIlegivel,
  MOTIVO_PRECO_AMAZON.reducaoSemConsentimento,
  MOTIVO_PRECO_AMAZON.reducaoAposPagina,
  MOTIVO_PRECO_AMAZON.precoAtualIlegivel,
  MOTIVO_PRECO_AMAZON.recusado,
  MOTIVO_PRECO_AMAZON.escritaIncerta,
  MOTIVO_PRECO_AMAZON.prazoDaTarefa,
  MOTIVO_PRECO_AMAZON.leituraFalhou,
  MOTIVO_PRECO_AMAZON.vinculoMudou,
]);

/** The dispatch line's severity: ERROR for a definite failure or a misused flag, WARNING whenever a person has to look. */
export function severidadeDoDespachoPrecoAmazon(r: ResultadoTarefaPrecoAmazon): SeveridadeAmazon {
  if (r.motivo === MOTIVO_PRECO_AMAZON.escritaFalhou || r.veredito !== null) return 'ERROR';
  // A check's re-send that could not be handed back: only the next push re-sends it.
  if (r.reenvioPerdido) return 'WARNING';
  // A definite read failure (not a transient the retry absorbs) is an ERROR too.
  if (
    r.motivo === MOTIVO_PRECO_AMAZON.leituraFalhou &&
    r.acao === ACAO_TAREFA_PRECO_AMAZON.encerrado
  ) {
    return 'ERROR';
  }
  if (
    r.acao === ACAO_TAREFA_PRECO_AMAZON.payloadInvalido ||
    r.avisoLevantado ||
    r.perda !== null ||
    r.gravacao === 'perdida' ||
    r.falha === FALHA_LEITURA_AMAZON.chamadasDesligadas
  ) {
    return 'WARNING';
  }
  return r.motivo !== null && MOTIVOS_EM_WARNING.has(r.motivo) ? 'WARNING' : 'INFO';
}

/** Amazon's submission status as the line keeps it: the three it reads, else `<outro>`. */
function statusSeguro(status: string | null): string | null {
  if (status === null) return null;
  return (Object.values(STATUS_ENVIO_PRECO_AMAZON) as readonly string[]).includes(status)
    ? status
    : CODIGO_OUTRO;
}

/** A listings issue code through its grammar, else `<outro>`. */
function problemaSeguro(codigo: string): string {
  return passaPredicadoAmazon('codigoListing', codigo) ? codigo : CODIGO_OUTRO;
}

/** A list as one campo: joined with `,`, `null` when empty. */
function juntar(lista: readonly string[]): string | null {
  return lista.length === 0 ? null : lista.join(',');
}

/**
 * The ONE `evento: 'preco'` dispatch line (module header, P11): ids, closed
 * codes, prices and counts only.
 */
export function registrarDespachoPrecoAmazon(
  logger: LoggerAmazon,
  r: ResultadoTarefaPrecoAmazon,
  registro: RegistroPrecoAmazon,
): void {
  const campos: CamposLogAmazon = {
    fila: FILA_LOTES_AMAZON,
    acao: r.acao,
    motivo: r.motivo,
    origem: r.origem,
    sku: r.sku,
    faixaBase: r.faixa?.base ?? null,
    faixaMinimo: r.faixa?.minimo ?? null,
    faixaMaximo: r.faixa?.maximo ?? null,
    oferta: r.oferta?.tipo ?? null,
    ofertaBase: r.oferta?.base ?? null,
    ofertaMinimo: r.oferta?.minimo ?? null,
    ofertaMaximo: r.oferta?.maximo ?? null,
    direcao: r.direcao,
    regra: r.regra,
    temPrecoComDesconto: r.oferta?.temPrecoComDesconto ?? null,
    temOfertaB2B: r.oferta?.temOfertaB2B ?? null,
    fechada: r.oferta?.fechada ?? null,
    tipoProduto: r.tipoProduto,
    dryRun: r.dryRun,
    previa: r.previa,
    veredito: r.veredito,
    vez: r.vez,
    parteAusente: r.parteAusente,
    status: statusSeguro(r.status),
    problemas: juntar(r.problemas.map(problemaSeguro)),
    codigos: juntar(r.codigos.map(codigoDeErroSeguro)),
    falha: r.falha,
    erro: r.erro,
    limiteTaxa: r.limiteTaxa,
    contagens: juntar(r.contagens),
    gravacao: r.gravacao,
    gravados: r.gravados,
    emConflito: r.emConflito,
    avisoLevantado: r.avisoLevantado,
    verificacao: r.verificacao,
    reenvioPerdido: r.reenvioPerdido,
    perda: r.perda?.efeito ?? null,
    erroPerda: r.perda?.erro ?? null,
  };
  registrarEventoAmazon(
    logger,
    'preco',
    severidadeDoDespachoPrecoAmazon(r),
    `[amazon] tarefa de preço: ${r.acao}`,
    campos,
    {
      conta: r.contaId,
      fluxo: FLUXO_AMAZON.preco,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                           one dispatch's own state                         */
/* -------------------------------------------------------------------------- */

/** The send a plan makes: the faixa and the listing's product type. */
interface EnvioPlanejadoPrecoAmazon {
  readonly faixa: FaixaPrecoAmazon;
  readonly tipoProduto: string;
}

/** The engine's plan of this task (module header, P7). */
interface PlanoTarefaPrecoAmazon {
  readonly escrever: boolean;
  readonly diff: CamposLogAmazon;
  /** Why the task ends when it does not write. */
  readonly motivo: MotivoPrecoAmazon;
  /** The PATCH, when it writes. */
  readonly envio: EnvioPlanejadoPrecoAmazon | null;
  /** A check's verdict onto the entry it checks, with no PATCH. */
  readonly refino: ResultadoEnvioEstoqueAmazon | null;
  /** The price-issue codes of this read: what a check of the send carries. */
  readonly codigosAntes: readonly string[];
  /** The live read's price issues: what a check's refinement stores. */
  readonly issuesDePreco: readonly IssueListingAmazon[];
}

/** A dispatch in flight: its payload, its start, and what it learned so far. */
interface Execucao {
  readonly deps: DepsProcessarPrecoAmazon;
  readonly t: TarefaPrecoSkuAmazon;
  /** ms — when the dispatch began (the budget's origin). */
  readonly inicioMs: number;
  previa: boolean;
  veredito: VereditoValvulaPrecoAmazon | null;
  vez: TipoTomadaDaVez | 'ilegivel' | null;
  parteAusente: boolean;
  faixa: FaixaPrecoAmazon | null;
  oferta: OfertaLidaPrecoAmazon | null;
  direcao: DirecaoPrecoAmazon | null;
  regra: RegraEscritaPrecoAmazon | null;
  tipoProduto: string | null;
  plano: PlanoTarefaPrecoAmazon | null;
  /** Every `x-amzn-RateLimit-Limit` an answer carried. */
  taxas: number[];
  contagens: string[];
  perda: ResultadoTarefaPrecoAmazon['perda'];
  /**
   * A check's re-send whose own write-ahead landed: that record replaced the
   * entry the check is bound to, so this payload is never handed back (module
   * header, P10).
   */
  semVolta: boolean;
}

/** A result for `e`, every field not given taken from what the dispatch learned. */
function resultado(
  e: Execucao,
  r: Partial<Omit<ResultadoTarefaPrecoAmazon, 'acao' | 'motivo'>> & {
    readonly acao: AcaoTarefaPrecoAmazon;
    readonly motivo: MotivoPrecoAmazon;
  },
): ResultadoTarefaPrecoAmazon {
  return {
    contaId: e.t.contaId,
    sku: e.t.sku,
    origem: e.t.origem,
    faixa: e.faixa,
    oferta: e.oferta,
    direcao: e.direcao,
    regra: e.regra,
    tipoProduto: e.tipoProduto,
    dryRun: null,
    previa: e.previa,
    veredito: e.veredito,
    vez: e.vez,
    parteAusente: e.parteAusente,
    status: null,
    problemas: [],
    codigos: [],
    falha: null,
    erro: null,
    limiteTaxa: e.taxas.length === 0 ? null : Math.min(...e.taxas),
    contagens: [...new Set(e.contagens)].sort(),
    gravacao: null,
    gravados: null,
    emConflito: null,
    avisoLevantado: false,
    verificacao: null,
    reenvioPerdido: false,
    perda: e.perda,
    ...r,
  };
}

/** An end with no PATCH sent. */
function encerrar(
  e: Execucao,
  motivo: MotivoPrecoAmazon,
  extra: Partial<ResultadoTarefaPrecoAmazon> = {},
): ResultadoTarefaPrecoAmazon {
  return resultado(e, { ...extra, acao: ACAO_TAREFA_PRECO_AMAZON.encerrado, motivo });
}

/**
 * A deliberate throw for the queue's retry, carrying the line to write first:
 * module-private, so the one catch that reads it (in
 * {@link processarPrecoSkuAmazon}) narrows by THIS class and rethrows `causa`.
 */
class RetentativaPrecoAmazon extends Error {
  readonly resultado: ResultadoTarefaPrecoAmazon;
  readonly causa: unknown;

  constructor(resultado: ResultadoTarefaPrecoAmazon, causa: unknown) {
    super('[amazon/preco] nova tentativa da tarefa de preço');
    this.name = 'RetentativaPrecoAmazon';
    this.resultado = resultado;
    this.causa = causa;
  }
}

/**
 * A check's re-send that cannot be handed back (module header, P10): the end
 * it would have retried or paused, kept as the line's motivo, with NOTHING
 * re-enqueued and no throw.
 */
function reenvioPerdido(
  e: Execucao,
  motivo: MotivoPrecoAmazon,
  extra: Partial<ResultadoTarefaPrecoAmazon>,
): ResultadoTarefaPrecoAmazon {
  return resultado(e, {
    ...extra,
    acao: ACAO_TAREFA_PRECO_AMAZON.encerrado,
    motivo,
    reenvioPerdido: true,
  });
}

/**
 * Write the line, then throw `causa` for the queue's retry — unless this is a
 * check's re-send past its own write-ahead, whose retry could only stand down:
 * then it ends here ({@link reenvioPerdido}).
 */
function retentar(
  e: Execucao,
  motivo: MotivoPrecoAmazon,
  causa: unknown,
  extra: Partial<ResultadoTarefaPrecoAmazon> = {},
): ResultadoTarefaPrecoAmazon {
  if (e.semVolta) return reenvioPerdido(e, motivo, extra);
  throw new RetentativaPrecoAmazon(
    resultado(e, { ...extra, acao: ACAO_TAREFA_PRECO_AMAZON.retentar, motivo }),
    causa,
  );
}

/* -------------------------------------------------------------------------- */
/*                         the no-throw boundary (P8–P10)                      */
/* -------------------------------------------------------------------------- */

/**
 * The failures the no-throw boundary contains (module header): the listings
 * flows' shared classifier bound to the jobs producer's own classes. Anything
 * else is an unnamed bug, and crosses.
 */
const ehFalhaContida = falhaContidaListingAmazon([
  AmazonLotesTarefasDesligadasError,
  AmazonLotesRegiaoDaFilaInvalidaError,
]);

/** ONE side effect inside the boundary: its value, or `null` with the FIRST loss recorded. */
function protegido<T>(
  e: Execucao,
  efeito: EfeitoPerdidoPrecoAmazon,
  fn: () => Promise<T>,
): Promise<T | null> {
  return contidoListingAmazon(fn, ehFalhaContida, (erro) => {
    e.perda ??= { efeito, erro };
  });
}

/**
 * One price outcome onto every link doc of the SKU (the `dono`'s, by path).
 * `agoraMs` is the clock the future tolerance is measured from: the
 * write-ahead passes the instant its own `emMs` was placed by.
 */
function gravarEnvio(
  e: Execucao,
  vinculo: VinculoAptoListingAmazon<EnvioPrecoAmazon>,
  envio: EnvioPrecoAmazon,
  agoraMs: number = e.deps.agora(),
): Promise<ResultadoGravacaoEnvioListingAmazon> {
  return gravarEnvioListingAmazon(
    e.deps.db,
    CAMPO_DO_ENVIO_PRECO_AMAZON,
    {
      contaId: e.t.contaId,
      sku: e.t.sku,
      links: vinculo.linkIds.map((linkId) => ({ produtoId: vinculo.donoId, linkId })),
      envio,
      agoraMs,
    },
    { logger: e.deps.logger },
  );
}

/** Raise one of the price flow's conta avisos, clocked by `relogio`, inside the boundary. */
async function levantarAviso(
  e: Execucao,
  motivo: MotivoContaPrecoAmazon,
  relogio: Timestamp,
): Promise<boolean> {
  const r = await protegido(e, 'aviso', () =>
    sincronizarAvisoContaListingsAmazon(
      e.deps.db,
      { increment: e.deps.increment, nowMs: e.deps.agora(), logger: e.deps.logger },
      {
        fluxo: FLUXO_LISTING_AMAZON.preco,
        integracaoId: e.t.contaId,
        motivo,
        acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.levantar,
        relogio,
      },
    ),
  );
  return r !== null;
}

/** What a write-back came to, for the line (module header, P8). */
function gravacaoDe(g: ResultadoGravacaoEnvioListingAmazon | null): GravacaoPrecoAmazon {
  if (g === null || g.emConflito > 0) return 'perdida';
  return g.gravados > 0 ? 'gravada' : 'mantida';
}

/** Whether an outcome is, or may be, the link's latest: written, or still in conflict. */
function podeSerOUltimo(
  g: ResultadoGravacaoEnvioListingAmazon | null,
): g is ResultadoGravacaoEnvioListingAmazon & {
  readonly relogio: Timestamp;
} {
  return g !== null && g.relogio !== null && (g.gravados > 0 || g.emConflito > 0);
}

/* -------------------------------------------------------------------------- */
/*                              the stored outcomes                            */
/* -------------------------------------------------------------------------- */

/** A non-empty string, or `null`. */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** The issues an outcome keeps, in the link shape: `ERROR` ones first, at most the cap. */
function problemasGuardados(issues: readonly IssueListingAmazon[]) {
  const erros = issues.filter((i) => i.severity === SEVERIDADE_ERRO_AMAZON);
  const outros = issues.filter((i) => i.severity !== SEVERIDADE_ERRO_AMAZON);
  return [...erros, ...outros].slice(0, MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON).map((i) => ({
    code: i.code ?? null,
    message: i.message ?? null,
    severity: i.severity ?? null,
    attributeNames: i.attributeNames ? [...i.attributeNames] : null,
    categories: i.categories ? [...i.categories] : null,
  }));
}

/**
 * The write-ahead record's `emMs` (module header, P7): our clock `agoraMs`,
 * raised past every stored outcome on the SKU's link docs (`guardados`, the raw
 * `envioPrecoAmazon` values of P4's read) and past this dispatch's own earlier
 * record, so the record is the link's newest and the shared write-back never
 * keeps it out. Each stored value counts by the shared decision's own reading
 * (`marcaDaguaEnvioListing`, at the SAME clock the write-back is handed): its
 * raw `emMs`, even when the rest of the entry does not parse, and nothing when
 * it sits further ahead than {@link FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS}
 * (the write-back sets it aside).
 */
export function instanteDoRegistroPrevio(
  agoraMs: number,
  previoMs: number | null,
  guardados: readonly unknown[],
): number {
  let emMs = previoMs === null ? agoraMs : Math.max(agoraMs, previoMs + 1);
  for (const guardado of guardados) {
    const marca = marcaDaguaEnvioListing(guardado, {
      futuroToleradoMs: FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS,
      agoraMs,
    });
    if (marca !== null) emMs = Math.max(emMs, marca + 1);
  }
  return emMs;
}

/** The record written AHEAD of a PATCH, and of a PATCH whose answer is unknown (module header). */
function envioIncerto(emMs: number, faixa: FaixaPrecoAmazon): EnvioPrecoAmazon {
  return envioPrecoAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    oferta: faixa,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
    submissionId: null,
    feedId: null,
    problemas: [],
  });
}

/** The outcome of a PATCH Amazon answered (module header, P8). */
function envioDaResposta(
  status: string | null,
  submissionId: string | null,
  issues: readonly IssueListingAmazon[],
  emMs: number,
  faixa: FaixaPrecoAmazon,
): EnvioPrecoAmazon {
  let resultadoDoEnvio: ResultadoEnvioEstoqueAmazon;
  if (status === STATUS_ENVIO_PRECO_AMAZON.aceito) {
    resultadoDoEnvio =
      issues.length > 0
        ? RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos
        : RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito;
  } else if (status === STATUS_ENVIO_PRECO_AMAZON.invalido) {
    resultadoDoEnvio = RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado;
  } else {
    // A 2xx that tells nothing about whether the offer applied.
    return envioIncerto(emMs, faixa);
  }
  return envioPrecoAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    oferta: faixa,
    resultado: resultadoDoEnvio,
    submissionId,
    feedId: null,
    problemas: problemasGuardados(issues),
  });
}

/* -------------------------------------------------------------------------- */
/*                                the outcome (P8, P9)                         */
/* -------------------------------------------------------------------------- */

/** The price issues of a read, in the package's issue shape. */
function issuesDePreco(issues: ListingAmazon['issues']): IssueListingAmazon[] {
  return (issues ?? []).filter((i) => ehIssuePrecoAmazon(i));
}

/** P8–P9: Amazon answered the PATCH; everything here is inside the boundary. */
async function respostaDoPatch(
  e: Execucao,
  vinculo: VinculoAptoListingAmazon<EnvioPrecoAmazon>,
  plano: PlanoTarefaPrecoAmazon,
  envioPlanejado: EnvioPlanejadoPrecoAmazon,
  emMs: number,
  resposta: EnvioComTaxaListingNaAmazon,
): Promise<ResultadoTarefaPrecoAmazon> {
  const status = textoNaoVazio(resposta.resposta.status);
  const issues = resposta.resposta.issues ?? [];
  const problemas = issues.map((i) => textoNaoVazio(i.code)).filter((c): c is string => c !== null);

  // Under the preview flag Amazon only validated: nothing to write back, no check.
  if (e.previa) {
    return resultado(e, {
      acao: ACAO_TAREFA_PRECO_AMAZON.enviado,
      motivo: MOTIVO_PRECO_AMAZON.previa,
      status,
      problemas,
    });
  }

  // P8: the outcome onto every link doc of the SKU.
  const submissionId = textoNaoVazio(resposta.resposta.submissionId);
  const envio = envioDaResposta(status, submissionId, issues, emMs, envioPlanejado.faixa);
  const gravacao = await protegido(e, 'gravacao', () => gravarEnvio(e, vinculo, envio));

  // P8: an INVALID with a BLOCKING price issue raises the conta aviso, clocked by
  // the write-back's read — only when this outcome is, or may be, the latest.
  let avisoLevantado = false;
  if (
    status === STATUS_ENVIO_PRECO_AMAZON.invalido &&
    temIssuePrecoBloqueanteAmazon(issues) &&
    podeSerOUltimo(gravacao)
  ) {
    avisoLevantado = await levantarAviso(
      e,
      MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
      gravacao.relogio,
    );
  }

  // P9: ONE check, only after ACCEPTED and a write-back that LANDED, never for
  // a check's own re-send.
  let verificacao: VerificacaoPrecoAmazon | null = null;
  if (
    status === STATUS_ENVIO_PRECO_AMAZON.aceito &&
    e.t.origem !== ORIGEM_TAREFA_PRECO_AMAZON.verificacao &&
    gravacao !== null &&
    gravacao.gravados > 0
  ) {
    if (submissionId === null || !REFERENCIA_SUBMISSAO_PRECO_REGEX.test(submissionId)) {
      verificacao = 'sem-submissao';
    } else {
      verificacao =
        (await protegido(e, 'verificacao', () =>
          e.deps.produtor().enfileirarVerificacao(e.t, submissionId, plano.codigosAntes),
        )) ?? 'perdida';
    }
  }

  const motivo =
    status === STATUS_ENVIO_PRECO_AMAZON.aceito || status === STATUS_ENVIO_PRECO_AMAZON.invalido
      ? MOTIVO_PRECO_AMAZON.enviado
      : MOTIVO_PRECO_AMAZON.escritaIncerta;
  return resultado(e, {
    acao: ACAO_TAREFA_PRECO_AMAZON.enviado,
    motivo,
    status,
    problemas,
    gravacao: gravacaoDe(gravacao),
    gravados: gravacao?.gravados ?? null,
    emConflito: gravacao?.emConflito ?? null,
    avisoLevantado,
    verificacao,
  });
}

/**
 * A check's verdict, refined onto the entry it checks (module header, P7):
 * the entry's own `emMs`, `via` and `submissionId`, with Amazon's verdict and
 * the read's price issues. No PATCH was sent. A refused or still-warned price
 * raises the conta aviso, clocked by the refinement's link-doc read.
 */
async function refinar(
  e: Execucao,
  vinculo: VinculoAptoListingAmazon<EnvioPrecoAmazon>,
  guardado: EnvioPrecoAmazon,
  plano: PlanoTarefaPrecoAmazon,
  refino: ResultadoEnvioEstoqueAmazon,
): Promise<ResultadoTarefaPrecoAmazon> {
  const envio = envioPrecoAmazonSchema.parse({
    ...guardado,
    resultado: refino,
    problemas: problemasGuardados(plano.issuesDePreco),
  });
  const gravacao = await gravarEnvio(e, vinculo, envio);
  let avisoLevantado = false;
  if (refino !== RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito && podeSerOUltimo(gravacao)) {
    avisoLevantado = await levantarAviso(
      e,
      MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
      gravacao.relogio,
    );
  }
  return encerrar(e, plano.motivo, {
    problemas: plano.issuesDePreco
      .map((i) => textoNaoVazio(i.code))
      .filter((c): c is string => c !== null),
    gravacao: gravacaoDe(gravacao),
    gravados: gravacao.gravados,
    emConflito: gravacao.emConflito,
    avisoLevantado,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  the failures (P10)                         */
/* -------------------------------------------------------------------------- */

/** An HTTP failure's codes, or none. */
function codigosDe(err: unknown): readonly string[] {
  return err instanceof AmazonHttpError ? err.codigosErro : [];
}

/**
 * A re-enqueue of the same payload, UNNAMED, and NO throw (a 429, a price feed
 * in flight). The re-enqueue itself failing with a NAMED class falls back to
 * the queue's OWN retry: nothing was sent, and a retry needs no enqueue. The
 * line is written first (`retentar`, the loss named); anything else crosses.
 */
async function reenfileirar(
  e: Execucao,
  efeito: 'pausa' | 'espera',
  extra: Partial<ResultadoTarefaPrecoAmazon>,
): Promise<ResultadoTarefaPrecoAmazon> {
  const motivo =
    efeito === 'pausa' ? MOTIVO_PRECO_AMAZON.pausado : MOTIVO_PRECO_AMAZON.aguardandoFeed;
  // A check's re-send past its own write-ahead: a paused copy could only stand down.
  if (e.semVolta) return reenvioPerdido(e, motivo, extra);
  const pausa = await pausarListingAmazon(
    () =>
      efeito === 'pausa'
        ? e.deps.produtor().enfileirarPausa(e.t)
        : e.deps.produtor().enfileirarEspera(e.t),
    ehFalhaContida,
  );
  if (pausa.tipo === 'retentar') {
    e.perda ??= { efeito, erro: pausa.classe };
    return retentar(e, motivo, pausa.causa, extra);
  }
  return resultado(e, {
    ...extra,
    acao:
      efeito === 'pausa' ? ACAO_TAREFA_PRECO_AMAZON.pausado : ACAO_TAREFA_PRECO_AMAZON.aguardando,
    motivo,
  });
}

/** A read-side failure (the context, or the live read before the PATCH): nothing was sent. */
async function falhaDeLeitura(e: Execucao, err: unknown): Promise<ResultadoTarefaPrecoAmazon> {
  const falha = classificarFalhaDeLeituraAmazon(err);
  if (err instanceof AmazonThrottleError && err.limiteTaxa !== null) e.taxas.push(err.limiteTaxa);
  const extra: Partial<ResultadoTarefaPrecoAmazon> = {
    falha,
    erro: classeDaFalhaListingAmazon(err),
    codigos: codigosDe(err),
  };
  switch (falha) {
    case FALHA_LEITURA_AMAZON.pausa:
      return reenfileirar(e, 'pausa', extra);
    case FALHA_LEITURA_AMAZON.transitorio:
      return retentar(e, MOTIVO_PRECO_AMAZON.leituraFalhou, err, extra);
    case FALHA_LEITURA_AMAZON.chamadasDesligadas:
      return encerrar(e, MOTIVO_PRECO_AMAZON.desligado, extra);
    case FALHA_LEITURA_AMAZON.contaInativa:
    case FALHA_LEITURA_AMAZON.contaIndisponivel:
    case FALHA_LEITURA_AMAZON.authLwa:
      return encerrar(e, MOTIVO_PRECO_AMAZON.contaIndisponivel, extra);
    case FALHA_LEITURA_AMAZON.authSpApi:
    case FALHA_LEITURA_AMAZON.naoEncontrado:
    case FALHA_LEITURA_AMAZON.httpDefinitivo:
    case FALHA_LEITURA_AMAZON.esquema:
    case FALHA_LEITURA_AMAZON.ilegivel:
      return encerrar(e, MOTIVO_PRECO_AMAZON.leituraFalhou, extra);
    case FALHA_LEITURA_AMAZON.relancar:
      // A Firestore error, the LWA pair missing, a bug: the queue retries it.
      throw err;
  }
}

/** A failure once the PATCH was reached (module header, P10). */
async function falhaDeEscrita(e: Execucao, err: unknown): Promise<ResultadoTarefaPrecoAmazon> {
  const extra: Partial<ResultadoTarefaPrecoAmazon> = {
    erro: classeDaFalhaListingAmazon(err),
    codigos: codigosDe(err),
  };
  // A 429 was not processed.
  if (err instanceof AmazonThrottleError) {
    if (err.limiteTaxa !== null) e.taxas.push(err.limiteTaxa);
    return reenfileirar(e, 'pausa', extra);
  }
  // It MAY HAVE LANDED: the write-ahead record already says so (a preview
  // persists nothing either way), so the retry treats it as a recent send.
  if (envioTalvezAplicadoListingAmazon(err)) {
    return retentar(e, MOTIVO_PRECO_AMAZON.escritaIncerta, err, extra);
  }
  // Amazon answered the PATCH with a definite refusal: a 4xx (a second 401/403
  // after the forced refresh included). The write-ahead stays: it can only ADD
  // a send.
  if (envioRecusadoListingAmazon(err)) {
    return encerrar(e, MOTIVO_PRECO_AMAZON.escritaFalhou, extra);
  }
  // Not the PATCH's own answer (the forced refresh's LWA exchange, a parked
  // credential the getter refused): nothing was sent — the read ladder.
  return falhaDeLeitura(e, err);
}

/* -------------------------------------------------------------------------- */
/*                                  the reads                                  */
/* -------------------------------------------------------------------------- */

/** Where a run's task stands towards its run (module header, P2). */
type PosseDaExecucao = 'propria' | 'substituida' | 'cancelada';

/**
 * A run's task's run, by id, masked to {@link CAMPOS_EXECUCAO_TAREFA_PRECO_AMAZON}
 * (module header, P2): no run or another run's id ⇒ `substituida`; a phase
 * that is not `decidindo` or `concluida` (an unreadable one included) ⇒
 * `cancelada`.
 */
async function lerPosseDaExecucao(
  db: Firestore,
  contaId: string,
  execucaoId: string,
): Promise<PosseDaExecucao> {
  const [snap] = await db.getAll(precoAmazonCollection.docRef(db, {}, contaId), {
    fieldMask: [...CAMPOS_EXECUCAO_TAREFA_PRECO_AMAZON],
  });
  if (snap?.exists !== true) return 'substituida';
  const raw = (snap.data() ?? {}) as Readonly<Record<string, unknown>>;
  if (raw.execucaoId !== execucaoId) return 'substituida';
  const fase = faseExecucaoPrecoAmazonSchema.safeParse(raw.fase);
  return fase.success &&
    (fase.data === FASE_EXECUCAO_PRECO_AMAZON.decidindo ||
      fase.data === FASE_EXECUCAO_PRECO_AMAZON.concluida)
    ? 'propria'
    : 'cancelada';
}

/** The price lease as P2 reads it. */
interface VezLidaPrecoAmazon {
  /** The parsed lease (`null`: no document), or `ilegivel` when it does not parse. */
  readonly vez: VezFeedAmazon | null | 'ilegivel';
  /** ms — the end of the conta's last price feed that may have applied; `null` when none. */
  readonly feedRecenteEmMs: number | null;
}

/** A ms instant a writer could have stamped, or `null`. */
function msOuNulo(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

/**
 * The PRICE lease, ONE by-id read masked to {@link CAMPOS_VEZ_TAREFA_PRECO_AMAZON}
 * (module header, P2). A document that does not parse reads `ilegivel`, its
 * feed end still read field by field.
 */
async function lerVezPreco(db: Firestore, contaId: string): Promise<VezLidaPrecoAmazon> {
  const ref = vezFeedAmazonCollection.docRef(
    db,
    {},
    idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, contaId),
  );
  const [snap] = await db.getAll(ref, { fieldMask: [...CAMPOS_VEZ_TAREFA_PRECO_AMAZON] });
  if (snap?.exists !== true) return { vez: null, feedRecenteEmMs: null };
  const raw: unknown = snap.data() ?? {};
  const lida = vezFeedAmazonSchema.safeParse(raw);
  if (!lida.success) {
    return {
      vez: 'ilegivel',
      feedRecenteEmMs: msOuNulo((raw as Readonly<Record<string, unknown>>).ultimoFeedConcluidoEmMs),
    };
  }
  return { vez: lida.data, feedRecenteEmMs: lida.data.ultimoFeedConcluidoEmMs };
}

/** The conta's tabelas as P3 reads them, and the read's clock. */
interface ContaLidaPrecoAmazon {
  readonly tabelas: TabelasDePrecoAmazon;
  readonly relogio: Timestamp | null;
}

/**
 * The conta RAW, ONE by-id read masked to {@link CAMPOS_CONTA_PRECO_AMAZON},
 * never cached (module header, P3); its `readTime` clocks the faixa aviso.
 */
async function lerTabelasDaConta(db: Firestore, contaId: string): Promise<ContaLidaPrecoAmazon> {
  const [snap] = await db.getAll(integracaoCollection.docRef(db, {}, contaId), {
    fieldMask: [...CAMPOS_CONTA_PRECO_AMAZON],
  });
  return {
    tabelas: tabelasDePrecoDaContaAmazon(snap?.exists === true ? snap.data() : null),
    relogio: snap?.readTime ?? null,
  };
}

/**
 * A run's task's floor (module header, P5): its part by id, masked to its
 * members, and the member of this SKU's page-time `base`; a part or a member
 * that is gone (or does not parse) ⇒ `desconhecido`.
 */
async function lerPisoDaParte(
  db: Firestore,
  t: TarefaPrecoSkuAmazon,
): Promise<PisoConsentimentoPrecoAmazon> {
  if (t.parte === null) return PISO_DESCONHECIDO_PRECO_AMAZON;
  const ref = divergenciaPrecoAmazonCollection.docRef(
    db,
    { contaId: t.contaId },
    idDivergenciaPrecoAmazon(t.referencia, t.parte),
  );
  const [snap] = await db.getAll(ref, { fieldMask: [CAMPO_ITENS_PARTE_PRECO_AMAZON] });
  if (snap?.exists !== true) return PISO_DESCONHECIDO_PRECO_AMAZON;
  const itens: unknown = (snap.data() ?? {})[CAMPO_ITENS_PARTE_PRECO_AMAZON];
  if (!Array.isArray(itens)) return PISO_DESCONHECIDO_PRECO_AMAZON;
  for (const bruto of itens) {
    const item = itemDivergenciaPrecoAmazonSchema.safeParse(bruto);
    if (item.success && item.data.sku === t.sku) return item.data.faixa.base;
  }
  return PISO_DESCONHECIDO_PRECO_AMAZON;
}

/* -------------------------------------------------------------------------- */
/*                                 the plan (P7)                               */
/* -------------------------------------------------------------------------- */

/** A link verdict's refusal as a price motivo (the stock flow's fifth never reaches price). */
function motivoDoVinculo(motivo: RecusaVinculoListingAmazon): MotivoPrecoAmazon {
  if (motivo === MOTIVO_VINCULO_LISTING_AMAZON.envioDesligado) {
    throw new TypeError('processarPreco.ts: um veredicto de preço nunca recusa envio-desligado');
  }
  return motivo;
}

/** What the plan needs besides the live read (module header, P7). */
interface EntradaPlanoTarefaPrecoAmazon {
  readonly vinculo: VinculoAptoListingAmazon<EnvioPrecoAmazon>;
  /** The faixa the ERP computes NOW. */
  readonly faixaAtual: FaixaPrecoAmazon;
  /** The entry a check checks (its offer is what it re-sends); `null` for a send. */
  readonly guardado: (EnvioPrecoAmazon & { readonly oferta: FaixaPrecoAmazon }) | null;
  readonly piso: PisoConsentimentoPrecoAmazon;
  readonly feedRecenteEmMs: number | null;
}

/** The dry-run line's campos of a plan: prices, closed codes and flags only. */
function diffDoPlano(e: Execucao, motivo: MotivoPrecoAmazon): CamposLogAmazon {
  return {
    motivo,
    origem: e.t.origem,
    direcao: e.direcao,
    regra: e.regra,
    faixaBase: e.faixa?.base ?? null,
    faixaMinimo: e.faixa?.minimo ?? null,
    faixaMaximo: e.faixa?.maximo ?? null,
    oferta: e.oferta?.tipo ?? null,
    ofertaBase: e.oferta?.base ?? null,
    ofertaMinimo: e.oferta?.minimo ?? null,
    ofertaMaximo: e.oferta?.maximo ?? null,
    tipoProduto: e.tipoProduto,
  };
}

/** The plan of this task over Amazon's live read (module header, P7). */
function planejarTarefa(
  e: Execucao,
  leitura: LeituraListingAmazon,
  entrada: EntradaPlanoTarefaPrecoAmazon,
): PlanoTarefaPrecoAmazon {
  const nada = (
    motivo: MotivoPrecoAmazon,
    extra: Partial<PlanoTarefaPrecoAmazon> = {},
  ): PlanoTarefaPrecoAmazon => ({
    escrever: false,
    diff: diffDoPlano(e, motivo),
    motivo,
    envio: null,
    refino: null,
    codigosAntes: [],
    issuesDePreco: [],
    ...extra,
  });

  // The shared listing gate: no flow-own refusal for price.
  const gate = avaliarGateListingAmazon(leitura, {
    asinsDoVinculo: entrada.vinculo.asinsDoVinculo,
  });
  if (!gate.enviavel) return nada(gate.motivo);
  e.contagens.push(...gate.contagens);
  const { listing } = gate;
  const agoraMs = e.deps.agora();
  const oferta = ofertaDoListingAmazon(listing.attributes, agoraMs);
  const lida = oferta.tipo === TIPO_OFERTA_PRECO_AMAZON.lida ? oferta : null;
  e.oferta = {
    tipo: oferta.tipo,
    base: lida?.base ?? null,
    minimo: lida?.minimo ?? null,
    maximo: lida?.maximo ?? null,
    temPrecoComDesconto: oferta.temPrecoComDesconto,
    temOfertaB2B: oferta.temOfertaB2B,
    fechada: oferta.fechada,
  };
  const codigosAntes = codigosPrecoAmazon(listing.issues);
  const issues = issuesDePreco(listing.issues);
  const base = { codigosAntes, issuesDePreco: issues };

  // A check: Amazon's verdict on THAT send, or its one re-send.
  if (entrada.guardado !== null) {
    const decisao = planejarVerificacaoPrecoAmazon(
      entrada.faixaAtual,
      entrada.guardado.oferta,
      oferta,
      listing.issues,
      e.t.codigosAntes,
    );
    switch (decisao) {
      case DECISAO_VERIFICACAO_PRECO_AMAZON.erpMudou:
        return nada(MOTIVO_PRECO_AMAZON.erpMudou, base);
      case DECISAO_VERIFICACAO_PRECO_AMAZON.recusado:
        return nada(MOTIVO_PRECO_AMAZON.recusado, {
          ...base,
          refino: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
        });
      case DECISAO_VERIFICACAO_PRECO_AMAZON.aceito:
        return nada(MOTIVO_PRECO_AMAZON.aceito, {
          ...base,
          refino: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
        });
      case DECISAO_VERIFICACAO_PRECO_AMAZON.aceitoComAvisos:
        return nada(MOTIVO_PRECO_AMAZON.aceitoComAvisos, {
          ...base,
          refino: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos,
        });
      case DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar:
        break;
    }
  }

  // The listing's own product type.
  const tipoProduto = tipoProdutoDoListingPrecoAmazon(listing);
  if (tipoProduto === null) return nada(MOTIVO_PRECO_AMAZON.tipoProdutoIlegivel, base);
  e.tipoProduto = tipoProduto;

  // A send (a check's re-send sends the STORED offer, with no floor).
  const faixa = entrada.guardado?.oferta ?? entrada.faixaAtual;
  const plano = planejarPrecoAmazon(faixa, oferta, {
    buyable: compravelNoBrPrecoAmazon(listing),
    baixarPreco: e.t.baixarPreco,
    consentimentoValido: consentimentoValidoPrecoAmazon(e.t.solicitadoEmMs, agoraMs),
    pisoConsentimento: entrada.guardado === null ? entrada.piso : null,
    envioRecente: entrada.vinculo.envioRecente,
    feedRecenteEmMs: entrada.feedRecenteEmMs,
    agoraMs,
  });
  e.direcao = plano.direcao;
  e.regra = plano.regra;
  if (plano.decisao === DECISAO_PLANO_PRECO_AMAZON.escrever) {
    return {
      escrever: true,
      diff: diffDoPlano(e, MOTIVO_PRECO_AMAZON.enviado),
      motivo: MOTIVO_PRECO_AMAZON.enviado,
      envio: { faixa, tipoProduto },
      refino: null,
      ...base,
    };
  }
  return nada(plano.decisao, base);
}

/* -------------------------------------------------------------------------- */
/*                                the dispatch                                */
/* -------------------------------------------------------------------------- */

/** P0's drop: the payload is not this task's. */
function payloadInvalido(): ResultadoTarefaPrecoAmazon {
  return {
    acao: ACAO_TAREFA_PRECO_AMAZON.payloadInvalido,
    motivo: null,
    contaId: null,
    sku: null,
    origem: null,
    faixa: null,
    oferta: null,
    direcao: null,
    regra: null,
    tipoProduto: null,
    dryRun: null,
    previa: false,
    veredito: null,
    vez: null,
    parteAusente: false,
    status: null,
    problemas: [],
    codigos: [],
    falha: null,
    erro: null,
    limiteTaxa: null,
    contagens: [],
    gravacao: null,
    gravados: null,
    emConflito: null,
    avisoLevantado: false,
    verificacao: null,
    reenvioPerdido: false,
    perda: null,
  };
}

/** P0–P11, every end returned or thrown as a {@link RetentativaPrecoAmazon}. */
async function executar(
  dados: unknown,
  deps: DepsProcessarPrecoAmazon,
): Promise<ResultadoTarefaPrecoAmazon> {
  const inicioMs = deps.agora();

  // ---- P0: the payload. ----
  const lido = tarefaPrecoSkuAmazonSchema.safeParse(dados);
  if (!lido.success) return payloadInvalido();
  const t = lido.data;
  const e: Execucao = {
    deps,
    t,
    inicioMs,
    previa: false,
    veredito: null,
    vez: null,
    parteAusente: false,
    faixa: null,
    oferta: null,
    direcao: null,
    regra: null,
    tipoProduto: null,
    plano: null,
    taxas: [],
    contagens: [],
    perda: null,
    semVolta: false,
  };
  const registro = {
    fluxo: FLUXO_AMAZON.preco,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  };

  // ---- P1: the valve, read ONCE, logged, the preview flag applied, then the target. ----
  const lida = lerValvula(FLUXO_AMAZON.preco, deps.ambiente);
  registrarValvulaAmazon(deps.logger, lida, {
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });
  const efetiva = valvulaPrecoEfetiva(lida, deps.soValidacao);
  e.previa = efetiva.previa;
  e.veredito = efetiva.veredito;
  const valvula = efetiva.valvula;
  if (decidirAlvo(valvula, t.contaId, t.sku).modo === MODO_AMAZON.off) {
    return encerrar(e, MOTIVO_PRECO_AMAZON.desligado);
  }

  // ---- P2: a run's bond, then the price lease — both before the context. ----
  if (t.origem === ORIGEM_TAREFA_PRECO_AMAZON.execucao) {
    const posse = await lerPosseDaExecucao(deps.db, t.contaId, t.referencia);
    if (posse === 'substituida') return encerrar(e, MOTIVO_PRECO_AMAZON.execucaoSubstituida);
    if (posse === 'cancelada') return encerrar(e, MOTIVO_PRECO_AMAZON.execucaoCancelada);
  }
  const vezLida = await lerVezPreco(deps.db, t.contaId);
  if (vezLida.vez === 'ilegivel') {
    e.vez = 'ilegivel';
  } else {
    const tomada = decidirTomadaDaVez(vezLida.vez, deps.agora(), nomeDaTarefaPrecoAmazon(t));
    e.vez = tomada.tipo;
    if (tomada.tipo === TOMADA_DA_VEZ.ocupada) return reenfileirar(e, 'espera', {});
  }

  // ---- P3: the context — the read switch first —, then the conta's tabelas, RAW. ----
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await deps.carregarContexto(deps.db, t.contaId, depsDoContexto);
  } catch (err) {
    // Rule 6: a class the read ladder does not name (a Firestore error, the LWA
    // pair missing) is the queue's to retry.
    if (classificarFalhaDeLeituraAmazon(err) === FALHA_LEITURA_AMAZON.relancar) throw err;
    return falhaDeLeitura(e, err);
  }
  const sellerId = contexto.conta.selling_partner_id;
  if (sellerId === null || sellerId === undefined) {
    // The loader refuses an unconnected conta; kept total.
    return encerrar(e, MOTIVO_PRECO_AMAZON.contaIndisponivel);
  }
  const conta = await lerTabelasDaConta(deps.db, t.contaId);
  const { normalId, promocionalId } = conta.tabelas;
  if (normalId === null) return encerrar(e, MOTIVO_PRECO_AMAZON.contaSemTabelaNormal);

  // ---- P4: the link, read masked with the price masks, then its verdict. ----
  const leitura = await lerVinculoListingAmazon(
    deps.db,
    t.contaId,
    t.sku,
    camposDoResolverListingAmazon({
      fluxo: FLUXO_LISTING_AMAZON.preco,
      tabelaIds: promocionalId === null ? [normalId] : [normalId, promocionalId],
    }),
  );
  const vinculo = avaliarVinculoListingAmazon(leitura.entrada, REGRA_VINCULO_PRECO_AMAZON);
  if (!vinculo.apto) return encerrar(e, motivoDoVinculo(vinculo.motivo));
  e.contagens.push(...vinculo.contagens);
  let guardado: EntradaPlanoTarefaPrecoAmazon['guardado'] = null;
  if (t.origem === ORIGEM_TAREFA_PRECO_AMAZON.verificacao) {
    const { referencia } = t;
    const recente = vinculo.envioRecente;
    if (
      recente === null ||
      recente.via !== VIA_ENVIO_ESTOQUE_AMAZON.patch ||
      recente.oferta === null ||
      recente.submissionId !== referencia
    ) {
      return encerrar(e, MOTIVO_PRECO_AMAZON.superado);
    }
    guardado = { ...recente, oferta: recente.oferta };
  }

  // ---- P5: the faixa, NOW (never from the payload), and a run's floor. ----
  const faixa = faixaDePrecoAmazon(
    fontesPrecoDaUnidadeAmazon(leitura.entrada.unidade.raw, leitura.paiDaUnidade),
    conta.tabelas,
  );
  if (faixa.tipo === TIPO_FAIXA_PRECO_AMAZON.semTabelaNormal) {
    // P3 refused a conta with no normal tabela; kept total.
    return encerrar(e, MOTIVO_PRECO_AMAZON.contaSemTabelaNormal);
  }
  if (faixa.tipo === TIPO_FAIXA_PRECO_AMAZON.semPreco) {
    return encerrar(e, MOTIVO_PRECO_AMAZON.semPreco);
  }
  if (faixa.tipo !== TIPO_FAIXA_PRECO_AMAZON.faixa) {
    // Refused locally, and the conta aviso raised: nothing was sent, so a
    // failure of the raise is the queue's to retry.
    const avisoLevantado =
      conta.relogio !== null &&
      (await sincronizarAvisoContaListingsAmazon(
        deps.db,
        { increment: deps.increment, nowMs: deps.agora(), logger: deps.logger },
        {
          fluxo: FLUXO_LISTING_AMAZON.preco,
          integracaoId: t.contaId,
          motivo: MOTIVO_CONTA_AMAZON.precoFaixaInvertida,
          acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.levantar,
          relogio: conta.relogio,
        },
      )) !== null;
    return encerrar(e, MOTIVO_PRECO_AMAZON.faixaInvertida, { avisoLevantado });
  }
  e.faixa = guardado?.oferta ?? faixa.faixa;
  if (guardado !== null && erpMudouPrecoAmazon(faixa.faixa, guardado.oferta)) {
    return encerrar(e, MOTIVO_PRECO_AMAZON.erpMudou);
  }
  let piso: PisoConsentimentoPrecoAmazon = null;
  if (t.origem === ORIGEM_TAREFA_PRECO_AMAZON.execucao) {
    piso = await lerPisoDaParte(deps.db, t);
    e.parteAusente = piso === PISO_DESCONHECIDO_PRECO_AMAZON;
  }

  // ---- P6: a SKU no listings path can carry. ----
  if (!skuTemCaminhoAmazon(t.sku)) return encerrar(e, MOTIVO_PRECO_AMAZON.semCaminho);

  // ---- P7: the engine — the live read, the plan, at most ONE PATCH. ----
  // Written by the closures, read by the catch: an object, so neither is narrowed away.
  const corrida: { registroPrevioEmMs: number | null; emMs: number | null } = {
    registroPrevioEmMs: null,
    emMs: null,
  };
  // The write's credential getter, wrapped by the listings flows' shared rung:
  // the budget is checked and `emMs` stamped with the credential IN HAND, the
  // last await before a PATCH leaves, one past the write-ahead's own `emMs`.
  const contextoDaEscrita = contextoDaEscritaComOrcamentoListingAmazon(contexto, {
    agora: deps.agora,
    inicioMs: e.inicioMs,
    orcamentoMs: ORCAMENTO_ANTES_DO_PATCH_PRECO_MS,
    prazoEsgotado: () => new AmazonPrecoPrazoDaTarefaError(),
    carimbar: (agoraMs) => {
      const previo = corrida.registroPrevioEmMs;
      corrida.emMs = previo === null ? agoraMs : Math.max(agoraMs, previo + 1);
    },
  });
  const entradaDoPlano: EntradaPlanoTarefaPrecoAmazon = {
    vinculo,
    faixaAtual: faixa.faixa,
    guardado,
    piso,
    feedRecenteEmMs: vezLida.feedRecenteEmMs,
  };
  // The price outcomes the write-back will compare the write-ahead with, RAW
  // (an entry the price schema refuses still keeps a record out by its `emMs`).
  const guardadosDoVinculo = leitura.entrada.linksDoSku
    .filter((l) => l.donoId === vinculo.donoId)
    .map((l) => l.dados[CAMPO_ENVIO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco]]);
  let r: ResultadoEscritaAmazon<
    LeituraComTaxaListingNaAmazon,
    PlanoTarefaPrecoAmazon,
    EnvioComTaxaListingNaAmazon
  >;
  try {
    r = await executarEscritaAmazon({
      valvula,
      contaId: t.contaId,
      alvo: t.sku,
      contexto: contextoDaEscrita,
      deps: depsDoContexto,
      registro,
      lerAtual: async () => {
        const atual = await lerListingComTaxaNaAmazon(contexto, {
          sellerId,
          sku: t.sku,
          incluir: INCLUIR_LEITURA_PRECO,
        });
        if (atual.limiteTaxa !== null) e.taxas.push(atual.limiteTaxa);
        return atual;
      },
      planejar: (atual) => {
        const plano = planejarTarefa(e, atual.leitura, entradaDoPlano);
        e.plano = plano;
        return plano;
      },
      escrever: async (cliente, plano) => {
        const envio = plano.envio;
        if (envio === null)
          throw new TypeError('processarPreco.ts: um plano que escreve sem envio');
        if (!e.previa) {
          // 1. The write-ahead record, BEFORE the PATCH: no record, no PATCH.
          // Placed past what the write-back compares (the raw stored values),
          // at the clock the write-back is handed.
          const agoraMs = deps.agora();
          const emMs = instanteDoRegistroPrevio(
            agoraMs,
            corrida.registroPrevioEmMs,
            guardadosDoVinculo,
          );
          const registroPrevio = await gravarEnvio(
            e,
            vinculo,
            envioIncerto(emMs, envio.faixa),
            agoraMs,
          );
          if (registroPrevio.gravados === 0 || registroPrevio.emConflito > 0) {
            throw new AmazonPrecoRegistroPrevioPerdidoError(registroPrevio);
          }
          corrida.registroPrevioEmMs = emMs;
          // A check's re-send: its record replaced the checked entry.
          if (guardado !== null) e.semVolta = true;
        }
        // 2. The PATCH; the budget and `emMs` live in the credential getter above.
        const resposta = await enviarOfertaComTaxaNaAmazon(cliente, {
          sellerId,
          sku: t.sku,
          faixa: envio.faixa,
          tipoProduto: envio.tipoProduto,
          ...(e.previa ? { modo: MODO_ENVIO_LISTING_AMAZON.validacao } : {}),
        });
        if (resposta.limiteTaxa !== null) e.taxas.push(resposta.limiteTaxa);
        return resposta;
      },
    });
  } catch (err) {
    if (err instanceof AmazonPrecoPrazoDaTarefaError) {
      return retentar(e, MOTIVO_PRECO_AMAZON.prazoDaTarefa, err, { erro: err.name });
    }
    // The write-ahead did not land: nothing was sent; the line, then the retry.
    if (err instanceof AmazonPrecoRegistroPrevioPerdidoError) {
      return retentar(e, MOTIVO_PRECO_AMAZON.vinculoMudou, err, {
        erro: err.name,
        gravados: err.gravados,
        emConflito: err.emConflito,
      });
    }
    if (corrida.emMs === null || e.plano === null) return falhaDeLeitura(e, err);
    return falhaDeEscrita(e, err);
  }

  switch (r.tipo) {
    case 'desligado':
      // P1 already answered `off` on the same snapshot; kept total.
      return encerrar(e, MOTIVO_PRECO_AMAZON.desligado);
    case 'simulado': {
      // The engine wrote its ONE diff line; ours names why nothing was sent.
      const motivo: MotivoPrecoAmazon = !r.plano.escrever
        ? r.plano.motivo
        : r.motivo === 'fora-do-canario'
          ? MOTIVO_PRECO_AMAZON.foraDoCanario
          : MOTIVO_PRECO_AMAZON.simulado;
      return resultado(e, { acao: ACAO_TAREFA_PRECO_AMAZON.simulado, motivo, dryRun: r.motivo });
    }
    case 'sem-escrita':
      if (r.plano.refino !== null && guardado !== null) {
        return refinar(e, vinculo, guardado, r.plano, r.plano.refino);
      }
      return encerrar(e, r.plano.motivo);
    case 'escrito': {
      const envio = r.plano.envio;
      if (corrida.emMs === null || envio === null) {
        throw new TypeError('processarPreco.ts: um PATCH escrito sem o seu instante');
      }
      return respostaDoPatch(e, vinculo, r.plano, envio, corrida.emMs, r.resposta);
    }
  }
}

/**
 * ONE dispatch, P0–P11 (module header). Writes the ONE dispatch line and
 * returns the result; throws only what the queue must retry — a deliberate
 * retry (after its line), a Firestore error, a bug — RAW: the jobs root
 * sanitizes it.
 */
export async function processarPrecoSkuAmazon(
  dados: unknown,
  deps: DepsProcessarPrecoAmazon,
): Promise<ResultadoTarefaPrecoAmazon> {
  let r: ResultadoTarefaPrecoAmazon;
  try {
    r = await executar(dados, deps);
  } catch (err) {
    if (!(err instanceof RetentativaPrecoAmazon)) throw err;
    registrarDespachoPrecoAmazon(deps.logger, err.resultado, deps.registro);
    throw err.causa;
  }
  registrarDespachoPrecoAmazon(deps.logger, r, deps.registro);
  return r;
}
