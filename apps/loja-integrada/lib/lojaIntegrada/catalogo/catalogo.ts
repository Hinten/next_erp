/**
 * The catalogue core (master plan step 10, #1821): what the four read-only routes
 * `GET …/conta/[id]/{categorias,marcas,grades,grades/[gradeId]}` answer — the store's category,
 * brand and grade lists, and one grade with its options, for the web's variation linker (and,
 * from step 11, its product tab).
 *
 * The wire contract (the answers, the projections and their URI reader, `mesmaGradeLi`) is
 * `packages/schemas/src/catalogoLojaIntegrada.ts`, shared with the web; the reads are the
 * package's `catalogo.ts`. This module only orders them, and folds nothing of its own: the one
 * sameness decision it makes (is this detail the grade asked for?) is `mesmaGradeLi`, applied
 * verbatim.
 *
 * ## The order — the context FIRST; nothing reaches Loja Integrada before the switch
 *
 *  1. the context loader (`core/contexto.ts`), whose first act is the read switch: off ⇒ no
 *     Firestore read, no client, no call (D17). Then the conta (cached), ONE credential read (its
 *     version is the cache key's) and a paced client. A cache hit therefore still costs the
 *     cached conta read and one credential read, and saves every paced Loja Integrada call;
 *  2. the key `[conta, credential version, resource, grade]` (`cache.ts`);
 *  3. `atualizar` (the route's exact `?atualizar=1`) evicts the SETTLED copy only: a load already
 *     in flight is joined, never doubled;
 *  4. the shared load, raced against the caller's abort. The load reads through the package with
 *     NO caller signal — the cache shares one in-flight load between concurrent callers, so a load
 *     bound to the first caller's signal would reject for every other waiter once that tab closed.
 *     Each call stays bounded by the package's own deadline, and each list by
 *     `MAX_PAGINAS_CATALOGO_LI` pages. Then the projection, then, for a grade, the identity check
 *     (`mesmaGradeLi`), then the version check (below);
 *  5. the caller gone ⇒ `cancelado` (499), while the load carries on for anyone else waiting.
 *
 * ## The credential version is re-checked at the end of the load
 *
 * The client re-reads the credential before every paced request, and the context reports each
 * request's VERSION (`aoUsarCredencial`, never the ref). A token saved between two pages would
 * otherwise put pages read with the NEW token under the OLD version's key — the cross-store mix
 * the key exists to prevent. So a load that saw any version other than its key's fails with
 * {@link LiCredencialTrocadaNaLeituraError}: never cached, answered 502 `lojaIndisponivel` with
 * one WARN line, and the next request reads under the new version.
 *
 * ## The errors (root rule 6)
 *
 * Everything the package or the context throws goes through the SHARED read-failure mapper
 * (`core/falhaDeLeituraLi.ts`) under this module's choices, per resource ({@link politicaDe}); it
 * keeps the one class table, and anything it does not own is rethrown unchanged (a 500).
 *
 * | What failed | Answer |
 * | --- | --- |
 * | the switch, the conta, its credential, a park | the conta's own app errors (`respond.ts`) |
 * | 401, on any resource | the conta is parked first, then answered as the park found it |
 * | 403 on `categorias` (the path the token check itself reads) | parked, as a 401 |
 * | 403 on `marcas`, `grades`, a grade | 502 `recursoNaoPermitido` + one WARN; nothing parked |
 * | 404 on a grade | 409 `gradeAusenteNaLoja` (deleted in the painel, or another store's token) |
 * | 404 on a list | rethrown (a 500): a refusal of OUR request stays loud |
 * | more pages than the ceiling | 502 `catalogoExcedeLimite` + one WARN; never a truncated list |
 * | a `next` that does not advance, a body off the schema, a 5xx, the network | 502 `lojaIndisponivel` |
 * | the deadline | 504 `tempoEsgotadoLoja` |
 * | 429 | 503 `limiteDeChamadas` |
 * | a detail of another grade ({@link LiGradeDivergenteError}) | 502 `lojaIndisponivel` + one WARN |
 * | a token saved during the load ({@link LiCredencialTrocadaNaLeituraError}) | 502 `lojaIndisponivel` + one WARN |
 * | anything else (`LiConfigError`, a 3xx, a 400, Firestore) | rethrown (a 500) |
 *
 * A refused credential (a 401, or a 403) is answered by the SHARED load itself, once per load
 * ({@link LiRecusaTratadaNaCargaError}): the park never waits on a caller, so closing the tab
 * mid-read still parks the conta and raises its reconnection aviso.
 *
 * The CLASS the catalogue's own answers carry (`ClasseFalhaDeLeituraLi`): a 403 not parked and a
 * grade 404 are `nao-autorizado` — the read ran, and what it asked for was refused or is not
 * there; a retry changes nothing (the paid re-check's 404 is the same class). The paging ceiling
 * is `configuracao` (only resizing it helps); the rest are the mapper's `transitorio`. The routes
 * read no mirror, so the class decides nothing here today; it is kept consistent for the web's
 * describer and for a later caller.
 *
 * Nothing that failed is ever cached: the primitive keeps no rejection, and a 404 is a failure,
 * never a value. Nothing is written except the park's own tier-1 precondition write.
 *
 * ## Log lines
 *
 * The context's call and switch lines carry `fluxo: catalogo` ({@link FLUXO_CATALOGO_LI}). This
 * module's own WARN lines are prefixed `[loja-integrada/catalogo]` and carry the conta, the
 * resource, the grade id and a cause or the projection's counters — ids and counts only, never a
 * name: once per LOAD for rows the projection could not read, once per REQUEST for an answer of
 * this module's own codes.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write call — not even in
 * a comment (`estrutura.test.ts`). Next-free, `db` a parameter, no process environment: the route
 * passes it in (`deps.ambiente`). `prazos.test.ts` counts this file's context loads and package
 * reads: one of each.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type LiLeituraClient,
  buscarGradeLi,
  LiAuthError,
  listarCategoriasLi,
  listarGradesLi,
  listarMarcasLi,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAGINAS_CATALOGO_LI,
  mesmaGradeLi,
  projetarCategoriasLi,
  projetarGradeLi,
  projetarGradesLi,
  projetarMarcasLi,
} from '@delfrance/schemas';

import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import type { TratarFalhaDeps } from '../core/estacionamento';
import {
  type FalhaDeLeituraLi,
  type PoliticaDeFalhaLi,
  falhaDaLojaLi,
  tratarFalhaDeLeituraLi,
} from '../core/falhaDeLeituraLi';
import type { EscritorLogLi } from '../core/log';
import type { RitmoLi } from '../core/ritmo';
import type { AmbienteLi } from '../core/valvulas';
import {
  CACHES_DO_CATALOGO_LI,
  type ChaveCatalogoLi,
  type RecursoCatalogoLi,
  type RespostasCatalogoLi,
  SEM_VERSAO_CATALOGO_LI,
  chaveDoCatalogoLi,
} from './cache';

/** The flow every call and switch line of a catalogue read carries (`jsonPayload.fluxo`). */
export const FLUXO_CATALOGO_LI = 'catalogo';

/** This module's own WARN lines. */
const LOG = '[loja-integrada/catalogo]';

export interface CatalogoDeps extends TratarFalhaDeps {
  readonly db: Firestore;
  /** The process environment, from the route — read by the context loader for the switch only. */
  readonly ambiente: AmbienteLi;
  /** The pacer (`core/ritmo.ts`): the wait before every request. */
  readonly ritmo: RitmoLi;
  /**
   * The caller's cancellation (the request's own signal). It ends THIS caller's wait only: the
   * shared load never takes it (module header, step 4).
   */
  readonly sinal?: AbortSignal;
  /** Test seam, forwarded to the context's client. Production passes nothing. */
  readonly fetch?: typeof globalThis.fetch;
  /** Test sink for the call and switch lines; production writes them to stdout. */
  readonly escrever?: EscritorLogLi;
}

/** What one request asks for: a list, or one grade by its canonical id (`gradeIdDaRotaLi`). */
export type PedidoCatalogoLi<R extends RecursoCatalogoLi = RecursoCatalogoLi> = {
  readonly recurso: R;
} & (R extends 'grade' ? { readonly gradeId: string } : unknown);

export interface OpcoesCatalogoLi {
  /** The route's exact `?atualizar=1` ({@link pedeAtualizacaoLi}): evict the settled copy. */
  readonly atualizar: boolean;
}

/** How one request ended. */
export type ResultadoCatalogoLi<T> =
  /** The 200 answer, as the cache holds it (shared by reference: never mutate it). */
  | { readonly tipo: 'resposta'; readonly resposta: T }
  /** No answer: the error envelope. */
  | { readonly tipo: 'falha'; readonly falha: FalhaDeLeituraLi }
  /** The caller went away (499). */
  | { readonly tipo: 'cancelado' };

/**
 * A load saw a credential version other than its key's: a token was saved while it read (module
 * header). Never cached; answered 502 `lojaIndisponivel`.
 */
export class LiCredencialTrocadaNaLeituraError extends Error {
  readonly recurso: RecursoCatalogoLi;

  constructor(recurso: RecursoCatalogoLi) {
    super(`A credencial da conta foi trocada durante a leitura do catálogo (${recurso}).`);
    this.name = 'LiCredencialTrocadaNaLeituraError';
    this.recurso = recurso;
  }
}

/**
 * The store answered a grade detail whose `id` is not the grade asked for (`mesmaGradeLi`), or
 * one it cannot carry. Never cached; answered 502 `lojaIndisponivel`.
 */
export class LiGradeDivergenteError extends Error {
  constructor() {
    super('A Loja Integrada respondeu outra grade.');
    this.name = 'LiGradeDivergenteError';
  }
}

/**
 * The store refused the load's credential (a 401, or a 403), and the SHARED load already answered
 * it through the mapper: parked the conta where this resource parks, once per load. Carries that
 * answer to every waiter. Never cached (the cache keeps no failure).
 */
export class LiRecusaTratadaNaCargaError extends Error {
  readonly falha: FalhaDeLeituraLi;

  constructor(falha: FalhaDeLeituraLi) {
    super('A Loja Integrada recusou a credencial durante a leitura do catálogo.');
    this.name = 'LiRecusaTratadaNaCargaError';
    this.falha = falha;
  }
}

/**
 * Whether the request asks for a fresh read: exactly ONE `atualizar` parameter whose value is
 * exactly `1`. `true`, `01`, an empty value, a repeated key or another case is not a refresh.
 */
export function pedeAtualizacaoLi(url: string): boolean {
  const valores = new URL(url).searchParams.getAll('atualizar');
  return valores.length === 1 && valores[0] === '1';
}

/* -------------------------------------------------------------------------- */
/*                         The choices for the shared mapper                    */
/* -------------------------------------------------------------------------- */

const RECURSO_NAO_PERMITIDO = falhaDaLojaLi(
  'nao-autorizado',
  502,
  CODIGO_ERRO_LI.recursoNaoPermitido,
  'A Loja Integrada não permitiu esta leitura com o token da conta. Nada foi alterado na conta.',
);

const GRADE_AUSENTE = falhaDaLojaLi(
  'nao-autorizado',
  409,
  CODIGO_ERRO_LI.gradeAusenteNaLoja,
  'A Loja Integrada não encontrou esta grade. Ela pode ter sido removida, ou o token da conta é ' +
    'de outra loja.',
);

/** A list's paging stops: the ceiling refuses the whole list; a stuck `next` is an outage. */
const PAGINACAO_DO_CATALOGO: NonNullable<PoliticaDeFalhaLi['paginacao']> = {
  'limite-de-paginas': falhaDaLojaLi(
    'configuracao',
    502,
    CODIGO_ERRO_LI.catalogoExcedeLimite,
    'A lista da Loja Integrada tem mais páginas do que esta leitura aceita. Nada foi truncado.',
  ),
  'offset-nao-avanca': falhaDaLojaLi(
    'transitorio',
    502,
    CODIGO_ERRO_LI.lojaIndisponivel,
    'A Loja Integrada respondeu uma paginação que não avança. Tente de novo em instantes.',
  ),
};

/**
 * Each resource's choices (module header, "The errors"): a 404 on a list is not ours to answer; a
 * 403 parks only on the category list; a grade detail never pages.
 */
function politicaDe(recurso: RecursoCatalogoLi): PoliticaDeFalhaLi {
  switch (recurso) {
    case 'categorias':
      return { ausente: null, proibido: 'estacionar', paginacao: PAGINACAO_DO_CATALOGO };
    case 'marcas':
    case 'grades':
      return { ausente: null, proibido: RECURSO_NAO_PERMITIDO, paginacao: PAGINACAO_DO_CATALOGO };
    case 'grade':
      return { ausente: GRADE_AUSENTE, proibido: RECURSO_NAO_PERMITIDO };
  }
}

/** The answer of both in-repo errors: the load could not be trusted, so nothing was kept. */
const LEITURA_NAO_CONFIAVEL = falhaDaLojaLi(
  'transitorio',
  502,
  CODIGO_ERRO_LI.lojaIndisponivel,
  'A leitura da Loja Integrada não pôde ser confirmada. Nada foi guardado; tente de novo.',
);

/** The codes of this module's own answers that log one WARN line per request. */
const CODIGOS_COM_AVISO: ReadonlySet<string> = new Set([
  CODIGO_ERRO_LI.recursoNaoPermitido,
  CODIGO_ERRO_LI.catalogoExcedeLimite,
]);

/* -------------------------------------------------------------------------- */
/*                                  The reads                                  */
/* -------------------------------------------------------------------------- */

/** What one load produced: the answer, and what the projection could not read. */
interface CargaCatalogoLi<V> {
  readonly valor: V;
  readonly naoLidas: Readonly<Record<string, number>>;
}

/** One resource's read: the package GET, the projection, and the answer stamped `lidaEmMs`. */
type CarregadorCatalogoLi<R extends RecursoCatalogoLi> = (
  cliente: LiLeituraClient,
  pedido: PedidoCatalogoLi<R>,
  lidaEmMs: () => number,
) => Promise<CargaCatalogoLi<RespostasCatalogoLi[R]>>;

const OPCOES_DA_LISTA = {
  limite: LIMITE_PAGINA_CATALOGO_LI,
  maxPaginas: MAX_PAGINAS_CATALOGO_LI,
} as const;

/** The four reads, one package GET each; none takes the caller's signal (module header). */
const CARREGADORES: { readonly [R in RecursoCatalogoLi]: CarregadorCatalogoLi<R> } = {
  categorias: async (cliente, _pedido, lidaEmMs) => {
    const lista = await listarCategoriasLi(cliente, OPCOES_DA_LISTA);
    const { categorias, paisIlegiveis, linhasSemId } = projetarCategoriasLi(lista.linhas);
    return {
      valor: { categorias, lidaEmMs: lidaEmMs() },
      naoLidas: { paisIlegiveis, linhasSemId },
    };
  },
  marcas: async (cliente, _pedido, lidaEmMs) => {
    const lista = await listarMarcasLi(cliente, OPCOES_DA_LISTA);
    const { marcas, linhasSemId } = projetarMarcasLi(lista.linhas);
    return { valor: { marcas, lidaEmMs: lidaEmMs() }, naoLidas: { linhasSemId } };
  },
  grades: async (cliente, _pedido, lidaEmMs) => {
    const lista = await listarGradesLi(cliente, OPCOES_DA_LISTA);
    const { grades, linhasSemId } = projetarGradesLi(lista.linhas);
    return { valor: { grades, lidaEmMs: lidaEmMs() }, naoLidas: { linhasSemId } };
  },
  grade: async (cliente, pedido, lidaEmMs) => {
    const lida = await buscarGradeLi(cliente, pedido.gradeId);
    // The identity BEFORE the projection: a detail of another grade is never answered.
    if (!mesmaGradeLi(lida.dados.id, pedido.gradeId)) throw new LiGradeDivergenteError();
    const projecao = projetarGradeLi(lida.dados);
    if (projecao === null) throw new LiGradeDivergenteError();
    const { grade, opcoes, opcoesDeOutraGrade, opcoesComGradeIlegivel, linhasSemId } = projecao;
    return {
      valor: { grade, opcoes, lidaEmMs: lidaEmMs() },
      naoLidas: { opcoesDeOutraGrade, opcoesComGradeIlegivel, linhasSemId },
    };
  },
};

/** The grade id a pedido names, or `null` for a list. */
function gradeIdDe(pedido: PedidoCatalogoLi): string | null {
  return 'gradeId' in pedido && typeof pedido.gradeId === 'string' ? pedido.gradeId : null;
}

/**
 * `promessa`, or the caller's abort reason as soon as the caller goes away — whichever comes
 * first. The promise itself carries on (other waiters share it), and its later settlement is
 * absorbed here, never an unhandled rejection.
 */
function ateOChamadorDesistir<V>(promessa: Promise<V>, sinal: AbortSignal | undefined): Promise<V> {
  if (sinal === undefined) return promessa;
  return new Promise<V>((resolve, reject) => {
    const desistiu = (): void => {
      reject(sinal.reason);
    };
    sinal.addEventListener('abort', desistiu, { once: true });
    promessa.then(
      (valor) => {
        sinal.removeEventListener('abort', desistiu);
        resolve(valor);
      },
      (err: unknown) => {
        sinal.removeEventListener('abort', desistiu);
        reject(err);
      },
    );
  });
}

/**
 * The shared load's own handling of a refused credential. A park must not depend on a caller
 * still waiting: when every caller has gone away (499), their abort race absorbs the load's
 * rejection, so a park left to the waiters would never run, and the conta would stay unparked
 * with no reconnection aviso. So the load itself answers a `LiAuthError` through the mapper
 * (parking where this resource parks, once per load, not once per waiter) and hands that answer
 * on as {@link LiRecusaTratadaNaCargaError}. Anything else is rethrown unchanged, for each waiter
 * to answer.
 */
async function comRecusaTratadaNaCarga<V>(
  carga: Promise<V>,
  deps: CatalogoDeps,
  contexto: ContextoLojaIntegrada,
  recurso: RecursoCatalogoLi,
): Promise<V> {
  try {
    return await carga;
  } catch (err) {
    if (!(err instanceof LiAuthError)) throw err;
    const semResposta = await tratarFalhaDeLeituraLi(deps, err, contexto, politicaDe(recurso));
    if (semResposta.tipo === 'alheia') throw semResposta.erro;
    throw new LiRecusaTratadaNaCargaError(semResposta.falha);
  }
}

/**
 * Read one catalogue resource of one conta (module header). Everything it cannot answer is
 * rethrown unchanged: a Firestore failure, our own misconfiguration, a refusal of our request, a
 * 404 on a list.
 */
export async function lerCatalogoLi<R extends RecursoCatalogoLi>(
  deps: CatalogoDeps,
  contaId: string,
  pedido: PedidoCatalogoLi<R>,
  opcoes: OpcoesCatalogoLi,
): Promise<ResultadoCatalogoLi<RespostasCatalogoLi[R]>> {
  const recurso: R = pedido.recurso;
  const gradeId = gradeIdDe(pedido);
  const linha = { conta: contaId, recurso, gradeId };
  // The version of each request THIS request's client makes (module header): only the load this
  // request starts uses that client, so these are exactly that load's versions.
  const vistas: (string | null)[] = [];

  let contexto: ContextoLojaIntegrada | null = null;
  try {
    // 1. The context: the switch first, then the conta and ONE credential read.
    contexto = await loadLojaIntegradaContext(deps.db, contaId, {
      ambiente: deps.ambiente,
      ritmo: deps.ritmo,
      registro: {
        fluxo: FLUXO_CATALOGO_LI,
        tentativa: null,
        ...(deps.escrever === undefined ? {} : { escrever: deps.escrever }),
      },
      aoUsarCredencial: (versao) => {
        vistas.push(versao);
      },
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });

    // 2-3. The key, and a settled-only eviction.
    const versaoDaChave = contexto.versaoCredencial ?? SEM_VERSAO_CATALOGO_LI;
    const chave: ChaveCatalogoLi = chaveDoCatalogoLi(contaId, versaoDaChave, recurso, gradeId);
    const cache = CACHES_DO_CATALOGO_LI[recurso];
    if (opcoes.atualizar) cache.invalidate(chave, () => true);
    // A caller already gone starts no load nobody would wait for.
    if (deps.sinal?.aborted === true) return { tipo: 'cancelado' };

    // 4. The shared load, raced against this caller's abort.
    const contextoDaCarga = contexto;
    const carregar = CARREGADORES[recurso];
    const resposta = await ateOChamadorDesistir(
      cache.get(chave, async () => {
        const carga = await comRecusaTratadaNaCarga(
          carregar(contextoDaCarga.cliente, pedido, deps.agoraMs),
          deps,
          contextoDaCarga,
          recurso,
        );
        if (vistas.some((v) => (v ?? SEM_VERSAO_CATALOGO_LI) !== versaoDaChave)) {
          throw new LiCredencialTrocadaNaLeituraError(recurso);
        }
        if (Object.values(carga.naoLidas).some((n) => n > 0)) {
          deps.logger?.warn(`${LOG} linhas do catálogo que não puderam ser lidas`, {
            ...linha,
            ...carga.naoLidas,
          });
        }
        return carga.valor;
      }),
      deps.sinal,
    );
    return { tipo: 'resposta', resposta };
  } catch (err) {
    // 5. The caller's own abort, by identity — anything else after it is classified below.
    if (deps.sinal?.aborted === true && err === deps.sinal.reason) return { tipo: 'cancelado' };
    if (err instanceof LiCredencialTrocadaNaLeituraError) {
      deps.logger?.warn(`${LOG} credencial trocada durante a leitura; nada foi guardado`, linha);
      return { tipo: 'falha', falha: LEITURA_NAO_CONFIAVEL };
    }
    if (err instanceof LiGradeDivergenteError) {
      deps.logger?.warn(`${LOG} a Loja Integrada respondeu outra grade; nada foi guardado`, linha);
      return { tipo: 'falha', falha: LEITURA_NAO_CONFIAVEL };
    }
    // A refused credential was answered by the shared load itself (a 401, and a 403 on the
    // category list, parked there once); anything else is the shared mapper's, under this
    // resource's choices. What it does not own is rethrown unchanged.
    let falha: FalhaDeLeituraLi;
    if (err instanceof LiRecusaTratadaNaCargaError) {
      falha = err.falha;
    } else {
      const semResposta = await tratarFalhaDeLeituraLi(deps, err, contexto, politicaDe(recurso));
      if (semResposta.tipo === 'alheia') throw semResposta.erro;
      falha = semResposta.falha;
    }
    if (falha.tipo === 'loja' && CODIGOS_COM_AVISO.has(falha.code)) {
      deps.logger?.warn(`${LOG} leitura do catálogo sem resposta`, {
        ...linha,
        causa: falha.code,
      });
    }
    return { tipo: 'falha', falha };
  }
}
