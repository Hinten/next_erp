/**
 * ONE page of a price RUN, and its decision step (step 13, PR 13-e): a
 * `preco-pagina` task on the jobs queue (`processAmazonListingsJob`), bound by
 * `functions/src/filaLotes.ts`. A page walks one page of the conta's link docs,
 * reads Amazon's live offers of the SKUs it evaluates, and writes what differs
 * as ONE part of the run; past the walk's last page, the same dispatch runs
 * Decide. Nothing here PATCHes or posts a feed: every send is a `preco-sku`
 * task (13-d's), which recomputes the faixa when it runs. The run's claim,
 * re-kick, cancel and status are `inicioExecucaoPreco.ts`'s; the run's ONE
 * write is `execucaoPrecoFirestore.ts`'s; the parts' I/O is
 * `divergenciasPrecoFirestore.ts`'s. Built beside the stock reconcile's page,
 * never through it.
 *
 * ## A page ({@link paginaPrecoAmazon}), in this order
 *
 * Under ONE budget, {@link ORCAMENTO_PAGINA_PRECO_MS} (400 s), read before every
 * Firestore page, every batch of link queries and every Amazon call:
 *
 *  1. the price valve, read ONCE and logged, the preview flag applied
 *     (`valvulaPrecoEfetiva`): `off` ⇒ ZERO Firestore operations, the page
 *     line, the end. The run then stalls for a click to re-kick or reclaim
 *     (a re-kick's name stays held for about an hour: `inicioExecucaoPreco.ts`).
 *     `dry-run` and `on` walk alike: the form is Decide's;
 *  2. the context (the read switch first): a switch, conta or credential
 *     refusal ⇒ the line, the end;
 *  3. **step 0**, from a FRESH read of the run ({@link CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON}):
 *     no run, another `execucaoId`, a page past `proximaPagina`, or a `fase`
 *     other than `paginando`/`decidindo` ⇒ stop; `decidindo` ⇒ Decide (from the
 *     stored plan when one exists); a page behind ⇒ page `proximaPagina`
 *     re-enqueued under ITS name, stop; equal ⇒ on;
 *  4. the conta's tabelas, off ONE raw by-id read of the conta masked to the
 *     two refs (`tabelasDePrecoDaContaAmazon`): no normal tabela ⇒ the run
 *     closed `falhou` (`sem-tabela-normal`);
 *  5. the walk page, its grouping and the smallest-path dedupe
 *     (`listings/varreduraVinculos.ts`, 300 link docs), at the price masks;
 *  6. the batched link reader (`listings/avaliacaoLoteVinculos.ts`) with the
 *     price masks and the price binding of the verdict, then each SKU's price
 *     sources (`fontesPrecoDaUnidadeAmazon`);
 *  7. Amazon's live read of every SKU the verdict binds
 *     (`listings/leituraLoteListings.ts`: summaries, attributes, issues,
 *     relationships; every miss confirmed, as the deadline allows);
 *  8. each SKU classified (`paginaPreco.ts`, the run's consent, no feed-recent
 *     rule) as read at the instant step 7 STARTED (never its end, which would
 *     age our own recent patch): the page's counters, its part's members and
 *     its decrease sample;
 *  9. with at least one sendable SKU, part `proximaParte` WRITTEN (an
 *     overwrite by id) — at `MAX_PARTES_EXECUCAO_PRECO_AMAZON`, nothing is
 *     written and the run closes `truncada` (`partes-demais`);
 * 10. the run update, AFTER the part, on step 0's read (the run's one write):
 *     the cursors, the counters and the sample summed, `proximaPagina`,
 *     `proximaParte` and `itensPorParte` when a part was written,
 *     `progressoEmMs`, and on page 0 `relogioInicio` = step 0's `readTime`. A
 *     crash between 9 and 10 re-runs the page, which rewrites the SAME part id;
 * 11. the next page enqueued NAMED (`nomePaginaPrecoAmazon`), or, past the last
 *     page, Decide in this dispatch.
 *
 * A walk that cannot go on (the budget, or a full page whose last doc cannot be
 * a cursor), a link read or a live read stopped by the budget ⇒ the run closed
 * `truncada`. A 429 ⇒ the run's `progressoEmMs` stamped FIRST (this page still
 * its next), then the SAME page re-enqueued UNNAMED
 * (`ATRASO_PAUSA_PAGINA_PRECO_S`), so the stall rule never takes a throttled
 * page for a lost one. Any other failure is thrown for the queue's retry.
 *
 * ## Decide (`fase: 'decidindo'`)
 *
 *  1. The conta avisos FIRST, clocked by `relogioInicio` (the run's first
 *     read): `preco-faixa-invertida` raised when the walk counted an inverted
 *     faixa, else RESOLVED; `preco-recusado-pela-amazon` raised when it counted
 *     a listing with a blocking price issue, else RESOLVED.
 *  2. The plan: the STORED `decisao` when the run has one (a retried Decide
 *     enqueues the same names, each held one counted), else
 *     `decidirFimPrecoAmazon` over the run's counts and the effective valve's
 *     batch form, WRITTEN onto the run before any enqueue.
 *  3. `preco-reducao-em-massa` raised for `reducao-em-massa`, RESOLVED by every
 *     other plan.
 *  4. The plan carried out: `reducao-em-massa`, `nada` ⇒ nothing; `dry-run` ⇒
 *     the line's count and the run's decrease sample; `canario` ⇒ EVERY part
 *     read by id, one task per SKU the canary list names; `tarefas` ⇒ the parts
 *     read by id, per SKU `decidirAlvo`: `on` ⇒ one task, any other mode counted;
 *     `lotes` ⇒ a WARNING `feed-necessario` line, nothing enqueued (the feed
 *     batches are a later PR's). Every task is `origem: 'execucao'`, its
 *     `referencia` the run, its `parte` the part that counted it, the run's
 *     consent, `solicitadoEmMs` this dispatch's clock: the task then reads its
 *     part's floor and stands down with the run.
 *  5. `fase: 'concluida'`, LAST.
 *
 * No delay on any send: a price has no order-import race to wait out.
 *
 * ## Rule 7
 *
 * Every run write goes through the run's ONE write, decided from a read and
 * written on its precondition (re-derived, at most three attempts): each
 * re-derive re-checks that THIS dispatch still holds the run (the run, the page
 * and the phase), else it writes nothing (`vez-perdida`). The part is the
 * holding page's overwrite by id, written before the run update. Every enqueue
 * is NAMED but the 429's pause. No transaction, no batch.
 *
 * ONE `evento: 'preco'` line per dispatch (`fase: 'execucao'`, `etapa:
 * 'pagina'`): counts, closed codes, ids, the page's and the run's decrease
 * samples, the timing and the lowest `x-amzn-RateLimit-Limit` the page saw.
 *
 * ⚠️ D11: nothing here reaches Amazon unless the context does (the read switch
 * first), and no write leaves for Amazon here.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { AmazonThrottleError } from '@delfrance/integrations-amazon-sp-api';
import {
  DECISAO_EXECUCAO_PRECO_AMAZON,
  type DecisaoExecucaoPrecoAmazon,
  type EnvioPrecoAmazon,
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  type ItemDivergenciaPrecoAmazon,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_FIM_EXECUCAO_PRECO_AMAZON,
  type MotivoFimExecucaoPrecoAmazon,
  type TabelasDePrecoAmazon,
  type TimestampLike,
  fontesPrecoDaUnidadeAmazon,
  tabelasDePrecoDaContaAmazon,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_LISTINGS_AMAZON,
  type AcaoAvisoContaListingsAmazon,
  type MotivoContaPrecoAmazon,
  sincronizarAvisoContaListingsAmazon,
} from '../avisos/avisos';
import type { ContextoAmazon, ContextoAmazonDeps } from '../core/contexto';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  decidirAlvo,
  decidirLote,
  lerValvula,
  registrarValvulaAmazon,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type { RegistroLoteAmazon } from '../feeds/incertoFeed';
import { VERSAO_TAREFA_LOTE_AMAZON } from '../feeds/tarefaLote';
import {
  DESFECHO_AVALIACAO_VINCULOS_AMAZON,
  type VinculoAvaliadoAmazon,
  avaliarVinculosEmLoteAmazon,
} from '../listings/avaliacaoLoteVinculos';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import {
  DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON,
  DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON,
  type LeituraLoteListingsAmazon,
  lerListingsEmLoteAmazon,
} from '../listings/leituraLoteListings';
import { INCLUIR_LEITURA_PRECO } from '../listings/listingsAmazon';
import { camposDoResolverListingAmazon } from '../listings/resolverVinculo';
import {
  CONTADOR_VARREDURA_VINCULOS_AMAZON,
  paginaVarreduraVinculosAmazon,
  varreduraVinculosConcluida,
} from '../listings/varreduraVinculos';
import {
  FALHA_LEITURA_AMAZON,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import {
  lerPartesDivergenciaPrecoAmazon,
  gravarParteDivergenciaPrecoAmazon,
} from './divergenciasPrecoFirestore';
import {
  type LeituraExecucaoPrecoAmazon,
  type ResultadoEscritaExecucaoPrecoAmazon,
  escreverExecucaoPrecoAmazon,
  lerExecucaoPrecoAmazon,
  mascaraExecucaoPrecoAmazon,
  somarPaginaNaExecucaoPrecoAmazon,
} from './execucaoPrecoFirestore';
import { FASE_LOG_EXECUCAO_PRECO, type ProdutorExecucaoPrecoAmazon } from './inicioExecucaoPreco';
import { type VereditoValvulaPrecoAmazon, valvulaPrecoEfetiva } from './modoPreco';
import {
  type EntradaSkuPrecoAmazon,
  type ResumoPaginaPrecoAmazon,
  decidirFimPrecoAmazon,
  lotesDePartesPrecoAmazon,
  parteDaPaginaPrecoAmazon,
  resumirPaginaPrecoAmazon,
} from './paginaPreco';
import {
  CAMPOS_CONTA_PRECO_AMAZON,
  type CarregadorDeContextoPrecoAmazon,
  REGRA_VINCULO_PRECO_AMAZON,
} from './processarPreco';
import type { ProdutorPrecoAmazon } from './produtorPreco';
import {
  ORIGEM_TAREFA_PRECO_AMAZON,
  TIPO_TAREFA_PRECO_AMAZON,
  type TarefaPaginaPrecoAmazon,
  type TarefaPrecoSkuAmazon,
} from './tarefaPreco';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** One page's work budget (400 s), inside the jobs queue's 540-s timeout. */
export const ORCAMENTO_PAGINA_PRECO_MS = 400_000;

/** The run fields a page decides from (module header, step 0). */
export const CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON = [
  'execucaoId',
  'fase',
  'baixarPreco',
  'confirmarReducaoEmMassa',
  'cursores',
  'proximaPagina',
  'proximaParte',
  'itensPorParte',
  'contagens',
  'amostraReducoes',
  'decisao',
  'progressoEmMs',
  'relogioInicio',
] as const;

const LEITURA_PAGINA = mascaraExecucaoPrecoAmazon(CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON);

/** The run as a page reads it. */
export type ExecucaoPaginaPrecoAmazon = Pick<
  ExecucaoPrecoAmazon,
  (typeof CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON)[number]
>;

/** How one page dispatch ended (closed). */
export const ACAO_PAGINA_PRECO_AMAZON = {
  /** Step 1: the price valve is `off` — nothing read. */
  valvulaDesligada: 'valvula-desligada',
  /** Step 2: the read switch, the conta or its credential refused the context. */
  contextoRecusado: 'contexto-recusado',
  /** Step 0: no run, another run, an ended one, or a page past the next. */
  naoEDono: 'nao-e-dono',
  /** Step 0: a page behind the next — the next re-enqueued under its name. */
  adiantada: 'adiantada',
  /** A 429: the progress stamped, the same page re-enqueued unnamed. */
  limitada: 'limitada',
  /** A write found the run no longer this dispatch's (a cancel, a reclaim). */
  vezPerdida: 'vez-perdida',
  /** Steps 3–11: the page walked, the next page enqueued. */
  paginaConcluida: 'pagina-concluida',
  /** Decide ran and the run ended `concluida`. */
  concluida: 'concluida',
  /** The run closed `truncada`. */
  truncada: 'truncada',
  /** The run closed `falhou`. */
  falhou: 'falhou',
} as const;
export type AcaoPaginaPrecoAmazon =
  (typeof ACAO_PAGINA_PRECO_AMAZON)[keyof typeof ACAO_PAGINA_PRECO_AMAZON];

/** The motivo of a `lotes` plan's line: the batches are a later PR's, nothing is enqueued. */
export const MOTIVO_FEED_NECESSARIO_PRECO_AMAZON = 'feed-necessario';

/** Everything one page dispatch needs — bound by the jobs root, doubles in the tests. */
export interface DepsPaginaPrecoAmazon {
  /** The process environment: the read switch, the LWA pair, the price valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  readonly registro: RegistroLoteAmazon;
  /** REQUIRED, never the global: the context's client and its refresh take it. */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
  /** The context loader (the read switch FIRST). */
  readonly carregarContexto: CarregadorDeContextoPrecoAmazon;
  /** The run's page producer — built only when a page is enqueued. */
  readonly produtorPaginas: () => ProdutorExecucaoPrecoAmazon;
  /** The price task's producer — built only when Decide enqueues a task. */
  readonly produtorPreco: () => ProdutorPrecoAmazon;
  /** The validation-preview flag (`AMAZON_PRECO_SO_VALIDACAO`), as the root read it. */
  readonly soValidacao: boolean;
  /** A sleep of `ms` milliseconds: the live read's pacing between two Amazon calls. */
  readonly esperar: (ms: number) => Promise<void>;
}

/** What one page walked and found, for its line. */
export interface ContagemPaginaPrecoAmazon {
  /** Link docs the walk read. */
  readonly vinculos: number;
  /** SKUs the page evaluated (its own, after the dedupe). */
  readonly avaliados: number;
  readonly jaVistos: number;
  /** SKUs Amazon was asked about (the verdict bound them). */
  readonly lidosNaAmazon: number;
  readonly iguais: number;
  readonly enviaveis: number;
  readonly sobe: number;
  readonly desce: number;
  readonly quedaExcessiva: number;
  readonly direcaoDesconhecida: number;
  readonly reducaoSemConsentimento: number;
  readonly precoAtualIlegivel: number;
  readonly faixaInvertida: number;
  readonly tipoProdutoIlegivel: number;
  readonly semPreco: number;
  readonly semCaminho: number;
  readonly temPrecoComDesconto: number;
  readonly temOfertaB2B: number;
  readonly fechada: number;
  readonly naoConfirmados: number;
  readonly problemasDePreco: number;
  /** Every other count by its motivo, `motivo:n` joined with `,`; `null` when none. */
  readonly recusas: string | null;
  /** The page's largest decreases, `sku:antes>depois` joined with `,`; `null` when none. */
  readonly amostra: string | null;
  readonly buscas: number;
  readonly gets: number;
}

/** What Decide did, for the line. */
export interface DecisaoPaginaPrecoAmazon {
  readonly decisao: DecisaoExecucaoPrecoAmazon;
  /** The plan was the run's stored one (a retried Decide). */
  readonly planoGuardado: boolean;
  /** Tasks enqueued now, and those Cloud Tasks already held. */
  readonly tarefas: number;
  readonly jaEnfileiradas: number;
  /** Sendable SKUs a dry-run (or a non-`on` target) only counted. */
  readonly simulados: number;
  /** Parts the plan read that no longer exist (their SKUs not sent). */
  readonly partesAusentes: number;
  /** The batches a `lotes` plan would name. */
  readonly lotes: number;
}

/** What one page dispatch did (logged ONCE). */
export interface ResultadoPaginaPrecoAmazon {
  readonly acao: AcaoPaginaPrecoAmazon;
  /** Why it ended where it did (a context token, a run's end motivo, `feed-necessario`). */
  readonly motivo: string | null;
  /** The page's own counts; `null` when it walked nothing. */
  readonly pagina: ContagemPaginaPrecoAmazon | null;
  /** The part this page wrote; `null` when none. */
  readonly parte: number | null;
  readonly decide: DecisaoPaginaPrecoAmazon | null;
  /** Avisos synced: `<motivo>:<acao>` joined with `,`. */
  readonly avisos: string | null;
  /** The run's decrease sample at Decide, joined with `,`. */
  readonly amostraExecucao: string | null;
  /** The lowest `x-amzn-RateLimit-Limit` this page's live read saw; `null` when none. */
  readonly limiteTaxa: number | null;
  /** The preview flag shaped the valve. */
  readonly previa: boolean;
  /** `validacao-com-todos` when the flag met `on` + `*` (an ERROR line). */
  readonly veredito: VereditoValvulaPrecoAmazon | null;
  /** ms — the dispatch's duration. */
  readonly duracaoMs: number;
}

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

/** A list as one campo: joined with `,`, `null` when empty. */
function juntar(lista: readonly string[]): string | null {
  return lista.length === 0 ? null : lista.join(',');
}

/** A counter map as one campo, `chave:n` in key order. */
function juntarContagens(contagens: Readonly<Record<string, number>>): string | null {
  return juntar(
    Object.entries(contagens)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([chave, n]) => `${chave}:${String(n)}`),
  );
}

/** One page dispatch, bound: its payload, deps, the effective valve and the deadline. */
interface Execucao {
  readonly db: Firestore;
  readonly t: TarefaPaginaPrecoAmazon;
  readonly deps: DepsPaginaPrecoAmazon;
  readonly valvula: ReturnType<typeof valvulaPrecoEfetiva>['valvula'];
  readonly previa: boolean;
  readonly veredito: VereditoValvulaPrecoAmazon | null;
  /** ms — when the dispatch began. */
  readonly inicioMs: number;
  /** ms — the instant past which the page starts no more reads. */
  readonly prazoMs: number;
}

/** What a result carries besides its action and what the dispatch itself knows. */
type ExtraPaginaPrecoAmazon = Partial<
  Omit<ResultadoPaginaPrecoAmazon, 'acao' | 'previa' | 'veredito' | 'duracaoMs'>
>;

/** A result for `e`, every field not given empty. */
function resultado(
  e: Pick<Execucao, 'deps' | 'previa' | 'veredito' | 'inicioMs'>,
  acao: AcaoPaginaPrecoAmazon,
  extra: ExtraPaginaPrecoAmazon = {},
): ResultadoPaginaPrecoAmazon {
  return {
    acao,
    motivo: null,
    pagina: null,
    parte: null,
    decide: null,
    avisos: null,
    amostraExecucao: null,
    limiteTaxa: null,
    ...extra,
    previa: e.previa,
    veredito: e.veredito,
    duracaoMs: Math.max(0, e.deps.agora() - e.inicioMs),
  };
}

const ACOES_EM_WARNING: ReadonlySet<AcaoPaginaPrecoAmazon> = new Set([
  ACAO_PAGINA_PRECO_AMAZON.contextoRecusado,
  ACAO_PAGINA_PRECO_AMAZON.limitada,
  ACAO_PAGINA_PRECO_AMAZON.vezPerdida,
  ACAO_PAGINA_PRECO_AMAZON.truncada,
  ACAO_PAGINA_PRECO_AMAZON.falhou,
]);

/**
 * The line's severity: ERROR for the preview flag met with `*`; WARNING for an
 * end a person should look at (a throttled or lost page, a run cut short, a plan
 * that needs the feed path or stopped a mass decrease, a part gone); else INFO.
 */
export function severidadePaginaPrecoAmazon(r: ResultadoPaginaPrecoAmazon): SeveridadeAmazon {
  if (r.veredito !== null) return 'ERROR';
  if (ACOES_EM_WARNING.has(r.acao)) return 'WARNING';
  const d = r.decide;
  if (
    d !== null &&
    (d.decisao === DECISAO_EXECUCAO_PRECO_AMAZON.lotes ||
      d.decisao === DECISAO_EXECUCAO_PRECO_AMAZON.reducaoEmMassa ||
      d.partesAusentes > 0)
  ) {
    return 'WARNING';
  }
  return 'INFO';
}

/** The ONE line per page dispatch (module header): counts, closed codes and ids. */
function registrarPagina(
  deps: DepsPaginaPrecoAmazon,
  t: TarefaPaginaPrecoAmazon,
  r: ResultadoPaginaPrecoAmazon,
): void {
  const p = r.pagina;
  const d = r.decide;
  const campos: CamposLogAmazon = {
    fase: FASE_LOG_EXECUCAO_PRECO,
    etapa: 'pagina',
    acao: r.acao,
    motivo: r.motivo,
    execucaoId: t.execucaoId,
    pagina: t.pagina,
    vinculos: p?.vinculos ?? null,
    avaliados: p?.avaliados ?? null,
    jaVistos: p?.jaVistos ?? null,
    lidosNaAmazon: p?.lidosNaAmazon ?? null,
    iguais: p?.iguais ?? null,
    enviaveis: p?.enviaveis ?? null,
    sobe: p?.sobe ?? null,
    desce: p?.desce ?? null,
    quedaExcessiva: p?.quedaExcessiva ?? null,
    direcaoDesconhecida: p?.direcaoDesconhecida ?? null,
    reducaoSemConsentimento: p?.reducaoSemConsentimento ?? null,
    precoAtualIlegivel: p?.precoAtualIlegivel ?? null,
    faixaInvertida: p?.faixaInvertida ?? null,
    tipoProdutoIlegivel: p?.tipoProdutoIlegivel ?? null,
    semPreco: p?.semPreco ?? null,
    semCaminho: p?.semCaminho ?? null,
    temPrecoComDesconto: p?.temPrecoComDesconto ?? null,
    temOfertaB2B: p?.temOfertaB2B ?? null,
    fechada: p?.fechada ?? null,
    naoConfirmados: p?.naoConfirmados ?? null,
    problemasDePreco: p?.problemasDePreco ?? null,
    recusas: p?.recusas ?? null,
    amostra: p?.amostra ?? null,
    buscas: p?.buscas ?? null,
    gets: p?.gets ?? null,
    limiteTaxa: r.limiteTaxa,
    parte: r.parte,
    decisao: d?.decisao ?? null,
    planoGuardado: d?.planoGuardado ?? null,
    tarefas: d?.tarefas ?? null,
    jaEnfileiradas: d?.jaEnfileiradas ?? null,
    simulados: d?.simulados ?? null,
    partesAusentes: d?.partesAusentes ?? null,
    lotes: d?.lotes ?? null,
    amostraExecucao: r.amostraExecucao,
    avisos: r.avisos,
    previa: r.previa,
    veredito: r.veredito,
    duracaoMs: r.duracaoMs,
  };
  registrarEventoAmazon(
    deps.logger,
    'preco',
    severidadePaginaPrecoAmazon(r),
    `[amazon/preco] execução: página (${r.acao})`,
    campos,
    {
      conta: t.contaId,
      fluxo: FLUXO_AMAZON.preco,
      tentativa: deps.registro.tentativa,
      idTarefa: deps.registro.idTarefa,
    },
  );
}

/** The read a written decision leaves: the read's state with the write merged in, on its commit. */
function depoisDaEscrita<R>(
  r: ResultadoEscritaExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon, R>,
): LeituraExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon> {
  const { estado } = r.lida;
  if (estado === null || r.writeTime === null || r.escrito === null) {
    throw new TypeError('execucaoPreco.ts: uma escrita da execução sempre parte de uma execução');
  }
  return {
    estado: { ...estado, ...r.escrito } as ExecucaoPaginaPrecoAmazon,
    updateTime: r.writeTime,
    readTime: r.writeTime,
  };
}

/** Whether THIS page still holds the run (step 0's check, re-derived by every page write). */
function donoDaPagina(
  t: TarefaPaginaPrecoAmazon,
): (run: ExecucaoPaginaPrecoAmazon | null) => run is ExecucaoPaginaPrecoAmazon {
  return (run): run is ExecucaoPaginaPrecoAmazon =>
    run !== null &&
    run.execucaoId === t.execucaoId &&
    run.fase === FASE_EXECUCAO_PRECO_AMAZON.paginando &&
    run.proximaPagina === t.pagina;
}

/** Whether THIS run is still deciding (every Decide write re-derives it). */
function donoDoDecide(
  t: TarefaPaginaPrecoAmazon,
): (run: ExecucaoPaginaPrecoAmazon | null) => run is ExecucaoPaginaPrecoAmazon {
  return (run): run is ExecucaoPaginaPrecoAmazon =>
    run !== null &&
    run.execucaoId === t.execucaoId &&
    run.fase === FASE_EXECUCAO_PRECO_AMAZON.decidindo;
}

/**
 * A patch of THIS run, decided on `lida` while `dono` holds (the run's one
 * write re-derives it on a lost precondition): the read after the write, or
 * `null` once `dono` no longer holds.
 */
async function atualizar(
  e: Execucao,
  lida: LeituraExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon>,
  dono: (run: ExecucaoPaginaPrecoAmazon | null) => run is ExecucaoPaginaPrecoAmazon,
  patch: (run: ExecucaoPaginaPrecoAmazon) => Readonly<Partial<ExecucaoPrecoAmazon>>,
): Promise<LeituraExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon> | null> {
  const r = await escreverExecucaoPrecoAmazon(
    e.db,
    e.t.contaId,
    LEITURA_PAGINA,
    (atual) =>
      dono(atual.estado)
        ? { escrita: { tipo: 'campos', campos: patch(atual.estado) }, resposta: true }
        : { escrita: null, resposta: false },
    lida,
  );
  return r.resposta ? depoisDaEscrita(r) : null;
}

/** The run closed `truncada` or `falhou` by this page (no aviso: a cut-short run resolves none). */
async function fecharPagina(
  e: Execucao,
  lida: LeituraExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon>,
  fase: typeof FASE_EXECUCAO_PRECO_AMAZON.truncada | typeof FASE_EXECUCAO_PRECO_AMAZON.falhou,
  motivo: MotivoFimExecucaoPrecoAmazon,
  extra: ExtraPaginaPrecoAmazon = {},
): Promise<ResultadoPaginaPrecoAmazon> {
  const fechado = await atualizar(e, lida, donoDaPagina(e.t), () => ({
    fase,
    motivo,
    progressoEmMs: e.deps.agora(),
  }));
  if (fechado === null) {
    return resultado(e, ACAO_PAGINA_PRECO_AMAZON.vezPerdida, { ...extra, motivo });
  }
  return resultado(
    e,
    fase === FASE_EXECUCAO_PRECO_AMAZON.truncada
      ? ACAO_PAGINA_PRECO_AMAZON.truncada
      : ACAO_PAGINA_PRECO_AMAZON.falhou,
    { ...extra, motivo },
  );
}

/** The conta RAW, ONE by-id read masked to the two tabela refs, never cached (module header, step 4). */
async function lerTabelas(db: Firestore, contaId: string): Promise<TabelasDePrecoAmazon> {
  const [snap] = await db.getAll(integracaoCollection.docRef(db, {}, contaId), {
    fieldMask: [...CAMPOS_CONTA_PRECO_AMAZON],
  });
  return tabelasDePrecoDaContaAmazon(snap?.exists === true ? snap.data() : null);
}

/* -------------------------------------------------------------------------- */
/*                                  the page                                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE page dispatch (module header): its own line, written for every end it
 * decides. A throw (Firestore, the producers, a non-429 Amazon failure) leaves
 * for the jobs queue's retry, through the jobs root's sanitizing boundary.
 */
export async function paginaPrecoAmazon(
  db: Firestore,
  t: TarefaPaginaPrecoAmazon,
  deps: DepsPaginaPrecoAmazon,
): Promise<ResultadoPaginaPrecoAmazon> {
  const r = await executarPagina(db, t, deps);
  registrarPagina(deps, t, r);
  return r;
}

async function executarPagina(
  db: Firestore,
  t: TarefaPaginaPrecoAmazon,
  deps: DepsPaginaPrecoAmazon,
): Promise<ResultadoPaginaPrecoAmazon> {
  const inicioMs = deps.agora();

  // ---- 1: the valve FIRST, read once, logged, the preview flag applied. ----
  const lida = lerValvula(FLUXO_AMAZON.preco, deps.ambiente);
  registrarValvulaAmazon(deps.logger, lida, {
    conta: t.contaId,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });
  const efetiva = valvulaPrecoEfetiva(lida, deps.soValidacao);
  const e: Execucao = {
    db,
    t,
    deps,
    valvula: efetiva.valvula,
    previa: efetiva.previa,
    veredito: efetiva.veredito,
    inicioMs,
    prazoMs: inicioMs + ORCAMENTO_PAGINA_PRECO_MS,
  };
  if (efetiva.valvula.modo === MODO_AMAZON.off) {
    return resultado(e, ACAO_PAGINA_PRECO_AMAZON.valvulaDesligada);
  }

  // ---- 2: the context — the read switch first. ----
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro: {
      fluxo: FLUXO_AMAZON.preco,
      tentativa: deps.registro.tentativa,
      idTarefa: deps.registro.idTarefa,
    },
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await deps.carregarContexto(db, t.contaId, depsDoContexto);
  } catch (err) {
    const token = classificarFalhaDeLeituraAmazon(err);
    if (
      token !== FALHA_LEITURA_AMAZON.chamadasDesligadas &&
      token !== FALHA_LEITURA_AMAZON.contaInativa &&
      token !== FALHA_LEITURA_AMAZON.contaIndisponivel
    ) {
      throw err;
    }
    return resultado(e, ACAO_PAGINA_PRECO_AMAZON.contextoRecusado, { motivo: token });
  }

  // ---- 3: step 0, from a FRESH read of the run. ----
  const lidaRun = await lerExecucaoPrecoAmazon(db, t.contaId, LEITURA_PAGINA);
  const run = lidaRun.estado;
  if (
    run === null ||
    run.execucaoId !== t.execucaoId ||
    t.pagina > run.proximaPagina ||
    (run.fase !== FASE_EXECUCAO_PRECO_AMAZON.paginando &&
      run.fase !== FASE_EXECUCAO_PRECO_AMAZON.decidindo)
  ) {
    return resultado(e, ACAO_PAGINA_PRECO_AMAZON.naoEDono);
  }
  if (run.fase === FASE_EXECUCAO_PRECO_AMAZON.decidindo) return decidir(e, lidaRun, null);
  if (t.pagina < run.proximaPagina) {
    await deps.produtorPaginas().enfileirarPagina(t.contaId, t.execucaoId, run.proximaPagina);
    return resultado(e, ACAO_PAGINA_PRECO_AMAZON.adiantada);
  }

  // ---- 4: the conta's tabelas, RAW. ----
  const tabelas = await lerTabelas(db, t.contaId);
  if (tabelas.normalId === null) {
    return fecharPagina(
      e,
      lidaRun,
      FASE_EXECUCAO_PRECO_AMAZON.falhou,
      MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.semTabelaNormal,
    );
  }

  return caminhar(e, contexto, lidaRun, {
    normalId: tabelas.normalId,
    promocionalId: tabelas.promocionalId,
  });
}

/** The SKU's link path a send re-reads: the bound dono's first link doc. */
function caminhoDoVinculo(s: VinculoAvaliadoAmazon<EnvioPrecoAmazon>): string {
  const v = s.veredicto;
  return v.apto ? `produtos/${v.donoId}/prodAmazon/${v.linkIds[0] ?? ''}` : '';
}

/** Steps 5–11 for the page step 0 confirmed. */
async function caminhar(
  e: Execucao,
  contexto: ContextoAmazon,
  lidaRun: LeituraExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon>,
  tabelas: TabelasDePrecoAmazon & { readonly normalId: string },
): Promise<ResultadoPaginaPrecoAmazon> {
  const { db, t, deps } = e;
  const run = lidaRun.estado;
  if (run === null) throw new TypeError('execucaoPreco.ts: a página caminha sem a execução lida');
  const campos = camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.preco,
    tabelaIds:
      tabelas.promocionalId === null
        ? [tabelas.normalId]
        : [tabelas.normalId, tabelas.promocionalId],
  });
  const prazo = { agora: deps.agora, prazoMs: e.prazoMs };

  // ---- 5: the walk, its grouping and the dedupe. ----
  const pagina = await paginaVarreduraVinculosAmazon(db, t.contaId, run.cursores, {
    campos,
    prazo,
  });
  if (pagina.tipo === 'truncada') {
    return fecharPagina(
      e,
      lidaRun,
      FASE_EXECUCAO_PRECO_AMAZON.truncada,
      pagina.motivo === 'prazo'
        ? MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.prazo
        : MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.cursorIlegivel,
    );
  }

  // ---- 6: the batched link reader, at the price masks. ----
  let avaliados: readonly VinculoAvaliadoAmazon<EnvioPrecoAmazon>[] = [];
  if (pagina.aAvaliar.length > 0) {
    const avaliacao = await avaliarVinculosEmLoteAmazon(db, t.contaId, pagina.aAvaliar, {
      campos,
      regra: REGRA_VINCULO_PRECO_AMAZON,
      prazo,
      vinculosLidos: pagina.vinculosLidos,
    });
    if (avaliacao.tipo === DESFECHO_AVALIACAO_VINCULOS_AMAZON.prazo) {
      return fecharPagina(
        e,
        lidaRun,
        FASE_EXECUCAO_PRECO_AMAZON.truncada,
        MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.prazo,
      );
    }
    avaliados = avaliacao.skus;
  }

  // ---- 7: Amazon's live read of every SKU the verdict binds. ----
  // The read instant is taken BEFORE it: every SKU was read at or after it, so
  // our own recent patch counts as recent at least as long as it really was.
  const lidoEmMs = deps.agora();
  const aptos = avaliados.filter((s) => s.veredicto.apto).map((s) => s.sku);
  let leitura: LeituraLoteListingsAmazon | null = null;
  if (aptos.length > 0) {
    const sellerId = contexto.conta.selling_partner_id;
    if (typeof sellerId !== 'string' || sellerId === '') {
      // The context loader refuses a conta with no seller: only a bug reaches this.
      throw new TypeError('execucaoPreco.ts: o contexto não nomeia o vendedor');
    }
    try {
      leitura = await lerListingsEmLoteAmazon(
        { contexto, logger: deps.logger, agora: deps.agora, sellerId, esperar: deps.esperar },
        aptos,
        {
          fluxo: FLUXO_LISTING_AMAZON.preco,
          incluir: INCLUIR_LEITURA_PRECO,
          prazoMs: e.prazoMs,
          maxGets: null,
        },
      );
    } catch (err) {
      if (!(err instanceof AmazonThrottleError)) throw err;
      // Amazon throttled: no attempt spent. The progress FIRST (this page still
      // the run's next), so the stall rule never takes it for a lost page; then
      // the SAME page, unnamed, a minute later.
      const vivo = await atualizar(e, lidaRun, donoDaPagina(t), () => ({
        progressoEmMs: deps.agora(),
      }));
      if (vivo === null) return resultado(e, ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
      await deps.produtorPaginas().enfileirarPausa(t.contaId, t.execucaoId, t.pagina);
      return resultado(e, ACAO_PAGINA_PRECO_AMAZON.limitada);
    }
    if (leitura.tipo === DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON.prazo) {
      return fecharPagina(
        e,
        lidaRun,
        FASE_EXECUCAO_PRECO_AMAZON.truncada,
        MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.prazo,
        { limiteTaxa: leitura.limiteTaxa },
      );
    }
  }

  // ---- 8: each SKU classified, as read at `lidoEmMs`. ----
  const entradas: EntradaSkuPrecoAmazon[] = avaliados.map((s) => ({
    sku: s.sku,
    vinculo: caminhoDoVinculo(s),
    veredicto: s.veredicto,
    leitura: leitura?.porSku.get(s.sku) ?? {
      tipo: DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.naoConfirmado,
    },
    fontes: fontesPrecoDaUnidadeAmazon(s.entrada.unidade.raw, s.paiDaUnidade),
  }));
  const resumo = resumirPaginaPrecoAmazon(entradas, {
    tabelas,
    baixarPreco: run.baixarPreco,
    lidoEmMs,
  });
  const porChave: Record<string, number> = {};
  const somar = (chave: string, n = 1) => {
    porChave[chave] = (porChave[chave] ?? 0) + n;
  };
  for (const [chave, n] of Object.entries(pagina.porChave)) {
    if (chave !== CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto) somar(chave, n);
  }
  for (const [chave, n] of Object.entries(resumo.contagens.porChave)) somar(chave, n);
  for (const s of avaliados) {
    if (s.veredicto.apto) for (const c of s.veredicto.contagens) somar(c);
  }
  const jaVistos = pagina.porChave[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto] ?? 0;
  const contagemPagina = contagemDaPagina(resumo, {
    vinculos: pagina.vinculos,
    avaliados: pagina.aAvaliar.length,
    jaVistos,
    lidosNaAmazon: aptos.length,
    porChave,
    leitura,
  });
  const limiteTaxa = leitura?.limiteTaxa ?? null;

  // ---- 9: the part, BEFORE the run update. ----
  const destino = parteDaPaginaPrecoAmazon(run.proximaParte, resumo.itens.length);
  if (destino.acao === 'truncar') {
    return fecharPagina(
      e,
      lidaRun,
      FASE_EXECUCAO_PRECO_AMAZON.truncada,
      MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.partesDemais,
      { pagina: contagemPagina, limiteTaxa },
    );
  }
  const parte = destino.acao === 'escrever' ? destino.parte : null;
  if (parte !== null) {
    await gravarParteDivergenciaPrecoAmazon(db, {
      contaId: t.contaId,
      execucaoId: t.execucaoId,
      parte,
      itens: resumo.itens,
      agoraMs: deps.agora(),
    });
  }

  // ---- 10: the run update, on step 0's read. ----
  const concluiu = varreduraVinculosConcluida(pagina.cursores);
  const relogioInicio = lidaRun.readTime;
  const depois = await atualizar(
    e,
    lidaRun,
    (r): r is ExecucaoPaginaPrecoAmazon =>
      donoDaPagina(t)(r) && (parte === null || r.proximaParte === parte),
    (estado) => ({
      cursores: pagina.cursores,
      ...somarPaginaNaExecucaoPrecoAmazon(estado, {
        contagens: {
          ...resumo.contagens,
          lidos: pagina.vinculos,
          jaVisto: jaVistos,
          porChave,
          limiteTaxa,
        },
        amostra: resumo.amostra,
      }),
      proximaPagina: t.pagina + 1,
      ...(parte === null
        ? {}
        : {
            proximaParte: parte + 1,
            itensPorParte: [...estado.itensPorParte, resumo.itens.length],
          }),
      progressoEmMs: deps.agora(),
      fase: concluiu ? FASE_EXECUCAO_PRECO_AMAZON.decidindo : FASE_EXECUCAO_PRECO_AMAZON.paginando,
      ...(t.pagina === 0 ? { relogioInicio } : {}),
    }),
  );
  if (depois === null) {
    return resultado(e, ACAO_PAGINA_PRECO_AMAZON.vezPerdida, {
      pagina: contagemPagina,
      parte,
      limiteTaxa,
    });
  }

  // ---- 11: the next page, or Decide. ----
  if (concluiu) {
    return decidir(e, depois, { pagina: contagemPagina, parte, limiteTaxa });
  }
  await deps.produtorPaginas().enfileirarPagina(t.contaId, t.execucaoId, t.pagina + 1);
  return resultado(e, ACAO_PAGINA_PRECO_AMAZON.paginaConcluida, {
    pagina: contagemPagina,
    parte,
    limiteTaxa,
  });
}

/** The page's own counts, for its line. */
function contagemDaPagina(
  resumo: ResumoPaginaPrecoAmazon,
  o: {
    readonly vinculos: number;
    readonly avaliados: number;
    readonly jaVistos: number;
    readonly lidosNaAmazon: number;
    readonly porChave: Readonly<Record<string, number>>;
    readonly leitura: LeituraLoteListingsAmazon | null;
  },
): ContagemPaginaPrecoAmazon {
  const c = resumo.contagens;
  return {
    vinculos: o.vinculos,
    avaliados: o.avaliados,
    jaVistos: o.jaVistos,
    lidosNaAmazon: o.lidosNaAmazon,
    iguais: c.iguais,
    enviaveis: c.enviaveis,
    sobe: c.sobe,
    desce: c.desce,
    quedaExcessiva: c.quedaExcessiva,
    direcaoDesconhecida: c.direcaoDesconhecida,
    reducaoSemConsentimento: c.reducaoSemConsentimento,
    precoAtualIlegivel: c.precoAtualIlegivel,
    faixaInvertida: c.faixaInvertida,
    tipoProdutoIlegivel: c.tipoProdutoIlegivel,
    semPreco: c.semPreco,
    semCaminho: c.semCaminho,
    temPrecoComDesconto: c.temPrecoComDesconto,
    temOfertaB2B: c.temOfertaB2B,
    fechada: c.fechada,
    naoConfirmados: c.naoConfirmados,
    problemasDePreco: c.problemasDePreco,
    recusas: juntarContagens(o.porChave),
    amostra: juntar(resumo.amostra),
    buscas: o.leitura?.chamadas.buscas ?? 0,
    gets: o.leitura?.chamadas.gets ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Decide                                   */
/* -------------------------------------------------------------------------- */

/** One price-run aviso synced, clocked by the run's first read. */
async function sincronizarAviso(
  e: Execucao,
  motivo: MotivoContaPrecoAmazon,
  acao: AcaoAvisoContaListingsAmazon,
  relogio: TimestampLike,
  avisos: string[],
): Promise<void> {
  await sincronizarAvisoContaListingsAmazon(
    e.db,
    { increment: e.deps.increment, nowMs: e.deps.agora(), logger: e.deps.logger },
    { fluxo: FLUXO_LISTING_AMAZON.preco, integracaoId: e.t.contaId, motivo, acao, relogio },
  );
  avisos.push(`${motivo}:${acao}`);
}

/** Raise `motivo` when `levantar`, else resolve it. */
function acaoDe(levantar: boolean): AcaoAvisoContaListingsAmazon {
  return levantar
    ? ACAO_AVISO_CONTA_LISTINGS_AMAZON.levantar
    : ACAO_AVISO_CONTA_LISTINGS_AMAZON.resolver;
}

/** One run task of a part's member (module header, Decide step 4): identities and the consent only. */
function tarefaDoMembro(
  contaId: string,
  run: ExecucaoPaginaPrecoAmazon,
  item: ItemDivergenciaPrecoAmazon,
  parte: number,
  solicitadoEmMs: number,
): TarefaPrecoSkuAmazon {
  return {
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_PRECO_AMAZON.sku,
    contaId,
    sku: item.sku,
    origem: ORIGEM_TAREFA_PRECO_AMAZON.execucao,
    referencia: run.execucaoId,
    parte,
    baixarPreco: run.baixarPreco,
    solicitadoEmMs,
    codigosAntes: [],
  };
}

/** What a task plan enqueued and counted. */
interface EnvioDasTarefas {
  readonly tarefas: number;
  readonly jaEnfileiradas: number;
  readonly simulados: number;
  readonly partesAusentes: number;
}

/**
 * The run's parts read by id, every member through `decidirAlvo`: `on` (for a
 * canary plan, only a SKU the list names) ⇒ one task, any other mode counted.
 * A SKU met twice is sent once (the first part wins).
 */
async function enviarComoTarefas(
  e: Execucao,
  run: ExecucaoPaginaPrecoAmazon,
  canario: boolean,
): Promise<EnvioDasTarefas> {
  if (run.proximaParte === 0)
    return { tarefas: 0, jaEnfileiradas: 0, simulados: 0, partesAusentes: 0 };
  const partes = await lerPartesDivergenciaPrecoAmazon(e.db, {
    contaId: e.t.contaId,
    execucaoId: run.execucaoId,
    parteInicial: 0,
    partes: run.proximaParte,
  });
  const solicitadoEmMs = e.deps.agora();
  const tarefas: TarefaPrecoSkuAmazon[] = [];
  const vistos = new Set<string>();
  let simulados = 0;
  let partesAusentes = 0;
  for (const p of partes) {
    if (!p.existe) {
      partesAusentes += 1;
      continue;
    }
    for (const item of p.itens) {
      if (vistos.has(item.sku)) continue;
      vistos.add(item.sku);
      const alvo = decidirAlvo(e.valvula, e.t.contaId, item.sku);
      const envia = alvo.modo === MODO_AMAZON.on && (!canario || alvo.motivo === 'no-canario');
      if (envia) tarefas.push(tarefaDoMembro(e.t.contaId, run, item, p.parte, solicitadoEmMs));
      else simulados += 1;
    }
  }
  if (tarefas.length === 0) return { tarefas: 0, jaEnfileiradas: 0, simulados, partesAusentes };
  const r = await e.deps.produtorPreco().enfileirarLote(tarefas);
  return { tarefas: r.enfileiradas, jaEnfileiradas: r.jaEnfileiradas, simulados, partesAusentes };
}

/** Decide (module header), then `concluida`. */
async function decidir(
  e: Execucao,
  base: LeituraExecucaoPrecoAmazon<ExecucaoPaginaPrecoAmazon>,
  daPagina: Pick<ResultadoPaginaPrecoAmazon, 'pagina' | 'parte' | 'limiteTaxa'> | null,
): Promise<ResultadoPaginaPrecoAmazon> {
  const { t, deps } = e;
  const run = base.estado;
  if (run === null) throw new TypeError('execucaoPreco.ts: o Decide parte de uma execução');
  const extra = daPagina ?? {};
  const c = run.contagens;
  const avisos: string[] = [];
  const relogio = run.relogioInicio;

  // 1. The conta avisos FIRST, clocked by the run's first read.
  if (relogio !== null) {
    await sincronizarAviso(
      e,
      MOTIVO_CONTA_AMAZON.precoFaixaInvertida,
      acaoDe(c.faixaInvertida > 0),
      relogio,
      avisos,
    );
    await sincronizarAviso(
      e,
      MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
      acaoDe(c.problemasDePreco > 0),
      relogio,
      avisos,
    );
  }

  // 2. The plan: the stored one, else decided and WRITTEN before any enqueue.
  let atual = base;
  let decisao = run.decisao;
  const planoGuardado = decisao !== null;
  if (decisao === null) {
    const fim = decidirFimPrecoAmazon({
      itensPorParte: run.itensPorParte,
      semCaminho: c.semCaminho,
      decisaoLote: decidirLote(e.valvula),
      contagens: c,
      baixarPreco: run.baixarPreco,
      confirmarReducaoEmMassa: run.confirmarReducaoEmMassa,
    });
    decisao = fim.decisao;
    const decidida = fim.decisao;
    const planejado = await atualizar(e, base, donoDoDecide(t), (estado) =>
      estado.decisao === null
        ? { decisao: decidida, progressoEmMs: deps.agora() }
        : { progressoEmMs: deps.agora() },
    );
    if (planejado === null) {
      return resultado(e, ACAO_PAGINA_PRECO_AMAZON.vezPerdida, {
        ...extra,
        avisos: juntar(avisos),
      });
    }
    atual = planejado;
    // A concurrent Decide's stored plan wins over this one (never two plans for one run).
    decisao = planejado.estado?.decisao ?? decisao;
  }

  // 3. The mass-decrease aviso: raised by that stop, resolved by every other plan.
  if (relogio !== null) {
    await sincronizarAviso(
      e,
      MOTIVO_CONTA_AMAZON.precoReducaoEmMassa,
      acaoDe(decisao === DECISAO_EXECUCAO_PRECO_AMAZON.reducaoEmMassa),
      relogio,
      avisos,
    );
  }

  // 4. The plan carried out.
  const estado = atual.estado ?? run;
  let envio: EnvioDasTarefas = { tarefas: 0, jaEnfileiradas: 0, simulados: 0, partesAusentes: 0 };
  let motivo: string | null = null;
  let lotes = 0;
  if (decisao === DECISAO_EXECUCAO_PRECO_AMAZON.tarefas) {
    envio = await enviarComoTarefas(e, estado, false);
  } else if (decisao === DECISAO_EXECUCAO_PRECO_AMAZON.canario) {
    envio = await enviarComoTarefas(e, estado, true);
  } else if (decisao === DECISAO_EXECUCAO_PRECO_AMAZON.dryRun) {
    envio = { ...envio, simulados: c.enviaveis };
  } else if (decisao === DECISAO_EXECUCAO_PRECO_AMAZON.lotes) {
    // The feed batches are a later PR's: the packing is only counted here.
    motivo = MOTIVO_FEED_NECESSARIO_PRECO_AMAZON;
    lotes = lotesDePartesPrecoAmazon(estado.itensPorParte).length;
  }

  // 5. `concluida`, LAST.
  const decide: DecisaoPaginaPrecoAmazon = { decisao, planoGuardado, lotes, ...envio };
  const amostraExecucao = juntar(estado.amostraReducoes);
  const fechado = await atualizar(e, atual, donoDoDecide(t), () => ({
    fase: FASE_EXECUCAO_PRECO_AMAZON.concluida,
    progressoEmMs: deps.agora(),
  }));
  return resultado(
    e,
    fechado === null ? ACAO_PAGINA_PRECO_AMAZON.vezPerdida : ACAO_PAGINA_PRECO_AMAZON.concluida,
    { ...extra, motivo, decide, avisos: juntar(avisos), amostraExecucao },
  );
}
