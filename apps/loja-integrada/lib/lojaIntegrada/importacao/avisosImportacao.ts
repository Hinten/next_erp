/**
 * The product import's three avisos (master plan step 9) — their raises and their machine
 * resolvers, over the shared `escreverAviso`/`resolverAviso`. The tipos, keys and params are
 * `packages/schemas/src/aviso.ts`'s; the wording is the web's.
 *
 *  - **`lojaIntegradaImportacaoComPendencias`** (one per conta, the summary):
 *    {@link sincronizarAvisoDePendenciasLi} at an `aplicar` job's END. At least one ACTIONABLE
 *    pendência ⇒ raised, with the total and one count per code. Resolved ONLY by an `aplicar` job
 *    with `alvo: todos` that ends `concluido` with ZERO actionable pendências: a job of a narrower
 *    target (`selecionados`, `naoNoErp`, `jaNoErp`) never resolves it — its scope does not contain
 *    the raising job's — and neither does a job that failed or was cancelled. Informational codes
 *    never keep it open. The caller decides on a FRESH read of its job (`despacho.ts`, "The summary
 *    aviso"); a Cancelar landing between that read and the job's stamp is its stated residual.
 *  - **`lojaIntegradaCategoriaSemVinculo`** (one per store category): raised by the complete step
 *    ({@link avisarCategoriaSemVinculoLi}) for a product imported without a category; resolved by a
 *    later `aplicar` job's catalogue phase ({@link resolverCategoriasSemVinculoLi}) once the category
 *    is linked for the conta or gone from the store's list.
 *  - **`lojaIntegradaRevisaoFiscal`** (one per conta): raised and resolved by the complete step's
 *    tax-review re-check ({@link sincronizarAvisoDeRevisaoFiscalLi}) — open while the list has
 *    entries, resolved when it is empty.
 *
 * ## Simular raises and resolves NOTHING
 *
 * Every function here takes the job's `modo` and, under `simular`, returns
 * {@link RESULTADO_AVISO_IMPORTACAO_LI}`.simulacao` before touching Firestore: a simulation changed
 * nothing, so it can neither report a problem it did not cause nor close one.
 *
 * ## Clocks (root rule 7, the plan's aviso row)
 *
 * Every raise is clocked by its job's END (`relogioEvento`, µs through `avisos/avisos.ts`'s one
 * converter, {@link relogioDaImportacaoUs}): jobs of one conta run one at a time, so a later job's
 * end is later, and `escreverAviso` drops a raise whose clock is not newer — an older job can never
 * reopen a newer job's row. The summary and the tax-review resolves are clocked by the same end,
 * with a complete seed (a resolve that finds no row records the closed observation, so a late raise
 * from an older job is still dropped). The category resolve runs at a job's START (its catalogue
 * phase), on rows it found OPEN, and is clockless: it keeps the raising job's clock, so the same
 * job's own later raise — or any newer job's — still reopens the row.
 *
 * ## The category resolve's read (root rule 1)
 *
 * The open avisos, `resolvidoEm == null` ordered by `criadoEm desc` — the declared
 * `(resolvidoEm ASC, criadoEm DESC)` composite the expiry sweep's orphan pass rides — at most
 * {@link MAX_PAGINAS_AVISOS_CATEGORIA_LI} pages of {@link PAGINA_AVISOS_CATEGORIA_LI}; the canal, the
 * tipo and the conta's key prefix filtered in code (no index can express them). A row is matched to
 * a store category by RECOMPUTING that category's key, never by splitting the row's id.
 *
 * Next-free; `db` is a parameter. No ms → µs conversion here.
 */
import type { Firestore, QuerySnapshot, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import { avisoCollection } from '@delfrance/data/admin/collections';
import {
  ALVO_IMPORTACAO_LI,
  type AlvoImportacaoLi,
  CANAL_AVISO,
  type CategoriaDoJobLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  type MotivoCategoriaSemVinculoLi,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  STATUS_IMPORTACAO_LI,
  type StatusImportacaoLi,
  TIPO_AVISO,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  chaveDeAviso,
} from '@delfrance/schemas';

import {
  type AvisoDepsLi,
  agoraUsDe,
  chaveImportacaoComPendenciasLi,
  chaveRevisaoFiscalLi,
  prefixoDaContaNoAvisoLi,
  prefixoDoAvisoPorEntidadeLi,
  relogioDaImportacaoUs,
} from '../avisos/avisos';
import type { ContagemAcionavelLi } from './relatorio';

/** Open avisos read per page by the category resolve (the expiry sweep's page). */
export const PAGINA_AVISOS_CATEGORIA_LI = 200;
/** Pages the category resolve reads at most (the expiry sweep's ceiling). */
export const MAX_PAGINAS_AVISOS_CATEGORIA_LI = 5;

/** What one call did. */
export type ResultadoAvisoImportacaoLi = 'simulacao' | 'avisado' | 'resolvido' | 'mantido';

/** Named members of {@link ResultadoAvisoImportacaoLi}. */
export const RESULTADO_AVISO_IMPORTACAO_LI = {
  /** A Simular job: nothing read, nothing written. */
  simulacao: 'simulacao',
  avisado: 'avisado',
  resolvido: 'resolvido',
  /** Neither raised nor resolved (a narrower target, or a job that did not finish clean). */
  mantido: 'mantido',
} as const satisfies Record<string, ResultadoAvisoImportacaoLi>;

/** The motivos every machine resolution of these tipos is stamped with. */
export const MOTIVO_RESOLUCAO_IMPORTACAO_LI = {
  /** An `alvo: todos` job ended `concluido` with no actionable pendência. */
  semPendencias: 'importacao-sem-pendencias',
  /** The store category is now linked for the conta. */
  categoriaVinculada: 'categoria-vinculada',
  /** The store category is no longer in the store's list. */
  categoriaForaDaLoja: 'categoria-fora-da-loja',
  /** The tax-review list is empty. */
  revisaoConcluida: 'revisao-concluida',
} as const;

/** The job an aviso call is about. */
export interface JobDoAvisoLi {
  readonly jobId: string;
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  readonly modo: ModoImportacaoLi;
}

function urlInterna(integracaoId: string): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.canalLojaIntegrada.build(integracaoId), campo: null };
}

function depsDeEscrita(deps: AvisoDepsLi) {
  return { increment: deps.increment, agoraUs: agoraUsDe(deps), logger: deps.logger };
}

const simulando = (job: { readonly modo: ModoImportacaoLi }): boolean =>
  job.modo === MODO_IMPORTACAO_LI.simular;

/* -------------------------------------------------------------------------- */
/*                                  The summary                                */
/* -------------------------------------------------------------------------- */

/** How an `aplicar` job ended, for the summary aviso. */
export interface FimDoJobLi extends JobDoAvisoLi {
  readonly alvo: AlvoImportacaoLi;
  readonly status: StatusImportacaoLi;
  /** ms — the job's end (`concluidoEmMs`): the aviso's clock. */
  readonly fimMs: number;
}

/**
 * The summary aviso at a job's END (module header): raised when the job left at least one
 * actionable pendência; resolved only by a clean `alvo: todos` job that ended `concluido`.
 * `contagem` is `contarPendenciasAcionaveisLi` over the job's own items.
 */
export async function sincronizarAvisoDePendenciasLi(
  db: Firestore,
  fim: FimDoJobLi,
  contagem: ContagemAcionavelLi,
  deps: AvisoDepsLi,
): Promise<ResultadoAvisoImportacaoLi> {
  if (simulando(fim)) return RESULTADO_AVISO_IMPORTACAO_LI.simulacao;
  const relogioEvento = relogioDaImportacaoUs(fim.fimMs);
  const base = {
    tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
    conta: fim.integracaoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    urlInterna: urlInterna(fim.integracaoId),
  };

  if (contagem.total > 0) {
    const porCodigo: Record<string, number> = {};
    for (const [codigo, n] of Object.entries(contagem.porCodigo)) {
      if (typeof n === 'number' && n > 0) porCodigo[codigo] = n;
    }
    await escreverAviso(
      db,
      {
        ...base,
        // Structured params, never a sentence: the web renders the codes.
        params: { ...porCodigo, loja: fim.lojaNome, acionaveis: contagem.total, job: fim.jobId },
        relogioEvento,
      },
      depsDeEscrita(deps),
    );
    return RESULTADO_AVISO_IMPORTACAO_LI.avisado;
  }

  if (fim.alvo !== ALVO_IMPORTACAO_LI.todos || fim.status !== STATUS_IMPORTACAO_LI.concluido) {
    return RESULTADO_AVISO_IMPORTACAO_LI.mantido;
  }
  await resolverAviso(
    db,
    chaveImportacaoComPendenciasLi(fim.integracaoId),
    MOTIVO_RESOLUCAO_IMPORTACAO_LI.semPendencias,
    { agoraUs: agoraUsDe(deps) },
    { ...base, params: { loja: fim.lojaNome, job: fim.jobId }, relogioEvento },
  );
  return RESULTADO_AVISO_IMPORTACAO_LI.resolvido;
}

/* -------------------------------------------------------------------------- */
/*                               The category aviso                            */
/* -------------------------------------------------------------------------- */

/** The key of store category `categoriaLiId`'s row for conta `integracaoId`. */
export function chaveCategoriaSemVinculoLi(integracaoId: string, categoriaLiId: number): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
    conta: integracaoId,
    entidade: String(categoriaLiId),
  });
}

/** One store category that left imported products without a category. */
export interface CategoriaSemVinculoLi {
  readonly categoriaLiId: number;
  /** The category's path as store ids, root first. */
  readonly caminho: readonly number[];
  /** The products imported without it by this job. */
  readonly produtos: number;
  readonly motivo: MotivoCategoriaSemVinculoLi;
}

/**
 * Raise (or refresh) one store category's row at an `aplicar` job's END — the complete step's
 * call (module header). Never for a category the store's list does not hold: the caller passes
 * only refused chains and unlinked categories of the list.
 */
export async function avisarCategoriaSemVinculoLi(
  db: Firestore,
  fim: JobDoAvisoLi & { readonly fimMs: number },
  categoria: CategoriaSemVinculoLi,
  deps: AvisoDepsLi,
): Promise<ResultadoAvisoImportacaoLi> {
  if (simulando(fim)) return RESULTADO_AVISO_IMPORTACAO_LI.simulacao;
  await escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
      conta: fim.integracaoId,
      entidade: String(categoria.categoriaLiId),
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: fim.lojaNome,
        caminho: categoria.caminho.map((id) => String(id)).join(' > '),
        produtos: categoria.produtos,
        motivo: categoria.motivo,
      },
      urlInterna: urlInterna(fim.integracaoId),
      relogioEvento: relogioDaImportacaoUs(fim.fimMs),
    },
    depsDeEscrita(deps),
  );
  return RESULTADO_AVISO_IMPORTACAO_LI.avisado;
}

/** What the category resolve read and closed. */
export interface ResolucaoDasCategoriasLi {
  readonly lidos: number;
  readonly paginas: number;
  /** A full last page: older open rows may remain beyond the ceiling. */
  readonly truncado: boolean;
  readonly resolvidos: number;
}

/**
 * Close this conta's open category rows whose category is now linked, or gone from the store's
 * list (module header) — an `aplicar` job's catalogue phase, with its finished category map.
 */
export async function resolverCategoriasSemVinculoLi(
  db: Firestore,
  job: Pick<JobDoAvisoLi, 'integracaoId' | 'modo'>,
  mapa: readonly Pick<CategoriaDoJobLi, 'id' | 'vinculo'>[],
  deps: Pick<AvisoDepsLi, 'nowMs'>,
): Promise<ResolucaoDasCategoriasLi | typeof RESULTADO_AVISO_IMPORTACAO_LI.simulacao> {
  if (simulando(job)) return RESULTADO_AVISO_IMPORTACAO_LI.simulacao;
  const tipo = TIPO_AVISO.lojaIntegradaCategoriaSemVinculo;
  const prefixo = prefixoDaContaNoAvisoLi(tipo, job.integracaoId);
  const vinculadas = new Set<string>();
  const daLoja = new Set<string>();
  for (const c of mapa) {
    const chave = chaveCategoriaSemVinculoLi(job.integracaoId, c.id);
    daLoja.add(chave);
    if (c.vinculo === VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada) vinculadas.add(chave);
  }

  let lidos = 0;
  let paginas = 0;
  let truncado = false;
  let resolvidos = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  while (paginas < MAX_PAGINAS_AVISOS_CATEGORIA_LI) {
    const base = avisoCollection
      .ref(db, {})
      .where('resolvidoEm', '==', null)
      .orderBy('criadoEm', 'desc')
      .limit(PAGINA_AVISOS_CATEGORIA_LI);
    const snap: QuerySnapshot = await (cursor === null ? base : base.startAfter(cursor)).get();
    paginas += 1;
    lidos += snap.docs.length;
    for (const doc of snap.docs) {
      const row = doc.data() as Record<string, unknown> | undefined;
      if (row?.canal !== CANAL_AVISO.lojaIntegrada || row.tipo !== tipo) continue;
      if (prefixoDoAvisoPorEntidadeLi(tipo, doc.id) !== prefixo) continue;
      const motivo = vinculadas.has(doc.id)
        ? MOTIVO_RESOLUCAO_IMPORTACAO_LI.categoriaVinculada
        : daLoja.has(doc.id)
          ? null
          : MOTIVO_RESOLUCAO_IMPORTACAO_LI.categoriaForaDaLoja;
      if (motivo === null) continue;
      if (await resolverAviso(db, doc.id, motivo, { agoraUs: agoraUsDe(deps) })) resolvidos += 1;
    }
    const ultimo: QueryDocumentSnapshot | undefined = snap.docs.at(-1);
    if (snap.docs.length < PAGINA_AVISOS_CATEGORIA_LI || ultimo === undefined) break;
    cursor = ultimo;
    if (paginas === MAX_PAGINAS_AVISOS_CATEGORIA_LI) truncado = true;
  }
  return { lidos, paginas, truncado, resolvidos };
}

/* -------------------------------------------------------------------------- */
/*                               The tax-review aviso                          */
/* -------------------------------------------------------------------------- */

/** The tax-review list at an `aplicar` job's END. */
export interface RevisaoDoJobLi extends JobDoAvisoLi {
  /** ms — the job's end: the aviso's clock. */
  readonly fimMs: number;
  /** The produtos still on the list after this job's re-check. */
  readonly abertos: number;
}

/**
 * The tax-review aviso at an `aplicar` job's END — the complete step's call (module header):
 * raised while the list has entries (the newest job's id names the list the web shows), resolved
 * when it is empty.
 */
export async function sincronizarAvisoDeRevisaoFiscalLi(
  db: Firestore,
  revisao: RevisaoDoJobLi,
  deps: AvisoDepsLi,
): Promise<ResultadoAvisoImportacaoLi> {
  if (simulando(revisao)) return RESULTADO_AVISO_IMPORTACAO_LI.simulacao;
  const relogioEvento = relogioDaImportacaoUs(revisao.fimMs);
  const base = {
    tipo: TIPO_AVISO.lojaIntegradaRevisaoFiscal,
    conta: revisao.integracaoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    urlInterna: urlInterna(revisao.integracaoId),
  };
  if (revisao.abertos > 0) {
    await escreverAviso(
      db,
      {
        ...base,
        params: { loja: revisao.lojaNome, abertos: revisao.abertos, job: revisao.jobId },
        relogioEvento,
      },
      depsDeEscrita(deps),
    );
    return RESULTADO_AVISO_IMPORTACAO_LI.avisado;
  }
  await resolverAviso(
    db,
    chaveRevisaoFiscalLi(revisao.integracaoId),
    MOTIVO_RESOLUCAO_IMPORTACAO_LI.revisaoConcluida,
    { agoraUs: agoraUsDe(deps) },
    { ...base, params: { loja: revisao.lojaNome, abertos: 0, job: revisao.jobId }, relogioEvento },
  );
  return RESULTADO_AVISO_IMPORTACAO_LI.resolvido;
}
