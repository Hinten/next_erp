/**
 * The daily stock reconcile's STORE phase (`li`; master plan step 12, PR 12-g): per conta, in the
 * run's `contas` order, the store's stock list read WHOLE, one page per call, each row diffed
 * against the snapshot the ERP phase wrote — the rows out of step become the run's candidates.
 * One unit at a time ({@link FaseLiReconcileLi.unidade}); the slice (`despachoReconcile.ts`) owns
 * the loop, the budget's end and every write. Next-free, `db` a parameter, no process environment.
 *
 * ## Loja Integrada only through the context loader
 *
 * Every call goes through `loadLojaIntegradaContext` (`core/contexto.ts`): its FIRST act is the
 * read switch (off ⇒ ONE `chamada-bloqueada` line, zero Firestore reads, the conta skipped and
 * counted, the chain goes on), then the conta (gone, not a Loja Integrada one, inactive), the
 * credential (missing, corrupt, parked), then the pacer before every request. The context is
 * loaded once per conta per slice, and only when a call is about to be made. No client is built
 * here and nothing reaches the network but through it (`estrutura.test.ts`).
 *
 * ## The list walk, resumable inside one run
 *
 * `GET /v1/produto_estoque?limit=L&offset=K`, one page per call, through the package's page
 * reader (`lerPaginaEstoqueLi`, never a pager with a page cap). The cursor is the conta's root
 * `reconcile` (`{ offset, limite, iniciadoEmMs }`): a cursor that started at or after the run is
 * THIS run's and the walk resumes at its offset (a run cut at page 13 of 25 resumes at 13); any
 * other is another run's, and the walk starts over at 0 with no store id seen. `L` is
 * `LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA` (`configEstoqueLi.ts`: default 100, clamped to the
 * schema's one bound), read when the walk STARTS and kept in the cursor, so a run never changes it
 * mid-list (an unreadable value: the default and ONE WARNING per run). The page's `next` is never
 * followed as a path: its validated offset is (`proximoOffset`), and `null` ends the walk.
 *
 * ## One row
 *
 * The store id is the row's `produto` read by the package's one reader (`produtoIdDoEstoqueLi`), as
 * its canonical decimal text. Then, in this order:
 *
 *  - a PARENT's id (the snapshot's `pais`) ⇒ counted, nothing else: a parent row is never sent,
 *    and some are managed;
 *  - the id is recorded as SEEN (`execucao.vistos`);
 *  - the diff is the plan's ONE rule (`diffLinhaEstoqueLi`: model A, the cap applied there, so a
 *    cap change re-diffs with no ERP read): in step ⇒ nothing; an entry never sent (`r`, `par`,
 *    `amb`, `dup`, `ns`, `x`) ⇒ counted; out of step ⇒ a CANDIDATE `{ c, i, p, d }` — a
 *    `gerenciado: false` row and a negative one included — and ONE INFO line (ids and the row's
 *    numbers only), in every valve mode;
 *  - NO entry ⇒ the page's lookups, below.
 *
 * Candidates go to the run document's list (`candidatosReconcile.ts`: one per (conta, store id),
 * under a byte budget, over-advertising never displaced). Nothing is enqueued here: that is the
 * queue phase's, and a dry-run's queue phase enqueues nothing.
 *
 * ## Rows that do not read
 *
 * A row the package's row schema refused (`ilegiveis`) is NEVER "no row in the store" and never a
 * candidate. One that still names a produto is counted and recorded as seen. One that names none —
 * and a row that reads but whose `produto` names no product — is counted `ilegiveisSemProduto`,
 * and it costs the conta its unseen check AND its stale-`x` sweep for this run (one WARNING): an
 * unseen linked child could be that very row. A page whose every row is unreadable is just such a
 * page: nothing diffed, the walk moves on to its `next`. Only a malformed ENVELOPE refuses a page
 * (`LiSchemaError`, a transient failure below).
 *
 * ## The lookup of a row no entry names (a unit of its own)
 *
 * The page's unknown ids, 15 at a time, per stored form of the conta ref: ONE collection-group
 * query `contaLojaIntegrada == form`, `id in [15 numbers + their 15 texts]` — the builder the send
 * run's duplicate probe uses (`consultaVinculosDaContaPorIdsLi`), on the declared index — then, in
 * code, the conta, the counting predicate and an owner read off the PATH. The produtos found are
 * evaluated by the ERP phase's own evaluator (`faseErp.ts`: their own links listed whole, the
 * masked produto, the records, the plan), so an entry is never built twice; two produtos on one id
 * meet in the snapshot as `dup`. An id still without an entry gets `x` — so a row no link names (an
 * orphan, a product the ERP never linked, the trash) is not looked up again the next night: the
 * steady state makes no lookup. A store kit found this way gets its entry, but joins the kits map
 * only at the next night's walk (counted). A query that came back FULL concludes nothing about its
 * ids (no `x`). Then each id is diffed like any row.
 *
 * ⚠️ A snapshot that misses linked children is a broken ERP phase, never business as usual: once
 * the counting links found for a conta exceed max({@link MINIMO_FORA_DO_SNAPSHOT_LI},
 * {@link PERCENTUAL_FORA_DO_SNAPSHOT_LI}% of its rows read), its lookups stop being evaluated
 * (counted), the conta is flagged BLOCKED (`bloqueioForaDoSnapshot`, which the queue phase reads)
 * and ONE ERROR says so.
 *
 * The lookups run only when their own worst case still fits the slice (`orcamentoReconcile.ts`):
 * otherwise the page is DROPPED whole — nothing of it kept, its cursor not moved — and read again
 * first by the next slice. A page counts only once complete.
 *
 * ## A linked child the walk never saw is UNKNOWN
 *
 * The store's list is unordered and read by offset, so a row can shift across a page boundary
 * while it is read. When the walk ends, every linked entry (anything but `x`) whose id it never
 * saw gets ONE paced detail GET (`buscarEstoqueProdutoLi`), at most
 * {@link MAX_CONFIRMACOES_RECONCILE_LI} per conta per run (the rest counted `naoConfirmados`, never
 * reported): a 404 is confirmed "no row in the store" (counted, and sampled for the vinculo aviso);
 * a row naming that product is diffed like a list row; another product's row, or a body off its
 * schema, settles it unread. Each settled id is recorded as seen, so a resumed slice never asks
 * twice. Then every `x` entry the walk never saw is dropped: the store no longer lists that row.
 *
 * ## Failures (root rule 6) — each narrowed to its class
 *
 *  - **429** (`LiThrottleError`) ⇒ a PAUSE: the slice ends with its checkpoint (`pausas429 + 1`)
 *    and the next slice comes 60 s later; no attempt is consumed. With
 *    `MAX_PAUSAS_429_LI` pauses already taken the conta is skipped (one WARNING), the chain goes on.
 *  - **401/403** (`LiAuthError`) ⇒ the shared read-failure mapper parks the conta exactly as every
 *    reader parks it (`tratarFalhaDeLeituraLi`, a 403 like a 401: the send run's rule on the same
 *    endpoint family) and the conta is skipped; a refusal of an OLDER token (saved meanwhile) or the
 *    park's own contention is retried.
 *  - **The conta's refusals** — at the context, or mid-walk at the credential getter (another flow
 *    parked it, the token was removed) ⇒ the conta is skipped and counted (one WARNING; the switch
 *    off logs only the context's line).
 *  - **5xx, the deadline, the network, a malformed envelope, a paging stop, Firestore** ⇒ RETRIED:
 *    the slice writes what it completed, then rethrows the ORIGINAL error and the queue retries the
 *    slice at the cursor. On the queue's LAST attempt the conta is ended instead (one ERROR,
 *    counted, its walk incomplete) and the chain goes on with the next one.
 *  - **A deterministic refusal of the conta's request** — a 404 on the LIST, another 3xx/4xx on
 *    the list or on a confirmation's detail GET (a detail 404 is "no row", above), a
 *    `LiConfigError` (the package refused the request before sending it: a stored token it cannot
 *    send, say) ⇒ the conta is ENDED on EVERY attempt, its list or its confirmations incomplete:
 *    one ERROR `recusa-da-loja` (the class, the status and the package's operation name only),
 *    counted `recusasDaLoja`, and the chain goes on with the next conta. A retry would meet the
 *    same answer, and ONE chain serves every conta: rethrown, one conta's refusal would stop every
 *    conta after it — the queue and end phases too — every night. A refused detail GET is never
 *    settled as seen: that would let `sem-linha-na-loja` resolve on a row nobody read, so the
 *    conta's confirmation stays incomplete (conservative) until the store answers.
 *  - **Anything else** — a coding bug — is rethrown as-is, on every attempt (on the queue's last
 *    one the slice releases the lease first, `despachoReconcile.ts`).
 *
 * Every line carries ids and numbers only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here — not even in a comment (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { contaRefForms } from '@delfrance/data/admin/produtos';
import {
  type EstoqueProdutoLinhaLi,
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  buscarEstoqueProdutoLi,
  lerPaginaEstoqueLi,
  produtoIdDoEstoqueLi,
} from '@delfrance/integrations-loja-integrada';
import {
  FLAG_ENTRADA_ESTOQUE_LI,
  type FlagEntradaEstoqueLi,
  MAX_AMOSTRA_AVISO_ESTOQUE_LI,
  MAX_PAUSAS_429_LI,
  MOTIVO_AMOSTRA_ESTOQUE_LI,
  contaDoLinkLi,
  vinculoLiConta,
} from '@delfrance/schemas';

import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../../core/contexto';
import {
  LiAppError,
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from '../../core/erros';
import { type PoliticaDeFalhaLi, tratarFalhaDeLeituraLi } from '../../core/falhaDeLeituraLi';
import type { EscritorLogLi } from '../../core/log';
import { ritmoDeLeituraLi } from '../../core/ritmo';
import type { AmbienteLi } from '../../core/valvulas';
import { LIMITE_PAGINA_ESTOQUE_ENV_LI, lerLimitePaginaEstoqueLi } from '../configEstoqueLi';
import {
  MAX_IDS_POR_CONSULTA_VINCULO_LI,
  consultaVinculosDaContaPorIdsLi,
  emParaleloLi,
  lerVinculosDoProdutoLi,
} from '../leituraEstoqueErp';
import { compararIdLi, diffLinhaEstoqueLi } from '../planoEstoqueLi';
import { type GrupoDeVinculosLi, donoDoVinculoLi } from './caminhadaVinculos';
import type { ListaCandidatosReconcileLi } from './candidatosReconcile';
import { CONCURRENCIA_LEITURAS_ERP_LI, avaliarPaginaErpLi } from './faseErp';
import { type OrcamentoReconcileLi, UNIDADE_RECONCILE_LI } from './orcamentoReconcile';
import { type EstadoContaReconcileLi, nomeDoContadorDaContaLi } from './snapshotReconcile';

const TAG = '[loja-integrada/estoque] reconcile';

/** What the context's call lines carry as `fluxo`. */
export const FLUXO_RECONCILE_ESTOQUE_LI = 'estoque-reconcile';

/**
 * The most unseen linked children one conta's run confirms with a detail GET: as many as the
 * vinculo aviso samples (module header, "A linked child the walk never saw is UNKNOWN").
 */
export const MAX_CONFIRMACOES_RECONCILE_LI = MAX_AMOSTRA_AVISO_ESTOQUE_LI;

/**
 * The most link documents one lookup query reads. A query that comes back with this many may
 * have left one out, so its ids get no `x` (module header).
 */
export const LIMITE_CONSULTA_VINCULOS_RECONCILE_LI = 100;

/** The anomaly bound's floor: this many counting links found by lookups pass on any conta. */
export const MINIMO_FORA_DO_SNAPSHOT_LI = 50;

/** The anomaly bound's share of the conta's rows read, in percent (module header). */
export const PERCENTUAL_FORA_DO_SNAPSHOT_LI = 2;

/**
 * The anomaly bound (module header): how many counting links lookups may find for a conta that
 * has read `linhasLidas` rows before it is blocked — `found > bound` blocks, `found === bound`
 * passes.
 */
export function limiteForaDoSnapshotLi(linhasLidas: number): number {
  return Math.max(
    MINIMO_FORA_DO_SNAPSHOT_LI,
    Math.floor((linhasLidas * PERCENTUAL_FORA_DO_SNAPSHOT_LI) / 100),
  );
}

/** The counter each never-sent flag is counted under, per row read (module header, "One row"). */
const CONTADOR_DA_FLAG: Readonly<Record<FlagEntradaEstoqueLi, string>> = {
  v: 'linhasValidas',
  r: 'linhasRetidas',
  par: 'linhasParidade',
  amb: 'linhasAmbiguas',
  dup: 'linhasDuplicadas',
  ns: 'linhasNaoSuportadas',
  x: 'linhasSemVinculo',
};

/** The read failures a parking 401/403 decides with: a 403 parks like a 401 (module header). */
const POLITICA_DE_FALHA_RECONCILE_LI: PoliticaDeFalhaLi = { ausente: null, proibido: 'estacionar' };

/** What the store phase needs — the slice's deps, as bound once by the functions codebase. */
export interface DepsFaseLiReconcileLi {
  /** The process environment: the read switch (in the context) and the page size. */
  readonly ambiente: AmbienteLi;
  /** The one clock, in ms. */
  readonly agoraMs: () => number;
  /** The pacer's sleep (`core/ritmo.ts`: 2 000 ms before every call). */
  readonly esperar: (ms: number) => Promise<void>;
  /** A tier-0 `FieldValue.increment`, for the park's reconexão aviso. */
  readonly increment: (by: number) => unknown;
  /** The Cloud Tasks attempt, 0-based (the last-attempt rule). */
  readonly tentativa: number;
  /** The Cloud Tasks task id, for the context's call lines. */
  readonly idTarefa: string | null;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Test seams, forwarded to the context as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly escrever?: EscritorLogLi;
}

/** What one {@link FaseLiReconcileLi.unidade} call decided. */
export type PassoFaseLi =
  /** One unit ran: ask again. */
  | { readonly tipo: 'unidade' }
  /** The next unit does not fit the slice's budget: the slice ends. */
  | { readonly tipo: 'sem-orcamento' }
  /** This conta is done — finished, or skipped (counted): the next conta. */
  | { readonly tipo: 'conta-encerrada' }
  /** A 429: the slice ends, and the next one comes 60 s later. */
  | { readonly tipo: 'pausa' }
  /** The conta's state belongs to another run: the slice stops. */
  | { readonly tipo: 'parado' }
  /** A failure a retry may change: the slice writes what it completed, then rethrows `erro`. */
  | { readonly tipo: 'falha'; readonly erro: unknown };

/** One conta of the run, as the store phase reaches it. */
export interface ContaDaFaseLi {
  readonly idx: number;
  readonly contaId: string;
}

/** One candidate found on a row, with what its INFO line says. */
interface CandidatoDaLinhaLi {
  readonly idLi: string;
  readonly produtoId: string;
  readonly d: number;
  readonly s: number | null;
  readonly linha: EstoqueProdutoLinhaLi;
}

/** One page's results, kept apart until the page is complete (module header). */
class ResultadoDaPaginaLi {
  readonly contadores = new Map<string, number>();
  readonly vistos: string[] = [];
  readonly desconhecidas = new Map<string, EstoqueProdutoLinhaLi>();
  readonly candidatos: CandidatoDaLinhaLi[] = [];
  readonly semVinculo: string[] = [];

  contar(nome: string, n = 1): void {
    if (n !== 0) this.contadores.set(nome, (this.contadores.get(nome) ?? 0) + n);
  }

  lido(nome: string): number {
    return this.contadores.get(nome) ?? 0;
  }
}

/** Whether a retry can change this failure (module header, "Failures"). */
function retentavelNaFaseLi(err: unknown): boolean {
  return (
    isGrpcStatusError(err) ||
    // The deadline is a `LiNetworkError` too.
    err instanceof LiNetworkError ||
    err instanceof LiSchemaError ||
    err instanceof LiPaginacaoError ||
    err instanceof LiEstacionamentoEmConflitoError ||
    (err instanceof LiHttpError && err.transitorio)
  );
}

/**
 * The counter a refusal of the conta is skipped under, or `null` when it is not a refusal that
 * skips (the park's contention and a credential replaced meanwhile are retried).
 */
function motivoDoPuloLi(err: LiAppError): string | null {
  if (err instanceof LiChamadasDesligadasError) return 'chamadasDesligadas';
  if (err instanceof LiContaNaoEncontradaError) return 'contaAusente';
  if (err instanceof LiContaInativaError) return 'contaInativa';
  if (err instanceof LiCredencialAusenteError) return 'credencialAusente';
  if (err instanceof LiCredencialInvalidaError) return 'credencialInvalida';
  if (err instanceof LiContaParadaError) return 'contaParada';
  return null;
}

/** A link document's raw fields, or `null` for anything that is not an object. */
function comoRegistro(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** What one slice hands its store phase. */
export interface ArgsFaseLiReconcileLi {
  readonly db: Firestore;
  readonly deps: DepsFaseLiReconcileLi;
  readonly execucaoId: string;
  /** MS. When the run began: a list cursor that started before it is another run's. */
  readonly runIniciadoEmMs: number;
  /** The cap `LOJA_INTEGRADA_ESTOQUE_MAX`, as read (`+∞` when unset). */
  readonly teto: number;
  readonly orcamento: OrcamentoReconcileLi;
  readonly candidatos: ListaCandidatosReconcileLi;
  /** Adds to a run counter (the stored name). */
  readonly contar: (nome: string, n?: number) => void;
  /** A run counter's current value (the stored name). */
  readonly contador: (nome: string) => number;
  /** The conta's state, loaded once per slice; `null` = another run's (the slice stops). */
  readonly estadoDe: (conta: ContaDaFaseLi) => Promise<EstadoContaReconcileLi | null>;
}

/** The class name of a failure, for its log line (never its message). */
function classeDaFalhaLi(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const nome: unknown = Reflect.get(err, 'name');
  return typeof nome === 'string' && nome.length <= 100 ? nome : null;
}

/** The store phase of ONE slice (module header). */
export class FaseLiReconcileLi {
  private readonly args: ArgsFaseLiReconcileLi;
  private readonly contextos = new Map<string, ContextoLojaIntegrada>();
  private chamadasDoSlice = 0;

  constructor(args: ArgsFaseLiReconcileLi) {
    this.args = args;
  }

  /** The Loja Integrada calls this slice's contexts sent (credential reads past each load). */
  get chamadas(): number {
    return this.chamadasDoSlice;
  }

  private contarDaConta(conta: ContaDaFaseLi, nome: string, n = 1): void {
    if (n !== 0) this.args.contar(nomeDoContadorDaContaLi(conta.idx, nome), n);
  }

  private daConta(conta: ContaDaFaseLi, nome: string): number {
    return this.args.contador(nomeDoContadorDaContaLi(conta.idx, nome));
  }

  private ids(conta: ContaDaFaseLi): Record<string, unknown> {
    return { execucaoId: this.args.execucaoId, contaId: conta.contaId };
  }

  /**
   * ONE unit of `conta`'s store phase: a page of its list (and the page's lookups), or one
   * confirmation of an unseen linked child, or the conta's end (module header).
   */
  async unidade(conta: ContaDaFaseLi): Promise<PassoFaseLi> {
    try {
      if (this.daConta(conta, 'listaCompleta') === 0) return await this.unidadeDaLista(conta);
      return await this.unidadeDeConfirmacao(conta);
    } catch (err) {
      const passo = await this.tratarFalha(conta, err);
      // Not the store phase's to answer: rethrown as-is (module header, "Failures").
      if (passo === null) throw err;
      return passo;
    }
  }

  /* ------------------------------ the context ------------------------------ */

  /** The conta's context, loaded once per slice; a refusal skips the conta (module header). */
  private async contexto(conta: ContaDaFaseLi): Promise<ContextoLojaIntegrada | PassoFaseLi> {
    const pronto = this.contextos.get(conta.contaId);
    if (pronto !== undefined) return pronto;
    const { deps } = this.args;
    try {
      const contexto = await loadLojaIntegradaContext(this.args.db, conta.contaId, {
        ambiente: deps.ambiente,
        ritmo: ritmoDeLeituraLi(deps.esperar),
        registro: {
          fluxo: FLUXO_RECONCILE_ESTOQUE_LI,
          tentativa: deps.tentativa,
          idTarefa: deps.idTarefa,
          escrever: deps.escrever,
        },
        // Told before EVERY request the client sends (after the pacer).
        aoUsarCredencial: () => {
          this.chamadasDoSlice += 1;
        },
        fetch: deps.fetch,
      });
      this.contextos.set(conta.contaId, contexto);
      return contexto;
    } catch (err) {
      if (err instanceof LiAppError) {
        const pulo = this.pularConta(conta, err);
        if (pulo !== null) return pulo;
      }
      throw err;
    }
  }

  /** A refusal of the conta that skips it: counted, one WARNING (not for the switch). */
  private pularConta(conta: ContaDaFaseLi, err: LiAppError): PassoFaseLi | null {
    const motivo = motivoDoPuloLi(err);
    if (motivo === null) return null;
    this.contarDaConta(conta, motivo);
    // The switch off is the state of every environment before the window: the context already
    // logged its one line.
    if (!(err instanceof LiChamadasDesligadasError)) {
      this.args.deps.logger.warn(
        `${TAG} conta indisponível — a loja desta conta fica para depois`,
        {
          ...this.ids(conta),
          motivo,
        },
      );
    }
    return { tipo: 'conta-encerrada' };
  }

  /* -------------------------------- the list ------------------------------- */

  /** One page of the conta's list, and its lookups (module header). */
  private async unidadeDaLista(conta: ContaDaFaseLi): Promise<PassoFaseLi> {
    if (!this.args.orcamento.cabe(UNIDADE_RECONCILE_LI.chamada)) return { tipo: 'sem-orcamento' };
    // FIRST the context: the switch off reads nothing and loads no state.
    const contexto = await this.contexto(conta);
    if (!('cliente' in contexto)) return contexto;
    const estado = await this.args.estadoDe(conta);
    if (estado === null) return { tipo: 'parado' };

    const cursor = this.cursorDoRun(conta, estado);
    const pagina = await lerPaginaEstoqueLi(contexto.cliente, {
      offset: cursor.offset,
      limite: cursor.limite,
    });
    const resultado = new ResultadoDaPaginaLi();
    resultado.contar('paginas');
    for (const linha of pagina.linhas) {
      const produto = produtoIdDoEstoqueLi(linha.produto);
      if (produto === null) {
        // It reads, but names no product: as unattributable as an unreadable row.
        resultado.contar('ilegiveisSemProduto');
        continue;
      }
      resultado.contar('linhas');
      this.avaliarLinha(conta, estado, String(produto), linha, resultado);
    }
    for (const ilegivel of pagina.ilegiveis) {
      if (ilegivel.produtoId === null) {
        resultado.contar('ilegiveisSemProduto');
        continue;
      }
      resultado.contar('ilegiveis');
      const idLi = String(ilegivel.produtoId);
      if (!estado.ehPai(idLi)) resultado.vistos.push(idLi);
    }

    if (resultado.desconhecidas.size > 0) {
      // The page's lookups are a unit of their own: no room ⇒ the page is dropped whole.
      if (!this.args.orcamento.cabe(UNIDADE_RECONCILE_LI.consulta)) {
        return { tipo: 'sem-orcamento' };
      }
      await this.consultar(conta, estado, resultado);
    }

    this.concluirPagina(conta, estado, resultado);
    if (pagina.proximoOffset === null) {
      this.contarDaConta(conta, 'listaCompleta');
    } else {
      estado.definirCursor({ ...cursor, offset: pagina.proximoOffset });
    }
    return { tipo: 'unidade' };
  }

  /** The run's cursor for the conta: the stored one when it is this run's, else a new one at 0. */
  private cursorDoRun(conta: ContaDaFaseLi, estado: EstadoContaReconcileLi) {
    const guardado = estado.cursor();
    if (guardado !== null && guardado.iniciadoEmMs >= this.args.runIniciadoEmMs) return guardado;
    const lido = lerLimitePaginaEstoqueLi(this.args.deps.ambiente);
    if (!lido.valido) {
      if (this.args.contador('limitePaginaIlegivel') === 0) {
        this.args.deps.logger.warn(
          `${TAG} tamanho de página ilegível — usado ${String(lido.limite)}`,
          {
            ...this.ids(conta),
            variavel: LIMITE_PAGINA_ESTOQUE_ENV_LI,
            limite: lido.limite,
          },
        );
      }
      this.args.contar('limitePaginaIlegivel');
    }
    const novo = { offset: 0, limite: lido.limite, iniciadoEmMs: this.args.deps.agoraMs() };
    estado.definirCursor(novo);
    estado.reiniciarVistos();
    return novo;
  }

  /** One readable row (module header, "One row"). */
  private avaliarLinha(
    conta: ContaDaFaseLi,
    estado: EstadoContaReconcileLi,
    idLi: string,
    linha: EstoqueProdutoLinhaLi,
    resultado: ResultadoDaPaginaLi,
  ): void {
    if (estado.ehPai(idLi)) {
      resultado.contar('linhasPai');
      return;
    }
    resultado.vistos.push(idLi);
    if (!this.diferenca(conta, estado, idLi, linha, resultado)) {
      resultado.desconhecidas.set(idLi, linha);
    }
  }

  /**
   * The diff of one row against its entry, into `resultado`; `false` when the row has no entry
   * (the caller looks it up).
   */
  private diferenca(
    conta: ContaDaFaseLi,
    estado: EstadoContaReconcileLi,
    idLi: string,
    linha: EstoqueProdutoLinhaLi,
    resultado: ResultadoDaPaginaLi,
  ): boolean {
    const entrada = estado.entrada(idLi);
    const diff = diffLinhaEstoqueLi({ idLi, linha, entrada, cap: this.args.teto });
    switch (diff.tipo) {
      case 'sem-entrada':
        return false;
      case 'em-dia':
        resultado.contar('emDia');
        return true;
      case 'nao-enviavel':
        resultado.contar(CONTADOR_DA_FLAG[diff.flag]);
        return true;
      case 'candidato':
        resultado.candidatos.push({
          idLi,
          produtoId: diff.produtoId,
          d: diff.delta,
          s: entrada?.s ?? null,
          linha,
        });
        return true;
    }
  }

  /** The page is complete: everything it found lands in the slice's state (module header). */
  private concluirPagina(
    conta: ContaDaFaseLi,
    estado: EstadoContaReconcileLi,
    resultado: ResultadoDaPaginaLi,
  ): void {
    for (const [nome, n] of resultado.contadores) this.contarDaConta(conta, nome, n);
    for (const idLi of resultado.vistos) estado.marcarVisto(idLi);
    for (const idLi of resultado.semVinculo) {
      estado.aplicar(idLi, { p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo });
    }
    for (const c of resultado.candidatos) this.guardarCandidato(conta, c);
  }

  /** One candidate into the run's list, and its INFO line (module header, "One row"). */
  private guardarCandidato(conta: ContaDaFaseLi, c: CandidatoDaLinhaLi): void {
    const r = this.args.candidatos.adicionar({ c: conta.idx, i: c.idLi, p: c.produtoId, d: c.d });
    this.contarDaConta(conta, 'candidatos');
    if (r === 'descartado') this.contarDaConta(conta, 'descartados');
    const numero = (v: unknown): number | boolean | null =>
      typeof v === 'number' || typeof v === 'boolean' ? v : null;
    this.args.deps.logger.info(`${TAG} diferença na loja`, {
      ...this.ids(conta),
      idLi: c.idLi,
      produtoId: c.produtoId,
      S: c.s === null ? null : Math.min(c.s, this.args.teto),
      d: c.d,
      gerenciado: numero(c.linha.gerenciado),
      quantidade: numero(c.linha.quantidade),
      quantidade_reservada: numero(c.linha.quantidade_reservada),
      situacao_em_estoque: numero(c.linha.situacao_em_estoque),
      situacao_sem_estoque: numero(c.linha.situacao_sem_estoque),
      descartado: r === 'descartado',
    });
  }

  /* ------------------------------- the lookups ------------------------------ */

  /** The page's lookups (module header, "The lookup of a row no entry names"). */
  private async consultar(
    conta: ContaDaFaseLi,
    estado: EstadoContaReconcileLi,
    resultado: ResultadoDaPaginaLi,
  ): Promise<void> {
    const ids = [...resultado.desconhecidas.keys()];
    if (this.daConta(conta, 'bloqueioForaDoSnapshot') > 0) {
      resultado.contar('consultasNaoAvaliadas', ids.length);
      return;
    }
    const { db } = this.args;
    const encontrados: { readonly dono: string }[] = [];
    const inconclusivos = new Set<string>();
    for (let i = 0; i < ids.length; i += MAX_IDS_POR_CONSULTA_VINCULO_LI) {
      const lote = ids.slice(i, i + MAX_IDS_POR_CONSULTA_VINCULO_LI);
      const snaps = await Promise.all(
        contaRefForms(conta.contaId).map((forma) =>
          consultaVinculosDaContaPorIdsLi(db, forma, lote)
            .limit(LIMITE_CONSULTA_VINCULOS_RECONCILE_LI)
            .get(),
        ),
      );
      resultado.contar('consultasVinculo', snaps.length);
      if (snaps.some((snap) => snap.size >= LIMITE_CONSULTA_VINCULOS_RECONCILE_LI)) {
        for (const idLi of lote) inconclusivos.add(idLi);
      }
      for (const snap of snaps) {
        for (const doc of snap.docs) {
          const dono = donoDoVinculoLi(doc.ref.path);
          const dados = comoRegistro(doc.data());
          if (
            dono !== null &&
            dados !== null &&
            contaDoLinkLi(dados) === conta.contaId &&
            vinculoLiConta(dados)
          ) {
            encontrados.push({ dono });
          }
        }
      }
    }

    // ⚠️ The anomaly bound, before anything found is evaluated.
    const ate = this.daConta(conta, 'vinculosForaDoSnapshot');
    const limite = limiteForaDoSnapshotLi(this.daConta(conta, 'linhas') + resultado.lido('linhas'));
    if (ate + encontrados.length > limite) {
      resultado.contar('bloqueioForaDoSnapshot');
      resultado.contar('consultasNaoAvaliadas', ids.length);
      this.args.deps.logger.error(
        `${TAG} o snapshot não tem filhos vinculados que a loja lista — conta bloqueada`,
        {
          ...this.ids(conta),
          motivo: 'fora-do-snapshot',
          encontrados: ate + encontrados.length,
          limite,
        },
      );
      return;
    }
    resultado.contar('vinculosForaDoSnapshot', encontrados.length);

    const donos = [...new Set(encontrados.map((e) => e.dono))].sort();
    if (donos.length > 0) {
      const listados = await emParaleloLi(donos, CONCURRENCIA_LEITURAS_ERP_LI, (dono) =>
        lerVinculosDoProdutoLi(db, dono),
      );
      const grupos: GrupoDeVinculosLi[] = donos.map((produtoId, n) => ({
        produtoId,
        links: (listados[n] ?? []).flatMap((l) => {
          const registro = comoRegistro(l);
          return registro === null ? [] : [registro];
        }),
      }));
      const global = new Map<string, number>();
      const porConta = await avaliarPaginaErpLi(
        db,
        grupos,
        [estado.conta],
        new Map([[conta.contaId, estado]]),
        { global },
      );
      // The run's read-path counters: the lookups' ERP reads are the night's reads too.
      for (const [nome, n] of global) this.args.contar(nome, n);
      for (const [nome, n] of porConta.get(conta.contaId) ?? []) resultado.contar(nome, n);
    }

    for (const [idLi, linha] of resultado.desconhecidas) {
      const entrada = estado.entrada(idLi);
      if (entrada === undefined) {
        if (estado.ehPai(idLi)) resultado.contar('linhasPai');
        else if (inconclusivos.has(idLi)) resultado.contar('consultasInconclusivas');
        else {
          resultado.semVinculo.push(idLi);
          resultado.contar('semVinculoNovos');
        }
        continue;
      }
      // A store kit found now joins the kits map at the next night's walk.
      if (entrada.k === true) resultado.contar('kitsForaDoMapa');
      this.diferenca(conta, estado, idLi, linha, resultado);
    }
  }

  /* ---------------------------- the confirmations --------------------------- */

  /** The conta's linked entries the walk never saw, in numeric order (module header). */
  private naoVistos(estado: EstadoContaReconcileLi): string[] {
    const ids: string[] = [];
    for (const [idLi, entrada] of estado.entradas()) {
      if (entrada.f === FLAG_ENTRADA_ESTOQUE_LI.semVinculo) continue;
      if (estado.visto(idLi) || estado.ehPai(idLi)) continue;
      ids.push(idLi);
    }
    return ids.sort(compararIdLi);
  }

  /** After the walk: one confirmation, or the conta's end (module header). */
  private async unidadeDeConfirmacao(conta: ContaDaFaseLi): Promise<PassoFaseLi> {
    const semProduto = this.daConta(conta, 'ilegiveisSemProduto');
    if (semProduto > 0) {
      this.args.deps.logger.warn(
        `${TAG} linhas ilegíveis sem produto — sem verificação de ausentes nem limpeza`,
        {
          ...this.ids(conta),
          ilegiveis: this.daConta(conta, 'ilegiveis'),
          ilegiveisSemProduto: semProduto,
        },
      );
      this.contarDaConta(conta, 'verificacaoIgnorada');
      return { tipo: 'conta-encerrada' };
    }
    const estado = await this.args.estadoDe(conta);
    if (estado === null) return { tipo: 'parado' };
    const pendentes = this.naoVistos(estado);
    const [proximo] = pendentes;
    if (
      proximo !== undefined &&
      this.daConta(conta, 'confirmacoes') < MAX_CONFIRMACOES_RECONCILE_LI
    ) {
      if (!this.args.orcamento.cabe(UNIDADE_RECONCILE_LI.chamada)) return { tipo: 'sem-orcamento' };
      const contexto = await this.contexto(conta);
      if (!('cliente' in contexto)) return contexto;
      await this.confirmar(conta, estado, contexto, proximo);
      return { tipo: 'unidade' };
    }
    this.contarDaConta(conta, 'naoConfirmados', pendentes.length);
    if (pendentes.length === 0) this.contarDaConta(conta, 'verificacaoFeita');
    let removidos = 0;
    for (const [idLi, entrada] of [...estado.entradas()]) {
      if (entrada.f === FLAG_ENTRADA_ESTOQUE_LI.semVinculo && !estado.visto(idLi)) {
        if (estado.removerSemVinculo(idLi)) removidos += 1;
      }
    }
    this.contarDaConta(conta, 'semVinculoRemovidos', removidos);
    const ilegiveis = this.daConta(conta, 'ilegiveis');
    if (ilegiveis > 0) {
      this.args.deps.logger.warn(`${TAG} linhas ilegíveis na lista da loja`, {
        ...this.ids(conta),
        ilegiveis,
        ilegiveisSemProduto: 0,
      });
    }
    return { tipo: 'conta-encerrada' };
  }

  /** ONE detail GET of an unseen linked child, settled (module header). */
  private async confirmar(
    conta: ContaDaFaseLi,
    estado: EstadoContaReconcileLi,
    contexto: ContextoLojaIntegrada,
    idLi: string,
  ): Promise<void> {
    const entrada = estado.entrada(idLi);
    let resposta: Awaited<ReturnType<typeof buscarEstoqueProdutoLi>>;
    try {
      resposta = await buscarEstoqueProdutoLi(contexto.cliente, idLi);
    } catch (err) {
      if (err instanceof LiNotFoundError) {
        this.contarDaConta(conta, 'confirmacoes');
        this.contarDaConta(conta, 'semLinhaNaLoja');
        if (entrada?.p != null) {
          estado.amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.semLinhaNaLoja, [entrada.p]);
        }
        estado.marcarVisto(idLi);
        return;
      }
      if (err instanceof LiSchemaError && err.motivo === 'formato') {
        // The row exists, off its schema: settled unread, never "no row".
        this.contarDaConta(conta, 'confirmacoes');
        this.contarDaConta(conta, 'confirmacoesIlegiveis');
        estado.marcarVisto(idLi);
        return;
      }
      throw err;
    }
    this.contarDaConta(conta, 'confirmacoes');
    if (produtoIdDoEstoqueLi(resposta.dados.produto) === Number(idLi)) {
      // The row moved across a page boundary while the list was read: diffed like a list row.
      const resultado = new ResultadoDaPaginaLi();
      resultado.contar('confirmadosNaLoja');
      this.diferenca(conta, estado, idLi, resposta.dados, resultado);
      this.concluirPagina(conta, estado, resultado);
    } else {
      this.contarDaConta(conta, 'confirmacoesDivergentes');
    }
    estado.marcarVisto(idLi);
  }

  /* ------------------------------- the failures ----------------------------- */

  /** A unit's failure (module header, "Failures"); `null` = rethrow `err` as-is. */
  private async tratarFalha(conta: ContaDaFaseLi, err: unknown): Promise<PassoFaseLi | null> {
    if (err instanceof LiThrottleError) {
      if (this.daConta(conta, 'pausas429') >= MAX_PAUSAS_429_LI) {
        this.contarDaConta(conta, 'limiteDeChamadas');
        this.args.deps.logger.warn(
          `${TAG} limite de chamadas — a loja desta conta fica para depois`,
          {
            ...this.ids(conta),
            motivo: 'limite-de-chamadas',
          },
        );
        return { tipo: 'conta-encerrada' };
      }
      this.contarDaConta(conta, 'pausas429');
      return { tipo: 'pausa' };
    }
    if (err instanceof LiAuthError) {
      const { deps, db } = this.args;
      const r = await tratarFalhaDeLeituraLi(
        { db, agoraMs: deps.agoraMs, increment: deps.increment, logger: deps.logger },
        err,
        this.contextos.get(conta.contaId) ?? null,
        POLITICA_DE_FALHA_RECONCILE_LI,
      );
      if (r.tipo === 'propria' && r.falha.tipo === 'conta') {
        const pulo = this.pularConta(conta, r.falha.erro);
        if (pulo !== null) return pulo;
        // A token saved meanwhile, or the park's contention: the retry reads with what is stored.
        return this.falhaRetentavel(conta, err);
      }
      if (r.tipo === 'alheia' && r.erro !== err) {
        // The park failed on its own: retried when a retry may change it, else rethrown.
        if (retentavelNaFaseLi(r.erro)) return this.falhaRetentavel(conta, r.erro);
        throw r.erro;
      }
      return null;
    }
    if (err instanceof LiAppError) {
      const pulo = this.pularConta(conta, err);
      if (pulo !== null) return pulo;
    }
    if (retentavelNaFaseLi(err)) return this.falhaRetentavel(conta, err);
    if (err instanceof LiHttpError || err instanceof LiConfigError) {
      return this.recusaDaLoja(conta, err);
    }
    return null;
  }

  /** A deterministic refusal of the conta's request (module header, "Failures"): the conta ends. */
  private recusaDaLoja(conta: ContaDaFaseLi, err: LiHttpError | LiConfigError): PassoFaseLi {
    this.contarDaConta(conta, 'recusasDaLoja');
    this.args.deps.logger.error(`${TAG} a loja recusou a leitura — a conta fica incompleta`, {
      ...this.ids(conta),
      motivo: 'recusa-da-loja',
      classe: classeDaFalhaLi(err),
      status: err instanceof LiHttpError ? err.status : null,
      // The package's operation name (the list or a confirmation's detail), never a value.
      operacao: err.operacao,
    });
    return { tipo: 'conta-encerrada' };
  }

  /** A failure a retry may change: retried, or — on the queue's last attempt — the conta ended. */
  private falhaRetentavel(conta: ContaDaFaseLi, err: unknown): PassoFaseLi {
    if (this.args.deps.tentativa < TASK_MAX_ATTEMPTS - 1) return { tipo: 'falha', erro: err };
    this.contarDaConta(conta, 'tentativasEsgotadas');
    this.args.deps.logger.error(`${TAG} tentativas esgotadas na loja — a conta fica incompleta`, {
      ...this.ids(conta),
      motivo: 'tentativas-esgotadas',
      classe: classeDaFalhaLi(err),
    });
    return { tipo: 'conta-encerrada' };
  }
}
