/**
 * The product import's `catalogo` PHASE (master plan step 9): the store's category and brand lists,
 * once per job, and which ERP categoria serves each store category for this conta. What the later
 * phases read a product's category and brand from (`mapaCategorias`, `marcas` on the job).
 *
 * ## One unit at a time — state in, state out
 *
 * The dispatch asks {@link unidadeDoCatalogoDoJobLi} what the next unit costs (its budget,
 * `orcamento.ts`), runs it with {@link executarUnidadeDoCatalogoDoJobLi} and checkpoints the state
 * it returns. This module writes nothing: every result is a new value of the job's own `catalogo`,
 * `mapaCategorias` and `marcas`, for the dispatch's tier-1 checkpoint (`job.ts`). A unit retried
 * before its checkpoint therefore starts again from the state checkpointed before it, and re-reads
 * the same page — the page's rows are never appended twice.
 *
 * | The job's `catalogo` cursor | The next unit | Cost |
 * | --- | --- | --- |
 * | `categorias`, an offset | one page of `GET /v1/categoria/` | one call |
 * | `marcas`, an offset (or `categorias` exhausted) | one page of `GET /v1/marca/` | one call |
 * | `marcas` exhausted | the category-link read below, then the phase is done | no call |
 *
 * Each page goes through the package's one-page reader (`lerPaginaLi`) with step 10's own path,
 * page size (`LIMITE_PAGINA_CATALOGO_LI`) and row schema, then step 10's projection — so the job and
 * the catalogue routes read the same rows the same way. The next offset is the package's,
 * validated; nothing here parses `meta.next`. A list that still has a next page after
 * `MAX_PAGINAS_CATALOGO_LI` pages ends the job `falhou` with `catalogo-excede-limite` (the catalogue
 * routes' own refusal): never a truncated map, and no page past the ceiling is ever requested. A
 * repeated row is kept as read: the category tree reads two rows of one id with two parents as a
 * refused chain, which a de-duplication here would hide.
 *
 * ## Which ERP categoria serves a store category
 *
 * The WHOLE `categorialojaintegrada` collection group is read once, unfiltered: the migrated link
 * docs carry no conta and keep the store id as TEXT, so no typed query could find them, and the
 * group is small (one doc per linked category). Each doc is judged by the shared decisions in
 * `packages/schemas/src/categoriaLojaIntegrada.ts` — whether it serves this conta, and which store
 * category it names — never by a copy here. Then, per store category, the ERP categorias its
 * serving links sit under, minus any categoria that no longer exists (one read BY ID per owner):
 *
 *  - exactly one ⇒ `vinculada`, with that `erpCategoriaId`;
 *  - two or more DIFFERENT categorias ⇒ `ambigua`: never picked;
 *  - none ⇒ `sem-vinculo`.
 *
 * Two docs under ONE categoria naming the same store category give one answer, so they are not
 * ambiguous. A doc under any other parent than a categoria is ignored and counted.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 *  - The collection group, unfiltered and unordered: every document is wanted, so no index is
 *    involved (the plan's "no index, on purpose" list).
 *  - Each owning categoria by id.
 *  - The store's lists through the context's client: switched, paced and logged there.
 *
 * ## Errors (root rule 6)
 *
 * Nothing is caught here: the package's errors (a 429, a 401, a page off its schema, a `next` that
 * does not advance) and Firestore's propagate unchanged to the dispatch, which owns what each one
 * means for the job.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free, `db` and the client are parameters.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  categoriaCollection,
  categoriaLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  CAMINHO_CATEGORIAS_LI,
  CAMINHO_MARCAS_LI,
  type LiLeituraClient,
  lerPaginaLi,
  liCategoriaSchema,
  liMarcaSchema,
} from '@delfrance/integrations-loja-integrada';
import {
  type CategoriaDoJobLi,
  type ImportacaoLojaIntegrada,
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAGINAS_CATALOGO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  RECURSO_CATALOGO_IMPORTACAO_LI,
  type RecursoCatalogoImportacaoLi,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  idCategoriaLiDoVinculo,
  projetarCategoriasLi,
  projetarMarcasLi,
  vinculoCategoriaServeAConta,
} from '@delfrance/schemas';

import { UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';

/** The operation names the context's log lines carry for the two catalogue pages. */
export const OPERACAO_PAGINA_CATEGORIAS_LI = 'lerPaginaCategorias';
export const OPERACAO_PAGINA_MARCAS_LI = 'lerPaginaMarcas';

/** What the `catalogo` phase reads and returns: the job's own three fields. */
export type EstadoCatalogoDoJobLi = Pick<
  ImportacaoLojaIntegrada,
  'catalogo' | 'mapaCategorias' | 'marcas'
>;

type CursorCatalogoLi = ImportacaoLojaIntegrada['catalogo'];

export interface CatalogoDoJobDeps {
  readonly db: Firestore;
  /** The context's client: every call is switched, paced and logged there. */
  readonly cliente: LiLeituraClient;
  /** The conta the job imports: which category links serve it. */
  readonly contaId: string;
  /** The dispatch's cancellation, handed to the package read. */
  readonly sinal?: AbortSignal;
}

/** What the category-link read found, for the dispatch's WARN line when a link was ignored. */
export interface ContagemVinculosCategoriaLi {
  readonly vinculadas: number;
  readonly ambiguas: number;
  readonly semVinculo: number;
  /** ERP categorias a serving link sits under that no longer exist (each link ignored). */
  readonly donosAusentes: number;
  /** Docs of the group under a parent that is not a categoria (ignored). */
  readonly foraDeCategorias: number;
}

/** How one unit of the phase ended. */
export type PassoCatalogoDoJobLi =
  /** One page read: `estado` carries its rows and the cursor of the next page or list. */
  | {
      readonly tipo: 'pagina';
      readonly recurso: RecursoCatalogoImportacaoLi;
      readonly estado: EstadoCatalogoDoJobLi;
      /** The projection's counters: rows it could not read (`linhasSemId`, `paisIlegiveis`). */
      readonly naoLidas: Readonly<Record<string, number>>;
      readonly correlationId: string;
    }
  /** The category links were read: `estado.mapaCategorias` carries them; the phase is done. */
  | {
      readonly tipo: 'concluido';
      readonly estado: EstadoCatalogoDoJobLi;
      readonly vinculos: ContagemVinculosCategoriaLi;
    }
  /** A list needs more pages than the ceiling: the job ends `falhou` with this motivo. */
  | {
      readonly tipo: 'falhou';
      readonly motivo: typeof MOTIVO_FALHA_IMPORTACAO_LI.catalogoExcedeLimite;
      readonly recurso: RecursoCatalogoImportacaoLi;
    };

/** The cursor as the next unit reads it: an exhausted category list goes on with the brands. */
function cursorNormalizado(cursor: CursorCatalogoLi): CursorCatalogoLi {
  if (
    cursor.recurso === RECURSO_CATALOGO_IMPORTACAO_LI.categorias &&
    cursor.proximoOffset === null
  ) {
    return { recurso: RECURSO_CATALOGO_IMPORTACAO_LI.marcas, proximoOffset: 0, paginas: 0 };
  }
  return cursor;
}

/** The cost of the phase's next unit (module header's table). Pure. */
export function unidadeDoCatalogoDoJobLi(cursor: CursorCatalogoLi): UnidadeImportacaoLi {
  return cursorNormalizado(cursor).proximoOffset === null
    ? UNIDADE_IMPORTACAO_LI.familia
    : UNIDADE_IMPORTACAO_LI.chamada;
}

/**
 * Run the phase's next unit from `estado` (the job as last checkpointed) — one page, or the
 * category-link read — and return the new state. Writes nothing (module header).
 */
export async function executarUnidadeDoCatalogoDoJobLi(
  deps: CatalogoDoJobDeps,
  estado: EstadoCatalogoDoJobLi,
): Promise<PassoCatalogoDoJobLi> {
  const cursor = cursorNormalizado(estado.catalogo);
  if (cursor.proximoOffset === null) return lerVinculosDasCategorias(deps, estado);
  return lerPaginaDoCatalogo(deps, estado, cursor.recurso, cursor.proximoOffset, cursor.paginas);
}

/** One page of the current list, its rows appended, the cursor moved to the next page or list. */
async function lerPaginaDoCatalogo(
  deps: CatalogoDoJobDeps,
  estado: EstadoCatalogoDoJobLi,
  recurso: RecursoCatalogoImportacaoLi,
  offset: number,
  paginasLidas: number,
): Promise<PassoCatalogoDoJobLi> {
  const opcoes = { offset, limite: LIMITE_PAGINA_CATALOGO_LI, sinal: deps.sinal };
  let proximoOffset: number | null;
  let correlationId: string;
  let naoLidas: Record<string, number>;
  let mapaCategorias = estado.mapaCategorias;
  let marcas = estado.marcas;

  if (recurso === RECURSO_CATALOGO_IMPORTACAO_LI.categorias) {
    const pagina = await lerPaginaLi(deps.cliente, {
      ...opcoes,
      operacao: OPERACAO_PAGINA_CATEGORIAS_LI,
      caminho: CAMINHO_CATEGORIAS_LI,
      esquema: liCategoriaSchema,
    });
    const { categorias, paisIlegiveis, linhasSemId } = projetarCategoriasLi(pagina.linhas);
    const novas: CategoriaDoJobLi[] = categorias.map((c) => ({
      ...c,
      erpCategoriaId: null,
      vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo,
    }));
    mapaCategorias = [...mapaCategorias, ...novas];
    ({ proximoOffset, correlationId } = pagina);
    naoLidas = { paisIlegiveis, linhasSemId };
  } else {
    const pagina = await lerPaginaLi(deps.cliente, {
      ...opcoes,
      operacao: OPERACAO_PAGINA_MARCAS_LI,
      caminho: CAMINHO_MARCAS_LI,
      esquema: liMarcaSchema,
    });
    const projecao = projetarMarcasLi(pagina.linhas);
    marcas = [...marcas, ...projecao.marcas];
    ({ proximoOffset, correlationId } = pagina);
    naoLidas = { linhasSemId: projecao.linhasSemId };
  }

  const paginas = paginasLidas + 1;
  // The ceiling: a list that still has a next page after it is refused whole, and its next page is
  // never requested (the package's `paginarLi` rule, applied one page at a time).
  if (proximoOffset !== null && paginas >= MAX_PAGINAS_CATALOGO_LI) {
    return { tipo: 'falhou', motivo: MOTIVO_FALHA_IMPORTACAO_LI.catalogoExcedeLimite, recurso };
  }

  const catalogo: CursorCatalogoLi = { recurso, proximoOffset, paginas };
  return {
    tipo: 'pagina',
    recurso,
    estado: { catalogo, mapaCategorias, marcas },
    naoLidas,
    correlationId,
  };
}

/** The category-link read (module header): every store category's vínculo for this conta. */
async function lerVinculosDasCategorias(
  deps: CatalogoDoJobDeps,
  estado: EstadoCatalogoDoJobLi,
): Promise<PassoCatalogoDoJobLi> {
  const idsDaLoja: ReadonlySet<number> = new Set(estado.mapaCategorias.map((c) => c.id));
  const snap = await categoriaLojaIntegradaLinkCollection.groupQuery(deps.db).get();

  const donosPorId = new Map<number, Set<string>>();
  let foraDeCategorias = 0;
  for (const doc of snap.docs) {
    const dono = doc.ref.parent.parent;
    if (dono === null || dono.path !== categoriaCollection.docPath({}, dono.id)) {
      foraDeCategorias += 1;
      continue;
    }
    const dados: unknown = doc.data();
    // The shared decisions, on the RAW stored doc: never a parse that could fold its id.
    if (!vinculoCategoriaServeAConta(dados, deps.contaId, idsDaLoja)) continue;
    const id = idCategoriaLiDoVinculo(dados);
    if (id === null || !idsDaLoja.has(id)) continue;
    const donos = donosPorId.get(id) ?? new Set<string>();
    donos.add(dono.id);
    donosPorId.set(id, donos);
  }

  // A link under a categoria that no longer exists is ignored: one read by id per owner.
  const donos = [...new Set([...donosPorId.values()].flatMap((s) => [...s]))].sort();
  const lidos = await Promise.all(
    donos.map((id) => categoriaCollection.docRef(deps.db, {}, id).get()),
  );
  const existentes = new Set(donos.filter((_, i) => lidos[i]?.exists === true));

  let vinculadas = 0;
  let ambiguas = 0;
  let semVinculo = 0;
  const mapaCategorias = estado.mapaCategorias.map((c): CategoriaDoJobLi => {
    const vivos = [...(donosPorId.get(c.id) ?? [])].filter((d) => existentes.has(d));
    const [unico] = vivos;
    if (vivos.length === 1 && unico !== undefined) {
      vinculadas += 1;
      return { ...c, erpCategoriaId: unico, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada };
    }
    if (vivos.length > 1) {
      ambiguas += 1;
      return { ...c, erpCategoriaId: null, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.ambigua };
    }
    semVinculo += 1;
    return { ...c, erpCategoriaId: null, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo };
  });

  return {
    tipo: 'concluido',
    estado: { ...estado, mapaCategorias },
    vinculos: {
      vinculadas,
      ambiguas,
      semVinculo,
      donosAusentes: donos.length - existentes.size,
      foraDeCategorias,
    },
  };
}
