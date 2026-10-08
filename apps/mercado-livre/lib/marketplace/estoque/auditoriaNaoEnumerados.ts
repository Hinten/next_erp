/**
 * The monthly **link audit** (#1200) — the core behind
 * `sweepMercadoLivreAnunciosNaoEnumerados` (02:30 on the 1st, America/Sao_Paulo,
 * half an hour before the 03:00 force-all reconciliation).
 *
 * Both ML sweeps enumerate PRODUTOS through the same two anchor terms
 * (`bulkEstoquePlan.fetchStockFamilies` S1 and `precoPlan.fetchPrecoPage`:
 * `paiId == null` AND `integracoesComProduto array-contains <conta>`). That shape
 * is deliberately economical and this module does not touch it; its price is that
 * a live anúncio whose produto falls outside the two terms is never enumerated and
 * leaves no trace — the sweep reports `completed` while that listing keeps selling
 * at whatever stock it last had. So once a month this walks each active conta's
 * LINKS instead (the shared `anuncios/linksNaoEnumerados.ts` walk, the same one
 * the price job reports from) and acts on every finding:
 *
 *  - **class 2** (`NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO` — the produto's
 *    `integracoesComProduto` lost the conta: a lost trigger event, or the cutover
 *    import, which fires none) is HEALED in place by the tier-1 READ-DERIVED add
 *    (`anuncios/integracoesComProduto.adicionarContaSeViva`) and only logged
 *    (owner decision D1). The heal fixes both sweeps at once, and the 03:00
 *    force-all that follows re-sends the family's stock (D4 — the audit spends no
 *    ML quota and holds no ML secret);
 *  - **everything else** (a link on a variation child, an invalid `paiId`, a link
 *    whose produto is gone) needs a human, so it raises ONE
 *    `anuncioForaDaSincronizacao` aviso per produto (D3), resolved by a later
 *    COMPLETED walk that no longer finds it.
 *
 * Gated only by the master `MERCADO_LIVRE_STOCK_SYNC_ENABLED`
 * (`isStockSyncEnabled()`), never by the reconciliação valve: that one is an
 * ML-quota valve, and this spends none. Off ⇒ nothing is read.
 *
 * ---- ⚠️ "Not found" means "clean" ONLY on a complete walk. A walk truncated by
 * the page cap, its time budget or a cursor that stopped advancing has simply not
 * READ the rows behind the cut, so it resolves NOTHING (and says so in a warn).
 * Even a complete walk re-confirms each candidate before resolving it
 * (`reclassificarProdutoNaoEnumerado`): a walk takes minutes, every page's
 * `getAll` is a separate instant, and a link created or re-pointed behind the
 * cursor is invisible to it. Resolving on absence alone would close a real row
 * this month and re-open it the next — a monthly flap the operator learns to
 * ignore.
 *
 * ---- The avisos are listed by DOCUMENT KEY, not by field. An aviso stores its
 * conta and entidade only in its id (`chaveDeAviso`), so this producer's rows for
 * one conta are exactly the ids in `[<tipo>:<conta>:, <tipo>:<conta>;)` — `;` is
 * the code point after the `:` separator, so the half-open range holds every id
 * starting with `<tipo>:<conta>:` and nothing else. ⚠️ The END is EXCLUSIVE, and
 * the `:` in the START is load-bearing: without it conta `c1` would also list
 * conta `c10`'s rows and resolve them as "not found by c1's walk". A key-order
 * range needs no declared index (it is the primary key).
 *
 * ---- Cost discipline (the plan's L + P + R): the walk reads every link of the
 * conta (closed history included — the cost driver) projected to two fields, plus
 * one masked key read per distinct produto with a live link; the avisos read is
 * R rows projected to three small fields. Open rows are refreshed only when their params
 * changed (no monthly `ocorrencias` churn, no write), NEW rows are capped per
 * conta, and nothing here writes to `estoqueMercadoLivreSync` — its strict schema
 * throws on an unknown key and would kill the whole stock tick.
 *
 * ---- Time: one budget for the whole run ({@link AUDITORIA_ORCAMENTO_MS} of the
 * function's 540 s), handed out as a FAIR SHARE to each conta's walk and checked
 * again inside every write loop, plus a month-rotated starting conta so a
 * truncation never starves the same contas every month. One `logger.info` line
 * per conta as it finishes, so a timeout kill still leaves the evidence of every
 * conta already done; the wrapper logs the run summary ({@link resumirAuditoria}).
 *
 * ---- Per-conta containment: a gRPC-coded Firestore failure
 * (`isGrpcStatusError`) is recorded on that conta's result and the loop moves on;
 * anything else — a corrupt cursor, an invalid page size, a bug — rethrows and
 * fails the run loudly (root `CLAUDE.md` rule 6).
 *
 * ⚠️ This file must not name the transaction API itself: the tier-1 heal runs
 * inside the promoted core writer, and
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js` greps
 * raw source text for the call.
 */
import {
  FieldPath,
  FieldValue,
  type Firestore,
  type Query,
  type QuerySnapshot,
} from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  type PlanoAviso,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import { avisoCollection, integracaoCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  CANAL_AVISO,
  INTEGRACAO_TIPO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  type SituacaoAnuncioForaDaSincronizacao,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { adicionarContaSeViva } from '../anuncios/integracoesComProduto';
import {
  CODIGO_NAO_ENUMERADO,
  type CodigoNaoEnumerado,
  type FetchLinksNaoEnumeradosPage,
  fetchLinksNaoEnumeradosPage,
  reclassificarProdutoNaoEnumerado,
} from '../anuncios/linksNaoEnumerados';
import { STOCK_SYNC_FLAG_ENV, isStockSyncEnabled } from './bulkEstoquePlan';

/* -------------------------------- constants -------------------------------- */

/** The message of the run's ONE summary line — what the #948 step greps for. */
export const AUDITORIA_LOG_PREFIX = '[mercado-livre] auditoria de anúncios não enumerados';

/**
 * The whole run's time budget, out of the scheduled function's 540 s timeout. The
 * ~140 s left over absorb the one page each walk may overrun its share by, and
 * the write loops' last in-flight operation — a timeout kill mid-conta loses that
 * conta's log line, which is the evidence the summary depends on.
 */
export const AUDITORIA_ORCAMENTO_MS = 400_000;

/** Links read per walk page (the shared walk's `pageLimit`; `deps.pageLimit` overrides it in tests). */
export const AUDITORIA_PAGE_LIMIT = 500;

/** Pages per conta per run — 100 000 links, far above any conta this ERP serves. */
export const AUDITORIA_MAX_PAGINAS_POR_CONTA = 200;

/**
 * NEW avisos per conta per run. A cutover-sized backlog would otherwise flood the
 * bell with hundreds of rows at once, which teaches the team to ignore it; the
 * overflow is counted and sampled in the log and surfaces month by month as the
 * first ones are fixed. ⚠️ Open rows are NEVER capped — refreshing one is not a
 * new alert, and skipping it would leave stale params on a row the operator
 * already reads.
 */
export const MAX_AVISOS_NOVOS_POR_CONTA = 20;

/** Ids kept per log sample (healed anchors, suppressed avisos). */
export const AMOSTRA_MAX = 20;

/** Rows per page of the avisos key-range read. */
const PAGINA_AVISOS = 500;

/**
 * Why a row was closed — persisted in `resolucaoMotivo`, so not free to rename.
 * The two machine resolvers `anuncioForaDaSincronizacao` names in `aviso.ts`.
 */
export const RESOLUCAO_AUDITORIA = {
  /** A COMPLETED walk no longer found the produto, and a fresh re-read agreed. */
  naoEncontrado: 'nao-encontrado-na-auditoria',
  /** The conta is no longer an active ML integração: nothing walks it any more. */
  contaInativa: 'conta-inativa',
} as const;

/**
 * The walk's codes that raise an aviso, mapped to the aviso's own situação.
 *
 * ⚠️ Typed over every code EXCEPT the healed one, so a fifth `NAO_ENUMERADO_*`
 * code fails typecheck here until someone decides whether it heals or alerts.
 */
const SITUACAO_DO_CODIGO: Record<
  Exclude<CodigoNaoEnumerado, typeof CODIGO_NAO_ENUMERADO.contaForaDoProduto>,
  SituacaoAnuncioForaDaSincronizacao
> = {
  [CODIGO_NAO_ENUMERADO.linkEmVariacao]: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
  [CODIGO_NAO_ENUMERADO.paiIdInvalido]: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.paiIdInvalido,
  [CODIGO_NAO_ENUMERADO.produtoAusente]: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente,
};

/* ---------------------------------- types ---------------------------------- */

/** Why a conta's walk stopped short — `null` on the result means it drained. */
export type TruncamentoAuditoria = 'paginas' | 'orcamento' | 'cursor-parado';

/** One stored `anuncioForaDaSincronizacao` row, as the key-range read returns it. */
export interface AvisoExistente {
  /** The document id — which IS the dedup key. */
  chave: string;
  /** `resolvidoEm == null` (absent counts as open, the schema default). */
  aberto: boolean;
  /**
   * The stored `canal` (`null` when absent or not a string). Only a
   * `mercadoLivre` row is this producer's to RESOLVE — see {@link ehDesteProdutor}.
   */
  canal: string | null;
  params: Record<string, unknown>;
}

/** The avisos seam — injectable so the offline suite needs no aviso writer. */
export interface AvisosAuditoria {
  /** Every row of this tipo for ONE conta (open and resolved), by key range. */
  listarDaConta(db: Firestore, integracaoId: string): Promise<AvisoExistente[]>;
  /** Every row of this tipo, all contas. */
  listarDoTipo(db: Firestore): Promise<AvisoExistente[]>;
  escrever(db: Firestore, plano: PlanoAviso): Promise<ResultadoAviso>;
  resolver(db: Firestore, chave: string, motivo: string): Promise<boolean>;
}

export interface AuditoriaDeps {
  /** The run's ONE clock, in MILLISECONDS (`Date.now` in prod). */
  agora: () => number;
  /** The walk seam — defaults to the shared `fetchLinksNaoEnumeradosPage`. */
  fetchPage?: FetchLinksNaoEnumeradosPage;
  /**
   * The heal seam — defaults to the tier-1 `adicionarContaSeViva` binding. True
   * when the conta was added, false when no live parent link survived the
   * transactional re-read or the produto is gone.
   */
  curar?: (db: Firestore, produtoId: string, integracaoId: string) => Promise<boolean>;
  /** The avisos seam — defaults to {@link avisosAuditoriaPadrao} on `agora`. */
  avisos?: AvisosAuditoria;
  /** The pre-resolve re-read — defaults to `reclassificarProdutoNaoEnumerado`. */
  reconfirmar?: (
    db: Firestore,
    produtoId: string,
    integracaoId: string,
  ) => Promise<CodigoNaoEnumerado | null>;
  /** Overrides {@link AUDITORIA_PAGE_LIMIT} (tests). */
  pageLimit?: number;
}

/** One conta's outcome — also the payload of its own log line. */
export interface AuditoriaContaResult {
  integracaoId: string;
  /**
   * Why this conta stopped short — `null` ⇔ the walk DRAINED and no heal, write
   * or resolve loop ran out of budget.
   *
   * ⚠️ Non-null does NOT mean "nothing was resolved". Resolving starts only
   * after a drained walk whose heals and aviso writes all fit the budget, so a
   * walk-side cut (`'paginas'`, `'cursor-parado'`, or `'orcamento'` before the
   * resolve phase) resolves nothing; but the resolve loop checks the run budget
   * per row too, and an `'orcamento'` set THERE follows the resolutions already
   * counted in `resolvidos` — the rest wait for next month's walk.
   */
  truncada: TruncamentoAuditoria | null;
  paginas: number;
  /** Every link document read, closed history included — the cost driver. */
  linksLidos: number;
  /** Distinct produtos key-read across the pages (a produto on two pages counts twice). */
  produtosLidos: number;
  /** LIVE links inspected. */
  inspecionados: number;
  /**
   * Produtos per FINAL code (the latest read's classification), class 2
   * included. A produto whose latest read was clean counts under none.
   */
  porSituacao: Record<CodigoNaoEnumerado, number>;
  /** Class-2 produtos the heal added the conta to. */
  curados: number;
  /** Class-2 produtos whose heal found no live parent link left (or no produto). */
  curasSemEfeito: number;
  /** Class-2 produtos never attempted because the budget ran out. */
  curasPendentes: number;
  /** Up to {@link AMOSTRA_MAX} healed anchor ids — what a manual push would target (D4). */
  amostraCurados: string[];
  /** What each aviso write did. */
  avisos: Record<ResultadoAviso, number>;
  /** Open rows whose params were already current — no write. */
  inalterados: number;
  /** NEW avisos held back by {@link MAX_AVISOS_NOVOS_POR_CONTA}. */
  suprimidos: number;
  amostraSuprimidos: string[];
  /** Open rows closed as `nao-encontrado-na-auditoria`. */
  resolvidos: number;
  /** Open rows the walk missed but the re-confirmation still found dirty. */
  mantidos: number;
  duracaoMs: number;
  /** A contained gRPC failure, or null. */
  error: string | null;
}

export interface AuditoriaResult {
  enabled: boolean;
  /** One entry per conta audited, in processing (month-rotated) order. */
  contas: AuditoriaContaResult[];
  /** Contas reached with no budget left — not walked at all this run. */
  naoAuditadas: string[];
  /** Open rows closed as `conta-inativa`. */
  inativasResolvidas: number;
}

/* --------------------------------- the run --------------------------------- */

/**
 * The whole monthly run: enumerate every ACTIVE ML conta (the exact
 * `runStockSweep` enumeration, on the declared `(tipo, ativo)` index), audit each
 * in month-rotated order within its fair share of the budget, then close the rows
 * of contas that are no longer active.
 */
export async function runAuditoriaNaoEnumerados(
  db: Firestore,
  deps: AuditoriaDeps,
): Promise<AuditoriaResult> {
  if (!isStockSyncEnabled()) {
    logger.info(`${AUDITORIA_LOG_PREFIX}: desabilitada (${STOCK_SYNC_FLAG_ENV} != '1') — no-op`);
    return { enabled: false, contas: [], naoAuditadas: [], inativasResolvidas: 0 };
  }

  const agora = deps.agora;
  const inicio = agora();
  const prazoGlobal = inicio + AUDITORIA_ORCAMENTO_MS;
  const exec: Execucao = {
    db,
    agora,
    prazoGlobal,
    fetchPage: deps.fetchPage ?? fetchLinksNaoEnumeradosPage,
    curar: deps.curar ?? adicionarContaSeViva,
    avisos: deps.avisos ?? avisosAuditoriaPadrao(agora),
    reconfirmar: deps.reconfirmar ?? reclassificarProdutoNaoEnumerado,
    pageLimit: deps.pageLimit ?? AUDITORIA_PAGE_LIMIT,
  };

  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .get();
  const ativas = snap.docs.map((d) => d.id).sort();
  const ordem = rotacionarPorMes(ativas, inicio);

  const contas: AuditoriaContaResult[] = [];
  const naoAuditadas: string[] = [];
  for (let i = 0; i < ordem.length; i += 1) {
    const integracaoId = ordem[i]!;
    const agoraConta = agora();
    const restante = prazoGlobal - agoraConta;
    if (restante <= 0) {
      // Earlier contas spent the whole budget. Loud, because this conta's class-2
      // produtos stay out of both sweeps for another month — the month rotation
      // is what moves it to the front next time.
      naoAuditadas.push(integracaoId);
      logger.warn(
        `${AUDITORIA_LOG_PREFIX}: conta NÃO auditada — orçamento de tempo esgotado antes dela`,
        { integracaoId, orcamentoMs: AUDITORIA_ORCAMENTO_MS },
      );
      continue;
    }
    // Fair share: what is left, split over the contas still to go — so a conta
    // that finished early hands its slack to the ones after it, and one huge
    // conta cannot starve the rest.
    const prazoLeitura = agoraConta + Math.floor(restante / (ordem.length - i));
    const r = resultadoVazio(integracaoId);
    try {
      await auditarConta(exec, r, prazoLeitura);
    } catch (err) {
      // The deliberate per-conta boundary (module doc): Firestore said no — record
      // it and move on. Anything else is a bug or corruption and rethrows.
      if (!isGrpcStatusError(err)) throw err;
      r.error = err.message;
      logger.error(`${AUDITORIA_LOG_PREFIX}: conta contida por erro do Firestore`, {
        integracaoId,
        code: err.code,
        error: err.message,
      });
    }
    r.duracaoMs = agora() - agoraConta;
    logger.info(`${AUDITORIA_LOG_PREFIX}: conta concluída`, { ...r });
    contas.push(r);
  }

  const inativasResolvidas = await resolverContasInativas(exec, ativas);
  return { enabled: true, contas, naoAuditadas, inativasResolvidas };
}

/* ------------------------------- one conta -------------------------------- */

/** Everything a conta's audit needs, resolved once per run. */
interface Execucao {
  db: Firestore;
  agora: () => number;
  prazoGlobal: number;
  fetchPage: FetchLinksNaoEnumeradosPage;
  curar: (db: Firestore, produtoId: string, integracaoId: string) => Promise<boolean>;
  avisos: AvisosAuditoria;
  reconfirmar: (
    db: Firestore,
    produtoId: string,
    integracaoId: string,
  ) => Promise<CodigoNaoEnumerado | null>;
  pageLimit: number;
}

/**
 * A produto's accumulated finding: the LATEST read's code, every live item id
 * seen since. A produto whose latest read was clean has no entry at all.
 */
interface Achado {
  code: CodigoNaoEnumerado;
  itemIds: Set<string>;
}

/**
 * One conta: walk → heal → raise/refresh → (complete walk only) resolve. Mutates
 * `r` as it goes, so a contained failure halfway keeps the counts of everything
 * that already happened.
 *
 * ⚠️ Two deadlines, on purpose. The WALK stops at the conta's fair share
 * (`prazoLeitura`); the WRITE loops run against the run's global budget. Acting
 * on findings already paid for is the point of the run, so a walk cut short by
 * its share still heals and raises what it saw — a heal is a few reads and one
 * write — while the global budget still bounds everything, so the 540 s timeout
 * never fires mid-write.
 */
async function auditarConta(
  exec: Execucao,
  r: AuditoriaContaResult,
  prazoLeitura: number,
): Promise<void> {
  const { db, agora } = exec;
  const integracaoId = r.integracaoId;
  const semOrcamento = () => agora() >= exec.prazoGlobal;
  const truncar = (motivo: TruncamentoAuditoria) => {
    r.truncada ??= motivo;
  };

  // ---- 1. The walk.
  const achados = new Map<string, Achado>();
  let cursor: string | null = null;
  for (;;) {
    if (r.paginas >= AUDITORIA_MAX_PAGINAS_POR_CONTA) {
      truncar('paginas');
      break;
    }
    if (agora() >= prazoLeitura) {
      truncar('orcamento');
      break;
    }
    const page = await exec.fetchPage(db, {
      integracaoId,
      afterLinkPath: cursor,
      pageLimit: exec.pageLimit,
    });
    r.paginas += 1;
    r.linksLidos += page.lidos;
    r.produtosLidos += page.produtosLidos;
    r.inspecionados += page.inspecionados;
    // ⚠️ The LATEST read wins — and a CLEAN read is a read too. Each page's
    // produto read is its own instant, so a produto seen on two pages is
    // classified by the later, fresher one: a later finding replaces the code,
    // and a later CLEAN read drops the finding outright. Folding `naoEnumerados`
    // alone would keep page k's stale code for a produto fixed before page k+1
    // read it — a heal on nothing, or a NEW aviso for a clean produto that stands
    // until next month. Within one page every link of a produto shares a single
    // read, hence a single verdict (`limpos` and `naoEnumerados` are disjoint).
    for (const produtoId of page.limpos) achados.delete(produtoId);
    for (const f of page.naoEnumerados) {
      // Item ids accumulate across the finding's pages — they are all that
      // produto's listings — and leave with it when a clean read drops it: a
      // produto that turns dirty AGAIN reports what the later reads saw.
      const anterior = achados.get(f.produtoId);
      const itemIds = anterior?.itemIds ?? new Set<string>();
      if (f.itemId != null) itemIds.add(f.itemId);
      achados.set(f.produtoId, { code: f.code, itemIds });
    }
    if (page.nextAfterLinkPath == null) break; // drained — the only complete exit
    // ⚠️ EQUALITY, never an ordering test. A collection-group cursor is a full
    // path ordered segment by segment, which plain string comparison does not
    // reproduce (`a-b` sorts before `a/` as a string, after it as a segment), so a
    // `<=` here would call a healthy walk stuck. Equality is the one thing a
    // non-advancing walk always shows — and would otherwise loop to the page cap.
    if (page.nextAfterLinkPath === cursor) {
      truncar('cursor-parado');
      break;
    }
    cursor = page.nextAfterLinkPath;
  }

  const produtos = [...achados.keys()].sort();
  for (const produtoId of produtos) r.porSituacao[achados.get(produtoId)!.code] += 1;

  // ---- 2. Heal class 2 — on a truncated walk too: what was seen is real.
  const aCurar = produtos.filter(
    (id) => achados.get(id)!.code === CODIGO_NAO_ENUMERADO.contaForaDoProduto,
  );
  for (let i = 0; i < aCurar.length; i += 1) {
    if (semOrcamento()) {
      truncar('orcamento');
      r.curasPendentes = aCurar.length - i;
      logger.warn(`${AUDITORIA_LOG_PREFIX}: orçamento esgotado antes de curar todos`, {
        integracaoId,
        curasPendentes: r.curasPendentes,
      });
      break;
    }
    const produtoId = aCurar[i]!;
    if (await exec.curar(db, produtoId, integracaoId)) {
      r.curados += 1;
      if (r.amostraCurados.length < AMOSTRA_MAX) r.amostraCurados.push(produtoId);
    } else {
      r.curasSemEfeito += 1;
    }
  }

  // ---- 3. Raise / refresh one aviso per produto a human must fix.
  if (semOrcamento()) {
    truncar('orcamento');
    logger.warn(
      `${AUDITORIA_LOG_PREFIX}: orçamento esgotado antes dos avisos — nada escrito nem resolvido`,
      { integracaoId, achadosSemAviso: produtos.length - aCurar.length },
    );
    return;
  }
  const prefixo = prefixoDaConta(integracaoId);
  const existentes = new Map(
    (await exec.avisos.listarDaConta(db, integracaoId)).map((a) => [a.chave, a]),
  );

  // `vistos` holds EVERY aviso-class finding — capped, suppressed or unchanged
  // alike — so nothing the walk saw can be resolved below. A HEALED produto is
  // deliberately absent: its old row (say, a link that was on a child last month)
  // is now a resolve candidate, and the re-confirmation decides.
  const vistos = new Set<string>();
  const planos: { chave: string; produtoId: string; plano: PlanoAviso }[] = [];
  for (const produtoId of produtos) {
    const achado = achados.get(produtoId)!;
    if (achado.code === CODIGO_NAO_ENUMERADO.contaForaDoProduto) continue;
    const chave = chaveDoAviso(integracaoId, produtoId);
    // Two produtoIds that fold to one key (`a.b` / `a_b` — the `chaveDeAviso`
    // caveat) share ONE row: the first in id order owns it, so one run never
    // writes the same row twice with two different stories.
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    planos.push({
      chave,
      produtoId,
      plano: planoDoAviso(integracaoId, produtoId, SITUACAO_DO_CODIGO[achado.code], achado.itemIds),
    });
  }

  let novos = 0;
  for (const { chave, produtoId, plano } of planos) {
    const existente = existentes.get(chave);
    if (existente?.aberto === true && mesmosParams(existente.params, plano.params ?? {})) {
      r.inalterados += 1;
      continue;
    }
    // A RESOLVED row counts as new: writing it REOPENS the row with a fresh
    // `criadoEm`, which re-alerts exactly like a create does.
    const ehNovo = existente?.aberto !== true;
    if (ehNovo && novos >= MAX_AVISOS_NOVOS_POR_CONTA) {
      r.suprimidos += 1;
      if (r.amostraSuprimidos.length < AMOSTRA_MAX) r.amostraSuprimidos.push(produtoId);
      continue;
    }
    if (semOrcamento()) {
      truncar('orcamento');
      break;
    }
    const resultado = await exec.avisos.escrever(db, plano);
    r.avisos[resultado] += 1;
    if (ehNovo) novos += 1;
  }
  if (r.suprimidos > 0) {
    logger.warn(
      `${AUDITORIA_LOG_PREFIX}: avisos novos suprimidos pelo limite de ${String(MAX_AVISOS_NOVOS_POR_CONTA)} por conta`,
      { integracaoId, suprimidos: r.suprimidos, amostra: r.amostraSuprimidos },
    );
  }

  // ---- 4. Resolve — ONLY on a complete walk (module doc).
  if (r.truncada != null) {
    logger.warn(
      `${AUDITORIA_LOG_PREFIX}: auditoria TRUNCADA (${r.truncada}) — nenhum aviso resolvido nesta conta`,
      { integracaoId, paginas: r.paginas, linksLidos: r.linksLidos },
    );
    return;
  }
  const candidatos = [...existentes.values()]
    .filter((a) => a.aberto && ehDesteProdutor(a) && !vistos.has(a.chave))
    .sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));
  for (const aviso of candidatos) {
    // The key range guarantees the `<prefixo>:` start; an EMPTY or colon-bearing
    // remainder is a row this producer never writes (`chaveDeAviso` strips a
    // trailing separator and folds every inner one), so it is left alone.
    const produtoId = aviso.chave.slice(prefixo.length + 1);
    if (produtoId === '' || produtoId.includes(':')) {
      logger.warn(`${AUDITORIA_LOG_PREFIX}: aviso com chave fora do formato — ignorado`, {
        integracaoId,
        chave: aviso.chave,
      });
      continue;
    }
    if (semOrcamento()) {
      truncar('orcamento');
      logger.warn(`${AUDITORIA_LOG_PREFIX}: orçamento esgotado durante as resoluções`, {
        integracaoId,
      });
      break;
    }
    // ⚠️ A produtoId carrying a folded character (`.` → `_`) is re-read under the
    // FOLDED id, which names no produto, so it re-confirms clean and resolves —
    // and the next walk re-opens it. The same accepted fold cost `aviso.ts`
    // documents for this tipo's key; produto ids here are auto-ids or
    // deterministic alphanumeric ids, so it is not expected to be reached.
    const code = await exec.reconfirmar(db, produtoId, integracaoId);
    // Class 2 is not a finding a human owns: the row's own problem is gone, and
    // the next walk heals the denorm. Resolving is right; re-raising would be noise.
    if (code !== null && code !== CODIGO_NAO_ENUMERADO.contaForaDoProduto) {
      r.mantidos += 1;
      continue;
    }
    if (await exec.avisos.resolver(db, aviso.chave, RESOLUCAO_AUDITORIA.naoEncontrado)) {
      r.resolvidos += 1;
    }
  }
}

/* ---------------------------- inactive contas ----------------------------- */

/**
 * Close every OPEN row whose conta was not among the active contas enumerated by
 * THIS run — the second machine resolver `aviso.ts` names. Nothing walks a
 * deactivated or deleted conta any more, so without this its rows would stand
 * until retention on a collection nobody can dismiss by hand.
 *
 * ⚠️ "Inactive" means NOT ENUMERATED, never "not audited": a conta skipped for
 * budget or contained by an error is still active, and its rows are untouched.
 * A row whose id does not have the producer's exact three-segment shape is not
 * this producer's row and is left alone — and neither is a row of ANOTHER
 * channel ({@link ehDesteProdutor}): its conta is never an ML integração, so
 * this pass is precisely the resolver that would close it every month.
 */
async function resolverContasInativas(exec: Execucao, ativas: readonly string[]): Promise<number> {
  const { db, agora } = exec;
  if (agora() >= exec.prazoGlobal) {
    logger.warn(`${AUDITORIA_LOG_PREFIX}: orçamento esgotado — contas inativas não varridas`);
    return 0;
  }
  const prefixosAtivos = new Set(ativas.map(prefixoDaConta));
  const linhas = await exec.avisos.listarDoTipo(db);
  let resolvidas = 0;
  for (const aviso of linhas) {
    if (!aviso.aberto || !ehDesteProdutor(aviso)) continue;
    const partes = aviso.chave.split(':');
    if (partes.length !== 3 || partes.some((p) => p === '')) continue;
    if (prefixosAtivos.has(`${partes[0]!}:${partes[1]!}`)) continue;
    if (agora() >= exec.prazoGlobal) {
      logger.warn(`${AUDITORIA_LOG_PREFIX}: orçamento esgotado durante as contas inativas`);
      break;
    }
    if (await exec.avisos.resolver(db, aviso.chave, RESOLUCAO_AUDITORIA.contaInativa)) {
      resolvidas += 1;
    }
  }
  return resolvidas;
}

/**
 * Is this a row THIS producer may resolve — one stamped `canal: mercadoLivre`?
 *
 * ⚠️ The tipo is CHANNEL-NEUTRAL (`aviso.ts`): another channel's twin of this
 * audit raises the same `anuncioForaDaSincronizacao`, in the same key space,
 * under its own `canal`. Both resolvers here judge a row against MERCADO LIVRE
 * state only — a walk of ML links, the set of ACTIVE ML integrações — so without
 * this test the inactive-conta pass would close every other channel's open row
 * as `conta-inativa` (its conta is never an ML integração) and that channel's
 * producer would re-open it: a monthly flap on both sides. A row with no
 * `canal` is no row of this producer's either — {@link planoDoAviso} always
 * stamps one.
 */
function ehDesteProdutor(aviso: AvisoExistente): boolean {
  return aviso.canal === CANAL_AVISO.mercadoLivre;
}

/* ------------------------------ the aviso shape ---------------------------- */

/** The dedup key — and document id — of one produto's row on one conta. */
export function chaveDoAviso(integracaoId: string, produtoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.anuncioForaDaSincronizacao,
    conta: integracaoId,
    entidade: produtoId,
  });
}

/**
 * `chaveDeAviso({ tipo, conta })` — every row of the conta starts with this plus
 * `:`. ⚠️ Refuses an empty conta: `chaveDeAviso` drops an empty segment, so the
 * "prefix" would be the bare tipo and the range every conta's rows.
 */
function prefixoDaConta(integracaoId: string): string {
  const prefixo = chaveDeAviso({
    tipo: TIPO_AVISO.anuncioForaDaSincronizacao,
    conta: integracaoId,
  });
  if (prefixo === chaveDeAviso({ tipo: TIPO_AVISO.anuncioForaDaSincronizacao })) {
    throw new RangeError(`${AUDITORIA_LOG_PREFIX}: integracaoId vazio`);
  }
  return prefixo;
}

/**
 * The `anuncioForaDaSincronizacao` row for one produto — the shape `aviso.ts`
 * documents for this tipo.
 *
 * ⚠️ `relogioEvento` and `prazo` are OMITTED, not nulled: `escreverAviso` reads an
 * absent optional as "I do not know" and a `null` as "set it to null". This is a
 * periodic observation by one scheduled writer — there is no provider clock and no
 * deadline — and the dedup id is the whole race guard (tier 0).
 */
export function planoDoAviso(
  integracaoId: string,
  produtoId: string,
  situacao: SituacaoAnuncioForaDaSincronizacao,
  itemIds: ReadonlySet<string>,
): PlanoAviso {
  const ids = [...itemIds].sort();
  return {
    tipo: TIPO_AVISO.anuncioForaDaSincronizacao,
    conta: integracaoId,
    entidade: produtoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.mercadoLivre,
    // Codes and ids only — the pt-BR lives in `apps/web/lib/avisos/mensagens.ts`.
    params: { situacao, anuncio: ids[0] ?? '', anuncios: ids.length },
    motivo: situacao,
    urlInterna: {
      // A produto that no longer exists has no page to open: send the operator to
      // the conta, where the orphan anúncio can be ended.
      rota:
        situacao === SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente
          ? ROTAS_AVISO.canalMercadoLivre.build(integracaoId)
          : ROTAS_AVISO.produto.build(produtoId),
      campo: null,
    },
  };
}

/**
 * Are the stored params EXACTLY the new ones — same keys, strictly equal values?
 *
 * ⚠️ Deliberately no fold: this decides whether a row is written, and an equality
 * that is too wide skips a real change. `'3'` is not `3` (a hand-edited or legacy
 * row is rewritten into the canonical shape), and an extra stored key forces a
 * refresh because a write replaces `params` wholesale.
 */
export function mesmosParams(
  armazenado: Record<string, unknown>,
  novo: Record<string, string | number>,
): boolean {
  const chaves = Object.keys(novo);
  if (Object.keys(armazenado).length !== chaves.length) return false;
  return chaves.every((k) => Object.hasOwn(armazenado, k) && armazenado[k] === novo[k]);
}

/* ------------------------------ the avisos port ---------------------------- */

/** The production avisos seam: key-range reads + the shared writer and resolver. */
export function avisosAuditoriaPadrao(agora: () => number): AvisosAuditoria {
  return {
    listarDaConta: listarAvisosDaConta,
    listarDoTipo: listarAvisosDoTipo,
    escrever: async (db, plano) => {
      const { resultado } = await escreverAviso(db, plano, {
        increment: (by) => FieldValue.increment(by),
        agoraUs: millisToMicros(agora()),
        logger,
      });
      return resultado;
    },
    resolver: (db, chave, motivo) =>
      resolverAviso(db, chave, motivo, { agoraUs: millisToMicros(agora()) }),
  };
}

/** A half-open document-key range: ids `>= inicio` and `< fim`. */
export interface FaixaDeChaves {
  inicio: string;
  fim: string;
}

/**
 * The key range holding exactly this producer's rows for ONE conta —
 * `[<tipo>:<conta>:, <tipo>:<conta>;)`. Exported so the staging suite
 * (`auditoriaNaoEnumerados.staging.test.ts`) explains the very bounds this file
 * reads, rather than a hand-copied pair that could drift from them.
 */
export function faixaDeChavesDaConta(integracaoId: string): FaixaDeChaves {
  return faixaDoPrefixo(prefixoDaConta(integracaoId));
}

/** `[<prefixo>:, <prefixo>;)` — `;` is the code point after the `:` separator. */
function faixaDoPrefixo(prefixo: string): FaixaDeChaves {
  return { inicio: `${prefixo}:`, fim: `${prefixo};` };
}

/** Every row of this tipo for one conta — `[<tipo>:<conta>:, <tipo>:<conta>;)`. */
export function listarAvisosDaConta(
  db: Firestore,
  integracaoId: string,
): Promise<AvisoExistente[]> {
  return listarFaixaDeChaves(db, faixaDeChavesDaConta(integracaoId));
}

/** Every row of this tipo, all contas — `[<tipo>:, <tipo>;)`. */
export function listarAvisosDoTipo(db: Firestore): Promise<AvisoExistente[]> {
  return listarFaixaDeChaves(
    db,
    faixaDoPrefixo(chaveDeAviso({ tipo: TIPO_AVISO.anuncioForaDaSincronizacao })),
  );
}

/**
 * ONE page of the key-range read as an unexecuted query: ids in `[inicio, fim)`
 * — or after `ultimo`, for every page but the first — projected to the three
 * fields the audit decides on (open?, current params?, whose row?). Exported for
 * the staging suite, which `explain()`s this very object (the
 * `consultaDaVarredura` precedent in `anuncios/linksNaoEnumerados.ts`).
 *
 * ⚠️ `endBefore`, never `endAt`: the range end `<prefixo>;` is a perfectly legal
 * document id that is NOT one of this prefix's rows, and an inclusive end would
 * hand it to the resolver. Each later page REPLACES the start cursor with
 * `startAfter(<last id>)` (a query holds one start cursor) and keeps the end.
 */
export function consultaDaFaixaDeChaves(
  db: Firestore,
  { inicio, fim }: FaixaDeChaves,
  ultimo: string | null = null,
): Query {
  const base = avisoCollection
    .ref(db, {})
    .select('resolvidoEm', 'params', 'canal')
    .orderBy(FieldPath.documentId());
  const comInicio: Query = ultimo == null ? base.startAt(inicio) : base.startAfter(ultimo);
  return comInicio.endBefore(fim).limit(PAGINA_AVISOS);
}

/** The key-range read itself — every page of {@link consultaDaFaixaDeChaves}, by id. */
async function listarFaixaDeChaves(db: Firestore, faixa: FaixaDeChaves): Promise<AvisoExistente[]> {
  const linhas: AvisoExistente[] = [];
  let ultimo: string | null = null;
  for (;;) {
    const snap: QuerySnapshot = await consultaDaFaixaDeChaves(db, faixa, ultimo).get();
    for (const doc of snap.docs) {
      const raw = doc.data() as Record<string, unknown>;
      const params = raw.params;
      linhas.push({
        chave: doc.id,
        aberto: raw.resolvidoEm == null,
        canal: typeof raw.canal === 'string' ? raw.canal : null,
        params:
          params != null && typeof params === 'object' && !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : {},
      });
    }
    if (snap.docs.length < PAGINA_AVISOS) return linhas;
    ultimo = snap.docs[snap.docs.length - 1]!.id;
  }
}

/* --------------------------------- helpers --------------------------------- */

/**
 * The active contas, sorted, rotated by the CALENDAR MONTH in America/Sao_Paulo
 * — the zone of the cron that fires this — so whichever conta a truncation
 * starves this month goes first next month.
 *
 * ⚠️ The zone is NAMED (`no-ambient-timezone`): the backends do not share one,
 * and the ambient month at 02:30 on the 1st would be the PREVIOUS month on a host
 * three hours behind.
 */
function rotacionarPorMes(ids: readonly string[], agoraMs: number): string[] {
  if (ids.length === 0) return [];
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date(agoraMs));
  const parte = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? Number.NaN);
  const mes = parte('year') * 12 + (parte('month') - 1);
  const inicio = Number.isFinite(mes) ? mes % ids.length : 0;
  return [...ids.slice(inicio), ...ids.slice(0, inicio)];
}

function zeroPorSituacao(): Record<CodigoNaoEnumerado, number> {
  return {
    [CODIGO_NAO_ENUMERADO.produtoAusente]: 0,
    [CODIGO_NAO_ENUMERADO.linkEmVariacao]: 0,
    [CODIGO_NAO_ENUMERADO.paiIdInvalido]: 0,
    [CODIGO_NAO_ENUMERADO.contaForaDoProduto]: 0,
  };
}

function zeroAvisos(): Record<ResultadoAviso, number> {
  return { criado: 0, repetido: 0, reaberto: 0, ignorado: 0 };
}

function resultadoVazio(integracaoId: string): AuditoriaContaResult {
  return {
    integracaoId,
    truncada: null,
    paginas: 0,
    linksLidos: 0,
    produtosLidos: 0,
    inspecionados: 0,
    porSituacao: zeroPorSituacao(),
    curados: 0,
    curasSemEfeito: 0,
    curasPendentes: 0,
    amostraCurados: [],
    avisos: zeroAvisos(),
    inalterados: 0,
    suprimidos: 0,
    amostraSuprimidos: [],
    resolvidos: 0,
    mantidos: 0,
    duracaoMs: 0,
    error: null,
  };
}

/* --------------------------------- summary --------------------------------- */

/**
 * The payload of the run's ONE summary line ({@link AUDITORIA_LOG_PREFIX}) — what
 * the #948 step reads to attribute the audit's cost separately from the sweeps.
 * Sums over the audited contas; the samples are `<conta>/<produto>`, capped.
 */
export function resumirAuditoria(
  result: AuditoriaResult,
  duracaoMs: number,
): Record<string, unknown> {
  const soma = (f: (c: AuditoriaContaResult) => number) =>
    result.contas.reduce((acc, c) => acc + f(c), 0);
  const porSituacao = zeroPorSituacao();
  const avisos = zeroAvisos();
  for (const c of result.contas) {
    for (const k of Object.keys(porSituacao) as CodigoNaoEnumerado[]) {
      porSituacao[k] += c.porSituacao[k];
    }
    for (const k of Object.keys(avisos) as ResultadoAviso[]) avisos[k] += c.avisos[k];
  }
  const amostra = (f: (c: AuditoriaContaResult) => string[]) =>
    result.contas.flatMap((c) => f(c).map((id) => `${c.integracaoId}/${id}`)).slice(0, AMOSTRA_MAX);
  return {
    enabled: result.enabled,
    contas: result.contas.length,
    completas: result.contas.filter((c) => c.truncada == null && c.error == null).length,
    truncadas: result.contas.filter((c) => c.truncada != null).length,
    naoAuditadas: result.naoAuditadas,
    paginas: soma((c) => c.paginas),
    linksLidos: soma((c) => c.linksLidos),
    produtosLidos: soma((c) => c.produtosLidos),
    inspecionados: soma((c) => c.inspecionados),
    porSituacao,
    curados: soma((c) => c.curados),
    curasSemEfeito: soma((c) => c.curasSemEfeito),
    curasPendentes: soma((c) => c.curasPendentes),
    amostraCurados: amostra((c) => c.amostraCurados),
    avisos,
    inalterados: soma((c) => c.inalterados),
    suprimidos: soma((c) => c.suprimidos),
    amostraSuprimidos: amostra((c) => c.amostraSuprimidos),
    resolvidos: soma((c) => c.resolvidos),
    mantidos: soma((c) => c.mantidos),
    inativasResolvidas: result.inativasResolvidas,
    errorCount: result.contas.filter((c) => c.error != null).length,
    duracaoMs,
  };
}
