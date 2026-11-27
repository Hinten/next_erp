/**
 * The PRICE provider of the feed core (step 13, PR 13-f): what one price
 * `JSON_LISTINGS_FEED` is built from, written back from and recovered by — the
 * `preco` row of the seam (`feeds/destinosLote.ts`), a FACTORY over the jobs
 * root's {@link RaizLoteAmazon} ({@link criarProvedorLotePrecoAmazon}). A price
 * batch is always a BLOCK batch: a range of one price run's parts
 * (`execucaoIdRun`, `parteInicial`, `partes` in the payload), named by the
 * run's decision step.
 *
 * ## `membros`
 *
 * The run `precosAmazon/{contaId}` by id, masked to `execucaoId`, `fase`,
 * `baixarPreco` and `lotes`. Another run (or none) ⇒ `execucao-substituida`; a
 * phase other than `decidindo` or `concluida` ⇒ `execucao-cancelada`; a batch
 * the ledger does not name, or whose end it already holds ⇒ `lote-encerrado`:
 * NO member, so a superseded or cancelled run's batch never sends, with its
 * consent or otherwise, and an ended batch is never sent again (a duplicate
 * delivery, a second waiting copy, or a re-run decision step naming it once
 * its task name is free). ⚠️ Residue: a SUBMITTED batch's end is recorded by
 * its recovery, which the tail enqueues before it releases the lease, so a
 * second copy that takes the free lease before that recovery runs still
 * builds. Else the batch's parts by id (never queried); a
 * missing part (past its TTL) is counted `parte-ausente`, never thrown on.
 * SKUs are deduplicated across the parts (the first part wins, counted), so a
 * repeat never refuses the whole document; each member keeps its part's
 * index. The run's consent and both counts travel in `dados`.
 *
 * ## `montar`, at SEND time
 *
 * `snapshotEmMs` is our clock before the first read; the shared 240-s budget
 * is asked before every read batch (past it ⇒ `snapshot-lento` with
 * `feed-preco-falhou`). Then, NOW: the conta RAW, masked to its two tabela
 * refs; each member's link doc by its stored path, masked to the SKU, the
 * conta ref and `envioPrecoAmazon`; each member's unit and the unit's parent
 * by id, masked to the price masks (the nested `precos.<tabela>` entries). A
 * member is dropped when its link is gone or names another SKU or conta
 * (`vinculo-mudou`), when its faixa NOW is `sem-preco` or `faixa-invertida`
 * (or the conta names no normal tabela), or when the decrease guard refuses it
 * (`decidirMembroLotePrecoAmazon`, `planoPreco.ts`: the offer Amazon is KNOWN
 * to hold, the run's consent, the page-time faixa as the floor). A stored
 * outcome further ahead of the clock than the price task's tolerance is set
 * aside (it would otherwise stand as the reference), through the shared
 * watermark reader (`listings/envioListing.ts`). A member is NEVER dropped
 * for being equal to its page's offer: the value is absolute, and a manual
 * push since the page may have moved Amazon. One message per member, the
 * package's offer merge (`patchOfertaAmazon`) under the part's stored
 * `productType`. The dry-run `diff` carries counts and closed codes
 * (`parteAusente` and `repetidos` included), and `amostraDesce`: the largest
 * `our_price` decreases sent, `sku:antes>depois`, as many WHOLE entries as
 * fit one log campo (`MAX_CAMPO_TEXTO_BYTES`), the rest counted in
 * `amostraDesceOmitidas`. This module compares no price: `planoPreco.ts` does.
 *
 * ## `gravarResultado`
 *
 * The report's own issues and its items' price issues (`issueDeItemRelevante`
 * = the price classifier), merged per SKU, at most
 * `MAX_SKUS_COM_PROBLEMA_GRAVADOS` SKUs chosen as the core's write-back bound
 * chooses them (`skusParaGravar`: a SKU with an `ERROR` from either source
 * first, then SKU order): each SKU's link docs of the conta through the shared
 * link reader's own query, then the shared write-back bound to the price field
 * with `via: 'feed'`, `oferta: null`, the feed's `antesDoEnvioMs` and `feedId`.
 * An `ERROR` among the report's OWN issues ⇒ `recusado` (our message was
 * refused); any other issue kept ⇒ `aceito-com-avisos` (a listing issue has
 * no time field, so an item's is never called our refusal). A BLOCKING price
 * issue on a SKU whose outcome landed (or is still in conflict) ⇒
 * `preco-recusado-pela-amazon` raised ONCE, clocked by the last such
 * write-back's link-doc read. ⚠️ Residue: a retried result dispatch whose
 * write-backs already landed reads its own entries as kept (an equal `emMs`),
 * so when that attempt's raise was lost the retry raises nothing; the stock
 * write-back has the same shape.
 *
 * ## The run's LEDGER (`recuperar`, `aoFimSemEnvio`)
 *
 * Each batch's end lands ONCE on its run's `lotes` entry, the one whose
 * `execucaoIdLote` is the batch's own `execucaoId`, through the run's one
 * write (tier 1, `escreverExecucaoPrecoAmazon`), and only when the CURRENT run
 * names that batch: a recorded `desfecho` is never replaced (a retry finds it
 * set and writes nothing).
 *
 *  - `recuperar` (a submitted feed's end, or the uncertain path): the batch is
 *    the payload's `execucaoId` for `incerto` (no feed), else the feed
 *    record's, read by id masked to it. The end's `desfecho` is recorded. On
 *    `concluido`, another batch of the run recorded FAILED (`falhou`,
 *    `abandonado`, `incerto`, `cancelado` — the core's tail raised the aviso
 *    for each — or no send for a failing reason) RE-RAISES
 *    `feed-preco-falhou`, clocked by this dispatch's run read (later than the
 *    clock the core's tail resolved it by). The other way round too: a FAILED
 *    end recorded once another batch is recorded `concluido` re-raises (that
 *    batch's tail may have resolved the aviso after this one's tail raised it,
 *    a recovery that retried, or the uncertain path's 12 h). Always
 *    `{ nada: true }`: a failed batch is never re-sent, and a `vez` recovery
 *    has nothing to do (price records no pending start).
 *  - `aoFimSemEnvio` (an end after the context that submitted nothing):
 *    `sem-envio` with its `motivoSemEnvio`; on `lote-expirado` (the one end
 *    the core raises nothing for) it also raises `feed-preco-falhou`, clocked
 *    by that run read, unless the run is `cancelada` (its batch would have
 *    stood down: an expiry there is no failure, for this raise nor for a
 *    re-raise). A write that kept losing its precondition is ONE WARNING,
 *    never a throw.
 *
 * ## `repassarParaPatches`
 *
 * A canary list met at send time: one `preco-sku` task per member, named like
 * a run's task (`origem: 'execucao'`, `referencia` = the run, its `parte`, the
 * run's consent, this hand-off's clock), so it never doubles a task the run's
 * decision made; each task stands down with its run and reads its part's
 * floor itself. Through the root's price producer, onto the jobs queue's path.
 *
 * ## `valvulaEfetiva`
 *
 * The price valve with the preview flag applied (`valvulaPrecoEfetiva`, over
 * `env.ts`'s one reader of `AMAZON_PRECO_SO_VALIDACAO`): under the flag `on` +
 * `*` reads `dry-run`, so a batch named before the flag was set still cannot
 * submit; that verdict is ONE ERROR line, and a flag value that is neither
 * unset nor exactly `1` (the PATCHes stay real) ONE WARNING.
 *
 * Every instant is MILLISECONDS; aviso clocks are Firestore `readTime`s,
 * converted only in `avisos/avisos.ts`. No Firestore write of its own: the
 * run's one write, the shared write-back and the aviso raiser write under
 * their own tiers, and every enqueue is named. D11: nothing here calls Amazon.
 */
import type { DocumentSnapshot, Firestore, Timestamp } from 'firebase-admin/firestore';
import {
  feedAmazonCollection,
  integracaoCollection,
  produtoAmazonLinkCollection,
} from '@delfrance/data/admin/collections';
import { contaRefForms } from '@delfrance/data/admin/produtos';
import {
  DADOS_RELATORIO_FEED,
  type MensagemListingsFeed,
  patchOfertaAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  CAMPOS_INDICE_VINCULO_AMAZON,
  DESFECHO_LOTE_PRECO_AMAZON,
  type DesfechoLotePrecoAmazon,
  type EnvioPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  type ItemDivergenciaPrecoAmazon,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON,
  type LotesExecucaoPrecoAmazon,
  type MotivoSemEnvioLotePrecoAmazon,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  TIPO_FAIXA_PRECO_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type TabelasDePrecoAmazon,
  type TimestampLike,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioPrecoAmazonSchema,
  faixaDePrecoAmazon,
  fontesPrecoDaUnidadeAmazon,
  idRegistroFeedAmazon,
  tabelasDePrecoDaContaAmazon,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_LISTINGS_AMAZON,
  sincronizarAvisoContaListingsAmazon,
} from '../avisos/avisos';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  MAX_CAMPO_TEXTO_BYTES,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { FLUXO_AMAZON, type ValvulaAmazon } from '../core/valvulas';
import {
  LEITURA_PRECO_SO_VALIDACAO_AMAZON,
  PRECO_SO_VALIDACAO_ENV,
  lerPrecoSoValidacaoAmazon,
} from '../env';
import type { RaizLoteAmazon } from '../feeds/destinosLote';
import {
  type AbortoLoteAmazon,
  type ContextoLoteAmazon,
  type DesfechoRecuperacaoLoteAmazon,
  type EntradaValvulaEfetivaLoteAmazon,
  FIM_SEM_ENVIO_LOTE,
  type FimSemEnvioLote,
  MOTIVO_ABORTO_LOTE,
  type MembrosLoteAmazon,
  type MontagemLoteAmazon,
  ORCAMENTO_MONTAGEM_LOTE_MS,
  type ProvedorLoteAmazon,
  type RecuperacaoLoteAmazon,
  type ResultadoLoteAmazon,
} from '../feeds/provedorLote';
import type { ProblemaItemSku, ProblemaSku } from '../feeds/relatorioFeed';
import { skusParaGravar } from '../feeds/relatorioFeed';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  type TarefaEnviarFeedAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
} from '../feeds/tarefaLote';
import {
  MAX_REFS_GETALL_VINCULOS_AMAZON,
  lerProdutosPorIdListingAmazon,
  lerVinculosDosSkusListingAmazon,
  paiDaUnidadeNoLoteListingAmazon,
  paiIdsDasUnidadesListingAmazon,
} from '../listings/avaliacaoLoteVinculos';
import { marcaDaguaEnvioListing } from '../listings/envioListing';
import { gravarEnvioListingAmazon } from '../listings/envioListingFirestore';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import {
  CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON,
  camposDoResolverListingAmazon,
} from '../listings/resolverVinculo';
import { CAMPO_ENVIO_LISTING_AMAZON } from '../listings/vinculoListing';
import { lerPartesDivergenciaPrecoAmazon } from './divergenciasPrecoFirestore';
import {
  ExecucaoPrecoEmConflitoError,
  escreverExecucaoPrecoAmazon,
  lerExecucaoPrecoAmazon,
  mascaraExecucaoPrecoAmazon,
} from './execucaoPrecoFirestore';
import { ehIssuePrecoAmazon, ehIssuePrecoBloqueanteAmazon } from './issuesPreco';
import { VEREDITO_VALVULA_PRECO_AMAZON, valvulaPrecoEfetiva } from './modoPreco';
import { MOTIVO_PRECO_AMAZON, type MotivoPrecoAmazon } from './motivosPreco';
import {
  DIRECAO_PRECO_AMAZON,
  type ReducaoPrecoAmazon,
  amostraReducoesPrecoAmazon,
  decidirMembroLotePrecoAmazon,
} from './planoPreco';
import {
  CAMPOS_CONTA_PRECO_AMAZON,
  CAMPO_DO_ENVIO_PRECO_AMAZON,
  FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS,
  REGRA_VINCULO_PRECO_AMAZON,
} from './processarPreco';
import {
  ORIGEM_TAREFA_PRECO_AMAZON,
  TIPO_TAREFA_PRECO_AMAZON,
  type TarefaPrecoSkuAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** The `fase` of the provider's own lines. */
export const FASE_PROVEDOR_PRECO_AMAZON = {
  valvula: 'feed-valvula',
  membros: 'feed-membros',
  gravacao: 'feed-gravacao',
  livro: 'feed-livro',
} as const;

/** The run fields `membros` reads: the bond, the consent and the batch ledger. */
export const CAMPOS_EXECUCAO_LOTE_PRECO_AMAZON = [
  'execucaoId',
  'fase',
  'baixarPreco',
  'lotes',
] as const;

/** The run fields the ledger reads: the run's id, its phase and its batches. */
export const CAMPOS_LIVRO_LOTE_PRECO_AMAZON = ['execucaoId', 'fase', 'lotes'] as const;

/** The link-doc fields `montar` re-reads: the SKU, the conta and the price outcome. */
export const CAMPOS_VINCULO_LOTE_PRECO_AMAZON = [
  ...CAMPOS_INDICE_VINCULO_AMAZON,
  CAMPO_ENVIO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco],
] as const;

/** The feed record's field `recuperar` reads: the batch that sent it. */
export const CAMPOS_REGISTRO_LOTE_PRECO_AMAZON = ['execucaoId'] as const;

/** What the ledger records for an end, by the core's closed end (module header). */
export const MOTIVO_SEM_ENVIO_DO_FIM: Readonly<
  Record<FimSemEnvioLote, MotivoSemEnvioLotePrecoAmazon>
> = {
  [FIM_SEM_ENVIO_LOTE.simulado]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.simulado,
  [FIM_SEM_ENVIO_LOTE.semEscrita]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.semEscrita,
  [FIM_SEM_ENVIO_LOTE.soPatches]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.soPatches,
  [FIM_SEM_ENVIO_LOTE.repassado]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.repassado,
  [FIM_SEM_ENVIO_LOTE.repasseAbortado]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.repasseAbortado,
  [FIM_SEM_ENVIO_LOTE.abortado]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.abortado,
  [FIM_SEM_ENVIO_LOTE.documentoFalhou]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.documentoFalhou,
  [FIM_SEM_ENVIO_LOTE.recusaDefinitiva]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.recusaDefinitiva,
  [FIM_SEM_ENVIO_LOTE.loteExpirado]: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.loteExpirado,
};

/** The ends without a send that FAIL a batch: a later clean batch re-raises over them. */
export const SEM_ENVIO_QUE_FALHA_PRECO_AMAZON: ReadonlySet<MotivoSemEnvioLotePrecoAmazon> =
  new Set<MotivoSemEnvioLotePrecoAmazon>([
    MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.abortado,
    MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.repasseAbortado,
    MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.documentoFalhou,
    MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.recusaDefinitiva,
    MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.loteExpirado,
  ]);

/**
 * The submitted ends that FAIL a batch: every end the core's tail raises the
 * fluxo's aviso for (`cancelado` included: nothing of a cancelled feed applied).
 */
export const DESFECHOS_QUE_FALHAM_PRECO_AMAZON: ReadonlySet<DesfechoLotePrecoAmazon> =
  new Set<DesfechoLotePrecoAmazon>([
    DESFECHO_LOTE_PRECO_AMAZON.falhou,
    DESFECHO_LOTE_PRECO_AMAZON.abandonado,
    DESFECHO_LOTE_PRECO_AMAZON.incerto,
    DESFECHO_LOTE_PRECO_AMAZON.cancelado,
  ]);

/** A batch the run's ledger does not name, or whose end it already holds (module header). */
export const LOTE_ENCERRADO_PRECO_AMAZON = 'lote-encerrado';

/** Why a batch's run stands it down (module header, `membros`). */
export type ParadaLotePrecoAmazon =
  | typeof MOTIVO_PRECO_AMAZON.execucaoSubstituida
  | typeof MOTIVO_PRECO_AMAZON.execucaoCancelada
  | typeof LOTE_ENCERRADO_PRECO_AMAZON;

/** One member of a price batch: its part's stored item, and that part's index. */
export interface MembroLotePrecoAmazon {
  readonly item: ItemDivergenciaPrecoAmazon;
  readonly parte: number;
}

/** What `membros` hands `montar` and the hand-off (opaque to the core). */
export interface DadosLotePrecoAmazon {
  /** ms — the budget's start (`membros`' first clock read). */
  readonly inicioMs: number;
  /** The run stood the batch down: no member. */
  readonly parada: ParadaLotePrecoAmazon | null;
  /** The run's consent to lower `our_price`. */
  readonly baixarPreco: boolean;
  /** Per member SKU, its item and part. */
  readonly membros: ReadonlyMap<string, MembroLotePrecoAmazon>;
  /** The batch's parts that no longer exist (their SKUs not sent). */
  readonly parteAusente: number;
  /** SKUs a later part of the batch repeated (sent once, from the first). */
  readonly repetidos: number;
}

/** The price provider, as its factory builds it. */
export type ProvedorLotePrecoAmazon = ProvedorLoteAmazon<'preco', DadosLotePrecoAmazon>;

/** The price flow's binding of the shared write-back, under this module's label. */
const CAMPO_DO_ENVIO_FEED_PRECO_AMAZON = {
  ...CAMPO_DO_ENVIO_PRECO_AMAZON,
  rotulo: 'provedorLotePreco.ts',
};

/** The abort of a build past the shared budget (module header). */
const ABORTO_LENTO: AbortoLoteAmazon = {
  abortado: MOTIVO_ABORTO_LOTE.snapshotLento,
  aviso: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
};

/** The severity Amazon spells for a blocking issue. */
const SEVERIDADE_ERRO_AMAZON = 'ERROR';

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

/** Code-unit order (a SKU is compared as exact bytes). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `itens` in consecutive slices of at most `tamanho`. */
function fatias<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/** A snapshot's data, or `null` when the document does not exist. */
function dadosDe(snap: DocumentSnapshot | undefined): Readonly<Record<string, unknown>> | null {
  if (snap?.exists !== true) return null;
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/** One line of the provider's own (`evento: 'preco'`): closed codes and counts only. */
function registrar(
  logger: LoggerAmazon,
  contaId: string,
  severidade: SeveridadeAmazon,
  mensagem: string,
  campos: CamposLogAmazon,
  envelope: { readonly tentativa?: number; readonly idTarefa?: string | null } = {},
): void {
  registrarEventoAmazon(logger, 'preco', severidade, mensagem, campos, {
    ...envelope,
    conta: contaId,
    fluxo: FLUXO_AMAZON.preco,
  });
}

/** The payload's block range (a price batch is always one: `feeds/tarefaLote.ts`). */
function blocosDe(entrada: TarefaEnviarFeedAmazon) {
  const { lote } = entrada;
  if (lote.tipo !== TIPO_LOTE_FEED_AMAZON.blocos) {
    throw new TypeError('provedorLotePreco.ts: um lote de preço é sempre um lote de blocos');
  }
  return lote;
}

/** The conta's tabelas, off ONE raw read masked to the two refs, never cached. */
async function lerTabelasDaConta(db: Firestore, contaId: string): Promise<TabelasDePrecoAmazon> {
  const [snap] = await db.getAll(integracaoCollection.docRef(db, {}, contaId), {
    fieldMask: [...CAMPOS_CONTA_PRECO_AMAZON],
  });
  return tabelasDePrecoDaContaAmazon(snap?.exists === true ? snap.data() : null);
}

/** Raise `feed-preco-falhou`, clocked by `relogio` (a Firestore read this dispatch took). */
async function levantarFalhaDoFeed(
  ctx: ContextoLoteAmazon,
  raiz: RaizLoteAmazon,
  relogio: TimestampLike,
): Promise<void> {
  await sincronizarAvisoContaListingsAmazon(
    ctx.db,
    { increment: raiz.increment, nowMs: ctx.agora(), logger: ctx.logger },
    {
      fluxo: FLUXO_LISTING_AMAZON.preco,
      integracaoId: ctx.contexto.integracaoId,
      motivo: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
      acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.levantar,
      relogio,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the factory                               */
/* -------------------------------------------------------------------------- */

/**
 * The price row of the seam (module header), bound ONCE by the jobs root. It
 * builds nothing at bind time and calls nothing of the root: every producer
 * stays a thunk until a hand-off.
 */
export function criarProvedorLotePrecoAmazon(raiz: RaizLoteAmazon): ProvedorLotePrecoAmazon {
  return {
    fluxo: FLUXO_AMAZON.preco,
    motivoFalha: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
    relatorio: { incluir: [DADOS_RELATORIO_FEED.issues] },
    issueDeItemRelevante: (issue) => ehIssuePrecoAmazon(issue),
    valvulaEfetiva: (valvula, entrada) => valvulaEfetiva(valvula, entrada),
    membros: (ctx, entrada) => membros(ctx, entrada),
    montar: (ctx, _entrada, membrosOn, dados) => montar(ctx, membrosOn, dados),
    gravarResultado: (ctx, resultado) => gravarResultado(ctx, resultado, raiz),
    recuperar: (ctx, recuperacao) => recuperar(ctx, recuperacao, raiz),
    repassarParaPatches: (ctx, entrada, skus, dados) =>
      repassarParaPatches(ctx, entrada, skus, dados, raiz),
    aoFimSemEnvio: (ctx, entrada, fim) => aoFimSemEnvio(ctx, entrada, fim, raiz),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 the valve                                  */
/* -------------------------------------------------------------------------- */

/** The valve a price send acts on (module header, `valvulaEfetiva`). */
function valvulaEfetiva(
  valvula: ValvulaAmazon<'preco'>,
  entrada: EntradaValvulaEfetivaLoteAmazon,
): ValvulaAmazon<'preco'> {
  const { conta, ...envelope } = entrada.envelope;
  const flag = lerPrecoSoValidacaoAmazon(entrada.ambiente);
  if (flag.leitura === LEITURA_PRECO_SO_VALIDACAO_AMAZON.ignorado) {
    registrar(
      entrada.logger,
      conta,
      'WARNING',
      `[amazon] feed preco: ${PRECO_SO_VALIDACAO_ENV} ignorada (só o valor exato 1 liga a prévia)`,
      {
        fase: FASE_PROVEDOR_PRECO_AMAZON.valvula,
        flag: PRECO_SO_VALIDACAO_ENV,
        leitura: flag.leitura,
      },
      envelope,
    );
  }
  const efetiva = valvulaPrecoEfetiva(valvula, flag.ligado);
  if (efetiva.veredito === VEREDITO_VALVULA_PRECO_AMAZON.validacaoComTodos) {
    registrar(
      entrada.logger,
      conta,
      'ERROR',
      '[amazon] feed preco: a prévia com o canário * vira dry-run (feed não tem prévia)',
      {
        fase: FASE_PROVEDOR_PRECO_AMAZON.valvula,
        veredito: efetiva.veredito,
        modoLido: valvula.modo,
        modo: efetiva.valvula.modo,
      },
      envelope,
    );
  }
  return efetiva.valvula;
}

/* -------------------------------------------------------------------------- */
/*                                   membros                                  */
/* -------------------------------------------------------------------------- */

/** The batch's members (module header): the run's bond FIRST, then its parts by id. */
async function membros(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
): Promise<MembrosLoteAmazon<DadosLotePrecoAmazon>> {
  const inicioMs = ctx.agora();
  const lote = blocosDe(entrada);
  const contaId = ctx.contexto.integracaoId;
  const { estado: run } = await lerExecucaoPrecoAmazon(
    ctx.db,
    contaId,
    mascaraExecucaoPrecoAmazon([...CAMPOS_EXECUCAO_LOTE_PRECO_AMAZON]),
  );
  let parada: ParadaLotePrecoAmazon | null = null;
  if (run === null || run.execucaoId !== lote.execucaoIdRun) {
    parada = MOTIVO_PRECO_AMAZON.execucaoSubstituida;
  } else if (
    run.fase !== FASE_EXECUCAO_PRECO_AMAZON.decidindo &&
    run.fase !== FASE_EXECUCAO_PRECO_AMAZON.concluida
  ) {
    parada = MOTIVO_PRECO_AMAZON.execucaoCancelada;
  } else {
    // The batch's own ledger entry: an ended batch (or one never named) is not sent again.
    const doLivro = Object.values(run.lotes).find((l) => l.execucaoIdLote === entrada.execucaoId);
    if (doLivro === undefined || doLivro.desfecho !== null) parada = LOTE_ENCERRADO_PRECO_AMAZON;
  }
  if (parada !== null || run === null) {
    registrar(ctx.logger, contaId, 'INFO', '[amazon] feed preco: lote parado pela execução', {
      fase: FASE_PROVEDOR_PRECO_AMAZON.membros,
      motivo: parada,
      execucaoIdRun: lote.execucaoIdRun,
      parteInicial: lote.parteInicial,
      partes: lote.partes,
    });
    return {
      skus: [],
      dados: {
        inicioMs,
        parada,
        baixarPreco: false,
        membros: new Map(),
        parteAusente: 0,
        repetidos: 0,
      },
    };
  }

  const partes = await lerPartesDivergenciaPrecoAmazon(ctx.db, {
    contaId,
    execucaoId: lote.execucaoIdRun,
    parteInicial: lote.parteInicial,
    partes: lote.partes,
  });
  const porSku = new Map<string, MembroLotePrecoAmazon>();
  let parteAusente = 0;
  let repetidos = 0;
  for (const parte of partes) {
    if (!parte.existe) {
      parteAusente += 1;
      continue;
    }
    for (const item of parte.itens) {
      // A SKU counted by two parts is sent once: the first part wins.
      if (porSku.has(item.sku)) repetidos += 1;
      else porSku.set(item.sku, { item, parte: parte.parte });
    }
  }
  registrar(ctx.logger, contaId, 'INFO', '[amazon] feed preco: membros do lote lidos', {
    fase: FASE_PROVEDOR_PRECO_AMAZON.membros,
    execucaoIdRun: lote.execucaoIdRun,
    parteInicial: lote.parteInicial,
    partes: lote.partes,
    membros: porSku.size,
    parteAusente,
    repetidos,
  });
  return {
    skus: [...porSku.keys()].sort(porTexto),
    dados: {
      inicioMs,
      parada: null,
      baixarPreco: run.baixarPreco,
      membros: porSku,
      parteAusente,
      repetidos,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                    montar                                  */
/* -------------------------------------------------------------------------- */

/** A member's link doc, re-read by its stored path; `null` when it does not exist. */
type VinculoLidoPrecoAmazon = Readonly<Record<string, unknown>> | null;

/** The members' link docs by their stored paths, masked; `null` once the budget passed. */
async function lerVinculosDosMembros(
  db: Firestore,
  membrosDoLote: readonly MembroLotePrecoAmazon[],
  venceu: () => boolean,
): Promise<Map<string, VinculoLidoPrecoAmazon> | null> {
  const lidos = new Map<string, VinculoLidoPrecoAmazon>();
  for (const fatia of fatias(membrosDoLote, MAX_REFS_GETALL_VINCULOS_AMAZON)) {
    if (venceu()) return null;
    const refs = fatia.map(({ item }) => {
      // `produtos/<produtoId>/prodAmazon/<linkId>`, held to that grammar by the part's schema.
      const [, produtoId = '', , linkId = ''] = item.vinculo.split('/');
      return produtoAmazonLinkCollection.docRef(db, { produtoId }, linkId);
    });
    const snaps = await db.getAll(...refs, { fieldMask: [...CAMPOS_VINCULO_LOTE_PRECO_AMAZON] });
    for (const [i, { item }] of fatia.entries()) lidos.set(item.sku, dadosDe(snaps[i]));
  }
  return lidos;
}

/** Whether a re-read link still binds this SKU to this conta (module header, `montar`). */
function vinculoValido(
  vinculo: VinculoLidoPrecoAmazon | undefined,
  sku: string,
  contaId: string,
): vinculo is Readonly<Record<string, unknown>> {
  if (vinculo === null || vinculo === undefined) return false;
  const [campoConta, campoSku] = CAMPOS_INDICE_VINCULO_AMAZON;
  const conta = vinculo[campoConta];
  return (
    vinculo[campoSku] === sku && typeof conta === 'string' && contaRefForms(contaId).includes(conta)
  );
}

/**
 * The link's stored price outcome as the decrease guard reads it: parsed by the
 * price flow's verdict binding, and set aside when it sits further ahead of the
 * clock than the price task's tolerance (it could not have been our send).
 */
function envioGuardado(
  vinculo: Readonly<Record<string, unknown>>,
  agoraMs: number,
): EnvioPrecoAmazon | null {
  const bruto = vinculo[CAMPO_ENVIO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco]];
  const tolerancia = { futuroToleradoMs: FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS, agoraMs };
  if (marcaDaguaEnvioListing(bruto, tolerancia) === null) return null;
  return REGRA_VINCULO_PRECO_AMAZON.lerEnvio(bruto);
}

/**
 * The decrease sample as ONE log campo (module header, `montar`): its entries
 * in order, as many WHOLE ones as fit the sink's cap once joined, and how many
 * were left out — so the sink never cuts an entry in the middle.
 */
function amostraNoCampo(amostra: readonly string[]): {
  readonly texto: string | null;
  readonly omitidas: number;
} {
  const codificador = new TextEncoder();
  let texto: string | null = null;
  let cabem = 0;
  for (const entrada of amostra) {
    const junto: string = texto === null ? entrada : `${texto},${entrada}`;
    if (codificador.encode(junto).byteLength > MAX_CAMPO_TEXTO_BYTES) break;
    texto = junto;
    cabem += 1;
  }
  return { texto, omitidas: amostra.length - cabem };
}

/** The batch's build at SEND time (module header). */
async function montar(
  ctx: ContextoLoteAmazon,
  membrosOn: readonly string[],
  dados: DadosLotePrecoAmazon,
): Promise<MontagemLoteAmazon> {
  // Our clock BEFORE the first read.
  const snapshotEmMs = ctx.agora();
  const contaId = ctx.contexto.integracaoId;
  const membrosDoLote = membrosOn
    .flatMap((sku) => {
      const m = dados.membros.get(sku);
      return m === undefined ? [] : [m];
    })
    .sort((a, b) => porTexto(a.item.sku, b.item.sku));
  const quedas = new Map<MotivoPrecoAmazon, number>();
  const cair = (motivo: MotivoPrecoAmazon) => {
    quedas.set(motivo, (quedas.get(motivo) ?? 0) + 1);
  };
  const vazio = (): MontagemLoteAmazon => ({
    mensagens: [],
    snapshotEmMs,
    diff: {
      lote: TIPO_LOTE_FEED_AMAZON.blocos,
      membros: membrosDoLote.length,
      mensagens: 0,
      parada: dados.parada,
      parteAusente: dados.parteAusente,
      repetidos: dados.repetidos,
      ...Object.fromEntries(quedas),
    },
  });
  if (dados.parada !== null || membrosDoLote.length === 0) return vazio();

  const prazoMs = dados.inicioMs + ORCAMENTO_MONTAGEM_LOTE_MS;
  const venceu = () => ctx.agora() >= prazoMs;

  // 1. The conta's tabelas, RAW.
  if (venceu()) return ABORTO_LENTO;
  const tabelas = await lerTabelasDaConta(ctx.db, contaId);
  const normalId = tabelas.normalId;
  if (normalId === null) {
    for (const _membro of membrosDoLote) cair(MOTIVO_PRECO_AMAZON.contaSemTabelaNormal);
    return vazio();
  }
  const campos = camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.preco,
    tabelaIds: tabelas.promocionalId === null ? [normalId] : [normalId, tabelas.promocionalId],
  });
  const paiDaUnidade = campos.paiDaUnidade;

  // 2. Each member's link doc, by its stored path.
  const vinculos = await lerVinculosDosMembros(ctx.db, membrosDoLote, venceu);
  if (vinculos === null) return ABORTO_LENTO;

  // 3. The units and their parents, by id, under the price masks.
  const unidades = await lerProdutosPorIdListingAmazon(
    ctx.db,
    membrosDoLote.map((m) => m.item.unidadeId),
    campos.unidade,
    { venceu, aoLer: () => undefined },
  );
  if (unidades === null) return ABORTO_LENTO;
  const pais =
    paiDaUnidade === null
      ? new Map<string, Readonly<Record<string, unknown>> | null>()
      : await lerProdutosPorIdListingAmazon(
          ctx.db,
          paiIdsDasUnidadesListingAmazon(unidades.values()),
          paiDaUnidade,
          { venceu, aoLer: () => undefined },
        );
  if (pais === null || venceu()) return ABORTO_LENTO;

  // 4. Each member: its link, its faixa NOW, the decrease guard. Never an equality drop.
  const agoraMs = ctx.agora();
  const mensagens: MensagemListingsFeed[] = [];
  const reducoes: ReducaoPrecoAmazon[] = [];
  const direcoes = { sobe: 0, desce: 0, igual: 0, desconhecida: 0 };
  let igualAPagina = 0;
  for (const { item } of membrosDoLote) {
    const vinculo = vinculos.get(item.sku);
    if (!vinculoValido(vinculo, item.sku, contaId)) {
      cair(MOTIVO_PRECO_AMAZON.vinculoMudou);
      continue;
    }
    const unidade = unidades.get(item.unidadeId) ?? null;
    const faixa = faixaDePrecoAmazon(
      fontesPrecoDaUnidadeAmazon(
        unidade,
        paiDaUnidadeNoLoteListingAmazon(unidade, paiDaUnidade, pais),
      ),
      tabelas,
    );
    if (faixa.tipo === TIPO_FAIXA_PRECO_AMAZON.faixaInvertida) {
      cair(MOTIVO_PRECO_AMAZON.faixaInvertida);
      continue;
    }
    if (faixa.tipo !== TIPO_FAIXA_PRECO_AMAZON.faixa) {
      cair(MOTIVO_PRECO_AMAZON.semPreco);
      continue;
    }
    const decisao = decidirMembroLotePrecoAmazon(
      item,
      faixa.faixa,
      envioGuardado(vinculo, agoraMs),
      dados.baixarPreco,
    );
    if (!decisao.enviar) {
      cair(decisao.motivo);
      continue;
    }
    direcoes[decisao.direcao] += 1;
    if (decisao.igualAPagina) igualAPagina += 1;
    if (decisao.direcao === DIRECAO_PRECO_AMAZON.desce && decisao.referencia !== null) {
      reducoes.push({ sku: item.sku, antes: decisao.referencia, depois: faixa.faixa.base });
    }
    mensagens.push({
      sku: item.sku,
      productType: item.tipoProduto,
      patches: [patchOfertaAmazon(faixa.faixa)],
    });
  }
  const amostra = amostraNoCampo(amostraReducoesPrecoAmazon(reducoes));
  return {
    mensagens,
    snapshotEmMs,
    diff: {
      lote: TIPO_LOTE_FEED_AMAZON.blocos,
      membros: membrosDoLote.length,
      mensagens: mensagens.length,
      ...direcoes,
      igualAPagina,
      parteAusente: dados.parteAusente,
      repetidos: dados.repetidos,
      ...Object.fromEntries(quedas),
      amostraDesce: amostra.texto,
      amostraDesceOmitidas: amostra.omitidas,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               gravarResultado                              */
/* -------------------------------------------------------------------------- */

/** One SKU's issues kept for its outcome: `ERROR` first, then the rest, at most the cap. */
function problemasGuardados(
  proprios: readonly ProblemaSku[],
  dosItens: readonly ProblemaItemSku[],
) {
  const todos: readonly (ProblemaSku | ProblemaItemSku)[] = [...proprios, ...dosItens];
  const erros = todos.filter((p) => p.severity === SEVERIDADE_ERRO_AMAZON);
  const outros = todos.filter((p) => p.severity !== SEVERIDADE_ERRO_AMAZON);
  return [...erros, ...outros].slice(0, MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON).map((p) => ({
    code: p.code,
    message: p.message,
    severity: p.severity,
    attributeNames: p.attributeNames === null ? null : [...p.attributeNames],
    categories: p.categories === null ? null : [...p.categories],
  }));
}

/** The report's write-back (module header, `gravarResultado`). */
async function gravarResultado(
  ctx: ContextoLoteAmazon,
  resultado: ResultadoLoteAmazon,
  raiz: RaizLoteAmazon,
): Promise<void> {
  const contaId = ctx.contexto.integracaoId;
  const dosItens = resultado.issuesDosItens ?? new Map<string, readonly ProblemaItemSku[]>();
  // Both sources merged per SKU, then the core's own bound: an ERROR first, then SKU order.
  const juntos = new Map<string, readonly (ProblemaSku | ProblemaItemSku)[]>(resultado.problemas);
  for (const [sku, itens] of dosItens) juntos.set(sku, [...(juntos.get(sku) ?? []), ...itens]);
  const skus = [...skusParaGravar(juntos).problemas.keys()];
  if (skus.length === 0) return;
  const vinculos = await lerVinculosDosSkusListingAmazon(
    ctx.db,
    contaId,
    skus,
    CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco],
    { agora: ctx.agora, prazoMs: Number.MAX_SAFE_INTEGER },
  );
  if (vinculos === null) {
    throw new TypeError('provedorLotePreco.ts: a leitura dos vínculos não tem prazo aqui');
  }
  let gravados = 0;
  let semVinculo = 0;
  let recusados = 0;
  let comIssueDePreco = 0;
  // The raise's clock: the LAST link-doc read of a price refusal that counted.
  let relogioDoAviso: Timestamp | null = null;
  for (const sku of skus) {
    const lido = vinculos.get(sku);
    if (lido === undefined || lido.tipo !== 'docs' || lido.docs.length === 0) {
      semVinculo += 1;
      continue;
    }
    const proprios = resultado.problemas.get(sku) ?? [];
    const itens = dosItens.get(sku) ?? [];
    const recusado = proprios.some((p) => p.severity === SEVERIDADE_ERRO_AMAZON);
    const envio = envioPrecoAmazonSchema.parse({
      via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
      emMs: resultado.emMs,
      oferta: null,
      resultado: recusado
        ? RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado
        : RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos,
      submissionId: null,
      feedId: resultado.feedId,
      problemas: problemasGuardados(proprios, itens),
    });
    const r = await gravarEnvioListingAmazon(
      ctx.db,
      CAMPO_DO_ENVIO_FEED_PRECO_AMAZON,
      {
        contaId,
        sku,
        links: lido.docs.map((d) => ({ produtoId: d.donoId, linkId: d.linkId })),
        envio,
        agoraMs: ctx.agora(),
      },
      { logger: ctx.logger },
    );
    const valeu = r.gravados + r.emConflito > 0;
    if (valeu) gravados += 1;
    if (recusado) recusados += 1;
    if (valeu && [...proprios, ...itens].some((p) => ehIssuePrecoBloqueanteAmazon(p))) {
      comIssueDePreco += 1;
      relogioDoAviso = r.relogio ?? relogioDoAviso;
    }
  }
  if (comIssueDePreco > 0) {
    await sincronizarAvisoContaListingsAmazon(
      ctx.db,
      { increment: raiz.increment, nowMs: ctx.agora(), logger: ctx.logger },
      {
        fluxo: FLUXO_LISTING_AMAZON.preco,
        integracaoId: contaId,
        motivo: MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
        acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.levantar,
        relogio: relogioDoAviso ?? resultado.relogio,
      },
    );
  }
  registrar(ctx.logger, contaId, 'INFO', '[amazon] feed preco: resultado gravado nos vínculos', {
    fase: FASE_PROVEDOR_PRECO_AMAZON.gravacao,
    feedId: resultado.feedId,
    skus: skus.length,
    gravados,
    semVinculo,
    recusados,
    comIssueDePreco,
  });
}

/* -------------------------------------------------------------------------- */
/*                                 the ledger                                 */
/* -------------------------------------------------------------------------- */

/** What one ledger write found (module header, "The run's LEDGER"). */
type LivroLotePrecoAmazon =
  /** No run, or another run than the one asked about: nothing written. */
  | { readonly tipo: 'outra-execucao' }
  /** The current run names no such batch: nothing written. */
  | { readonly tipo: 'sem-lote' }
  /** The entry already held an end (a retry): nothing written. */
  | {
      readonly tipo: 'ja-registrado';
      readonly indice: string;
      readonly lotes: LotesExecucaoPrecoAmazon;
      /** The run is `cancelada`. */
      readonly cancelada: boolean;
    }
  /** The end recorded. */
  | {
      readonly tipo: 'registrado';
      readonly indice: string;
      readonly lotes: LotesExecucaoPrecoAmazon;
      /** The run is `cancelada`. */
      readonly cancelada: boolean;
    };

/**
 * ONE end onto the run's ledger (module header): the entry naming the batch
 * `execucaoIdLote` of the CURRENT run (and of `execucaoIdRun`, when the caller
 * knows the run), recorded only while it holds none, through the run's one
 * write on its read's precondition. Answers what it found, with that read's
 * clock.
 *
 * @throws {ExecucaoPrecoEmConflitoError} every attempt lost its precondition.
 */
async function registrarNoLivro(
  db: Firestore,
  contaId: string,
  e: {
    readonly execucaoIdRun: string | null;
    readonly execucaoIdLote: string;
    readonly desfecho: DesfechoLotePrecoAmazon;
    readonly motivoSemEnvio: MotivoSemEnvioLotePrecoAmazon | null;
  },
): Promise<LivroLotePrecoAmazon & { readonly relogio: Timestamp }> {
  const r = await escreverExecucaoPrecoAmazon(
    db,
    contaId,
    mascaraExecucaoPrecoAmazon([...CAMPOS_LIVRO_LOTE_PRECO_AMAZON]),
    (lida) => {
      const run = lida.estado;
      if (run === null || (e.execucaoIdRun !== null && run.execucaoId !== e.execucaoIdRun)) {
        return { escrita: null, resposta: { tipo: 'outra-execucao' } as LivroLotePrecoAmazon };
      }
      const achado = Object.entries(run.lotes).find(
        ([, lote]) => lote.execucaoIdLote === e.execucaoIdLote,
      );
      if (achado === undefined) {
        return { escrita: null, resposta: { tipo: 'sem-lote' } as LivroLotePrecoAmazon };
      }
      const [indice, lote] = achado;
      const cancelada = run.fase === FASE_EXECUCAO_PRECO_AMAZON.cancelada;
      if (lote.desfecho !== null) {
        return {
          escrita: null,
          resposta: {
            tipo: 'ja-registrado',
            indice,
            lotes: run.lotes,
            cancelada,
          } as LivroLotePrecoAmazon,
        };
      }
      const lotes: LotesExecucaoPrecoAmazon = {
        ...run.lotes,
        [indice]: { ...lote, desfecho: e.desfecho, motivoSemEnvio: e.motivoSemEnvio },
      };
      return {
        escrita: { tipo: 'campos', campos: { lotes } },
        resposta: { tipo: 'registrado', indice, lotes, cancelada } as LivroLotePrecoAmazon,
      };
    },
  );
  return { ...r.resposta, relogio: r.lida.readTime };
}

/**
 * Whether another batch than `indice` of the ledger is recorded FAILED (module
 * header); a `cancelada` run's expiry is no failure.
 */
function outroLoteFalhou(
  lotes: LotesExecucaoPrecoAmazon,
  indice: string,
  cancelada: boolean,
): boolean {
  return Object.entries(lotes).some(([k, lote]) => {
    if (k === indice || lote.desfecho === null) return false;
    if (DESFECHOS_QUE_FALHAM_PRECO_AMAZON.has(lote.desfecho)) return true;
    return (
      lote.desfecho === DESFECHO_LOTE_PRECO_AMAZON.semEnvio &&
      lote.motivoSemEnvio !== null &&
      SEM_ENVIO_QUE_FALHA_PRECO_AMAZON.has(lote.motivoSemEnvio) &&
      !(cancelada && lote.motivoSemEnvio === MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.loteExpirado)
    );
  });
}

/** Whether another batch than `indice` of the ledger is recorded `concluido` (module header). */
function outroLoteConcluido(lotes: LotesExecucaoPrecoAmazon, indice: string): boolean {
  return Object.entries(lotes).some(
    ([k, lote]) => k !== indice && lote.desfecho === DESFECHO_LOTE_PRECO_AMAZON.concluido,
  );
}

/** The batch a recovery is about: the payload's own id without a feed, else the record's. */
async function loteDaRecuperacao(
  ctx: ContextoLoteAmazon,
  r: RecuperacaoLoteAmazon,
): Promise<string | null> {
  if (r.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.incerto) return r.referencia;
  const [snap] = await ctx.db.getAll(
    feedAmazonCollection.docRef(
      ctx.db,
      {},
      idRegistroFeedAmazon(ctx.contexto.integracaoId, r.referencia),
    ),
    { fieldMask: [...CAMPOS_REGISTRO_LOTE_PRECO_AMAZON] },
  );
  const execucaoId = dadosDe(snap)?.execucaoId;
  return typeof execucaoId === 'string' ? execucaoId : null;
}

/** One recovery (module header): the batch's end on the ledger, a re-raise, never a re-send. */
async function recuperar(
  ctx: ContextoLoteAmazon,
  r: RecuperacaoLoteAmazon,
  raiz: RaizLoteAmazon,
): Promise<DesfechoRecuperacaoLoteAmazon> {
  const contaId = ctx.contexto.integracaoId;
  if (r.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.vez) {
    registrar(ctx.logger, contaId, 'INFO', '[amazon] feed preco: recuperação vez sem efeito', {
      fase: FASE_PROVEDOR_PRECO_AMAZON.livro,
      desfecho: r.desfecho,
      livro: 'nada',
    });
    return { nada: true };
  }
  const execucaoIdLote = await loteDaRecuperacao(ctx, r);
  if (execucaoIdLote === null) {
    registrar(ctx.logger, contaId, 'WARNING', '[amazon] feed preco: recuperação sem lote', {
      fase: FASE_PROVEDOR_PRECO_AMAZON.livro,
      desfecho: r.desfecho,
      livro: 'sem-registro',
    });
    return { nada: true };
  }
  const livro = await registrarNoLivro(ctx.db, contaId, {
    execucaoIdRun: null,
    execucaoIdLote,
    desfecho: r.desfecho,
    motivoSemEnvio: null,
  });
  let levantado = false;
  if (livro.tipo === 'registrado' || livro.tipo === 'ja-registrado') {
    // This end is THE one on record: written now, or the same end by an earlier attempt.
    const proprio =
      livro.tipo === 'registrado' || livro.lotes[livro.indice]?.desfecho === r.desfecho;
    const reergue =
      r.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.concluido
        ? outroLoteFalhou(livro.lotes, livro.indice, livro.cancelada)
        : proprio &&
          DESFECHOS_QUE_FALHAM_PRECO_AMAZON.has(r.desfecho) &&
          outroLoteConcluido(livro.lotes, livro.indice);
    if (reergue) {
      await levantarFalhaDoFeed(ctx, raiz, livro.relogio);
      levantado = true;
    }
  }
  registrar(ctx.logger, contaId, 'INFO', '[amazon] feed preco: fim do lote no livro da execução', {
    fase: FASE_PROVEDOR_PRECO_AMAZON.livro,
    desfecho: r.desfecho,
    execucaoIdLote,
    livro: livro.tipo,
    lote: livro.tipo === 'registrado' || livro.tipo === 'ja-registrado' ? livro.indice : null,
    levantado,
  });
  return { nada: true };
}

/** An end without a send onto the ledger (module header, `aoFimSemEnvio`). */
async function aoFimSemEnvio(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
  fim: FimSemEnvioLote,
  raiz: RaizLoteAmazon,
): Promise<void> {
  const contaId = ctx.contexto.integracaoId;
  const lote = blocosDe(entrada);
  const motivoSemEnvio = MOTIVO_SEM_ENVIO_DO_FIM[fim];
  let livro: (LivroLotePrecoAmazon & { readonly relogio: Timestamp }) | null;
  try {
    livro = await registrarNoLivro(ctx.db, contaId, {
      execucaoIdRun: lote.execucaoIdRun,
      execucaoIdLote: entrada.execucaoId,
      desfecho: DESFECHO_LOTE_PRECO_AMAZON.semEnvio,
      motivoSemEnvio,
    });
  } catch (err) {
    // Rule 6: only the run's own conflict class; a retry of the send would repeat its end.
    if (!(err instanceof ExecucaoPrecoEmConflitoError)) throw err;
    livro = null;
  }
  // The expiry raises when it is THE end on record: written now, or by an earlier attempt.
  const registrado =
    livro?.tipo === 'registrado' ||
    (livro?.tipo === 'ja-registrado' &&
      livro.lotes[livro.indice]?.motivoSemEnvio === motivoSemEnvio);
  let levantado = false;
  // A cancelled run's batch would have stood down: its expiry is no failure.
  const cancelada =
    (livro?.tipo === 'registrado' || livro?.tipo === 'ja-registrado') && livro.cancelada;
  if (livro !== null && registrado && !cancelada && fim === FIM_SEM_ENVIO_LOTE.loteExpirado) {
    await levantarFalhaDoFeed(ctx, raiz, livro.relogio);
    levantado = true;
  }
  registrar(
    ctx.logger,
    contaId,
    livro === null ? 'WARNING' : 'INFO',
    '[amazon] feed preco: lote sem envio no livro da execução',
    {
      fase: FASE_PROVEDOR_PRECO_AMAZON.livro,
      fim,
      execucaoIdRun: lote.execucaoIdRun,
      livro: livro === null ? 'em-conflito' : livro.tipo,
      levantado,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                              repassarParaPatches                           */
/* -------------------------------------------------------------------------- */

/** A batch's canary members handed to price tasks (module header). */
async function repassarParaPatches(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
  skus: readonly string[],
  dados: DadosLotePrecoAmazon,
  raiz: RaizLoteAmazon,
): Promise<{ readonly tarefas: number }> {
  if (dados.parada !== null) return { tarefas: 0 };
  const lote = blocosDe(entrada);
  const contaId = ctx.contexto.integracaoId;
  const solicitadoEmMs = ctx.agora();
  const tarefas = skus.flatMap((sku): TarefaPrecoSkuAmazon[] => {
    const m = dados.membros.get(sku);
    if (m === undefined) return [];
    const t = tarefaPrecoSkuAmazonSchema.safeParse({
      v: VERSAO_TAREFA_LOTE_AMAZON,
      tipo: TIPO_TAREFA_PRECO_AMAZON.sku,
      contaId,
      sku,
      origem: ORIGEM_TAREFA_PRECO_AMAZON.execucao,
      // Named by the RUN, never by this batch's own id: a run's task.
      referencia: lote.execucaoIdRun,
      parte: m.parte,
      baixarPreco: dados.baixarPreco,
      solicitadoEmMs,
      codigosAntes: [],
    });
    return t.success ? [t.data] : [];
  });
  if (tarefas.length === 0) return { tarefas: 0 };
  const produtor = raiz.produtorPreco;
  if (produtor === undefined) {
    throw new TypeError('provedorLotePreco.ts: a raiz não liga o produtor de preço');
  }
  const r = await produtor().enfileirarLote(tarefas);
  return { tarefas: r.enfileiradas + r.jaEnfileiradas };
}
