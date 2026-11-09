/**
 * The product import's CATEGORY of one product (master plan step 9, "complete"): from the store
 * product's `categorias` URIs and the job's category map (`mapaCategorias`, the `catalogo` phase's
 * result), which ERP categoria the produto gets — or why it gets none — creating and linking the
 * store categories the ERP lacks when the job's option says so (`criarEVincular`).
 *
 * ## State in, state out
 *
 * {@link resolverCategoriaDoProdutoLi} takes the job's map as last checkpointed and returns the
 * product's category AND the new map, which the dispatch checkpoints with the unit. A category this
 * call creates (or, under Simular, would create) is recorded in the map, so a LATER product of the
 * same job resolves to it exactly as under `aplicar`:
 *  - `aplicar`: the entry becomes `vinculada`, with the created categoria's id;
 *  - Simular: the entry becomes `simulada`, with the id `aplicar` would have created. Nothing is
 *    written; a `simulada` entry counts as linked for every later product of the job.
 * A unit retried before its checkpoint starts again from the old map: every write below is tier 0
 * at a deterministic id, so the retry meets its own documents and adopts them.
 *
 * ## The product's leaf
 *
 * `folhaDoProdutoLi` (the shared linked-leaf rule) over the tree of the map (`arvoreCategoriasLi`),
 * a store category counting as LINKED when its map entry is `vinculada`, `simulada` — or `ambigua`:
 * two ERP categorias already claim that store category, so it can neither be skipped for another
 * leaf nor picked (fail closed). Then:
 *  - no category at all ⇒ `nenhuma` (the store gives none; nothing to report);
 *  - an unreadable URI or a leaf ON a parent cycle ⇒ `categoria-recusada`; two candidate leaves ⇒
 *    `categoria-ambigua`;
 *  - the leaf linked ⇒ its ERP categoria, with ZERO reads and writes (the common case);
 *  - the leaf `ambigua` ⇒ `categoria-ambigua`, never a pick;
 *  - the leaf UNLINKED, under `soVincular` ⇒ `categoria-sem-vinculo` (the per-category aviso's
 *    material is returned, the caller raises it at the job's end); a leaf the store's list does not
 *    hold ⇒ `categoria-recusada` (motivo `ausente`) and no aviso, under either option;
 *  - the leaf UNLINKED, under `criarEVincular` ⇒ the create below, or the refusal it ends in.
 *
 * ## Create and link (root rule 7, the plan's row 6)
 *
 * The leaf's chain (`cadeia`) must read whole — an unreadable or missing parent, a cycle, a chain
 * too deep ⇒ `categoria-recusada` with that motivo (and the per-category aviso), never a root,
 * never a flat tree. Then, walking UP from the leaf, the nearest ancestor that is linked (or
 * `simulada`) is the ERP parent; an `ambigua` one there ⇒ `categoria-ambigua`. Every unlinked
 * category BELOW that parent is created, ROOT-MOST FIRST, each under the one just created (the
 * leaf last). An unlinked category ABOVE a linked ancestor is not created: no product of this call
 * sits in it, and the linked ancestor's own ERP parent is the operator's choice. With no linked
 * ancestor at all, the chain's root is created as an ERP root.
 *
 * Each created category is TWO documents, each a tier-0 `create()` at a deterministic id:
 *  - `categorias/li-<contaId>-<store id>` ({@link idCategoriaCriadaLi}): `nome` (the store's,
 *    verbatim), `nomeCompleto` = `makeNomeCompleto(nome, <the ERP PARENT's own breadcrumb>)`
 *    (`parentBreadcrumbFromDoc` of the parent as STORED: a category under a linked parent of
 *    another name reads like one made by hand — the store's names joined are never written),
 *    `categoriaPaiOuterRef` = `documents/categorias/<parent>` or `null` for a root, the schema's
 *    defaults (`permiteCadastro`, `categoriaGoogleId`) and the job's ms clock on `timestamp` and
 *    `ultimaModificacao`;
 *  - its link `categorias/<that id>/categorialojaintegrada/<contaId>-<store id>`
 *    ({@link idVinculoCategoriaCriadoLi}): `{ id: <store id as TEXT>, nome,
 *    contaLojaIntegrada: documents/integracao/<contaId> }` — the shape the catalogue phase reads.
 * The conta is in both ids, so two contas' runs create two categorias for one store name (one per
 * store, as the owner was told), and a run never adopts another conta's document.
 *
 * `ALREADY_EXISTS` (6) is the arbiter: the document now at our id is re-read and JUDGED before it
 * is adopted —
 *  - the categoria: adopted when it parses as a categoria (its stored breadcrumb, not ours, is what
 *    its children then take); otherwise `dado-invalido`, naming its fields (`categoria.<campo>`);
 *  - the link: adopted when it names this store category for this conta (`idCategoriaLiDoVinculo`,
 *    `vinculoCategoriaServeAConta`, the catalogue phase's own readers); otherwise
 *    `categoria-ambigua` — the store category's link can no longer be told apart;
 *  - a document gone between the 6 and its re-read ⇒ the create is tried once more, then
 *    `conflito-de-escrita`.
 * Under Simular the same documents are READ instead of created, and judged the same way, so a run
 * that would adopt says so. The categoria and its link are two writes, not one batch: a categoria
 * left without its link (an instance killed between them) is adopted by the next attempt, which
 * then creates the link.
 *
 * Every planned document is `safeParse`d through its schema first: a failure (an empty store name,
 * a name over 255, a breadcrumb over 2,000) is `dado-invalido` with the field names, never a throw,
 * and nothing of that category or below it is written.
 *
 * ⚠️ Accepted residual: another writer linking the same store category for this conta at ANOTHER
 * doc id between the catalogue phase's read and this create leaves two links; the next run's
 * catalogue phase reads the category `ambigua` and refuses it until a person removes one.
 *
 * ## A linked parent that is gone
 *
 * The ERP parent is read by id (its breadcrumb). One that no longer exists means its link is
 * ignored — the catalogue phase's own rule, met late: the map entry becomes `sem-vinculo` and the
 * walk is decided again from the next linked ancestor up. A LINKED LEAF is never read (the catalogue
 * phase checked it; a categoria deleted during the run is a residual the next run's catalogue phase
 * repairs).
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * Documents by id only — an ERP parent, and (Simular, or after a 6) a document at our own id. No
 * query, so no index.
 *
 * ## Errors (root rule 6)
 *
 * Only `ALREADY_EXISTS` is caught, narrowed by its code; every other Firestore failure propagates
 * and the task retries.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import {
  categoriaCollection,
  categoriaLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin/grpcErrors';
import {
  CATEGORIAS_IMPORTACAO_LI,
  type CategoriaDoJobLi,
  type CategoriasImportacaoLi,
  MODO_IMPORTACAO_LI,
  MOTIVO_CADEIA_CATEGORIA_LI,
  MOTIVO_CATEGORIA_SEM_VINCULO_LI,
  type ModoImportacaoLi,
  type MotivoCadeiaCategoriaLi,
  type MotivoCategoriaSemVinculoLi,
  PENDENCIA_IMPORTACAO_LI,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  type VinculoCategoriaImportacaoLi,
  arvoreCategoriasLi,
  categoriaLojaIntegradaLinkSchema,
  categoriaSchema,
  folhaDoProdutoLi,
  idCategoriaLiDoVinculo,
  makeNomeCompleto,
  parentBreadcrumbFromDoc,
  toOuterRef,
  vinculoCategoriaServeAConta,
} from '@delfrance/schemas';

import { camposDoErro } from './plano';

/** The attempts of one create (the first, and one more when the document vanished after a 6). */
export const MAX_TENTATIVAS_CRIACAO_CATEGORIA_LI = 2;

export interface DepsCategoriasLi {
  readonly db: Firestore;
  /** The Loja Integrada conta (integração doc id) the job reads. */
  readonly contaId: string;
  /** Simular reads and decides exactly as `aplicar` does, and writes nothing. */
  readonly modo: ModoImportacaoLi;
  /** The job's option: create and link the missing categories, or only use linked ones. */
  readonly categorias: CategoriasImportacaoLi;
  /** The job's clock, ms: a created categoria's `timestamp` and `ultimaModificacao`. */
  readonly agoraMs: () => number;
}

/** The per-category aviso's material, for the caller to count and raise at the job's end. */
export interface AvisoDeCategoriaLi {
  readonly categoriaLiId: number;
  /** The category's path as store ids, root first (the category alone when its chain is refused). */
  readonly caminho: readonly number[];
  readonly motivo: MotivoCategoriaSemVinculoLi;
}

/** Why a product gets no category. */
export type PendenciaDeCategoriaLi =
  | typeof PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo
  | typeof PENDENCIA_IMPORTACAO_LI.categoriaRecusada
  | typeof PENDENCIA_IMPORTACAO_LI.categoriaAmbigua
  | typeof PENDENCIA_IMPORTACAO_LI.dadoInvalido
  | typeof PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita;

/** What one product's category came to. */
export type CategoriaDoProdutoLi =
  /** The ERP categoria the produto gets. */
  | {
      readonly tipo: 'resolvida';
      /** The store category (the product's leaf). */
      readonly categoriaLiId: number;
      readonly erpCategoriaId: string;
      /** Store categories THIS call created (Simular: would create), root-most first. */
      readonly criadas: readonly number[];
      /**
       * The ERP categoria is one an import of this conta created ({@link idCategoriaCriadaLi}), in
       * this run or an earlier one: a new categoria has no tax setting, so the produto it lands on
       * joins the tax-review list (`categoria-criada`).
       */
      readonly criadaPelaImportacao: boolean;
    }
  /** The store product names no category. */
  | { readonly tipo: 'nenhuma' }
  /** No category: the pendência, what it names, and the per-category aviso when one is due. */
  | {
      readonly tipo: 'recusada';
      readonly pendencia: PendenciaDeCategoriaLi;
      readonly referencias: readonly string[];
      readonly aviso: AvisoDeCategoriaLi | null;
      /** Store categories this call created before the refusal (their links exist). */
      readonly criadas: readonly number[];
    };

/** Named members of {@link CategoriaDoProdutoLi}'s `tipo`. */
export const TIPO_CATEGORIA_DO_PRODUTO_LI = {
  resolvida: 'resolvida',
  nenhuma: 'nenhuma',
  recusada: 'recusada',
} as const satisfies Record<string, CategoriaDoProdutoLi['tipo']>;

export interface ResultadoCategoriaDoProdutoLi {
  readonly categoria: CategoriaDoProdutoLi;
  /** The job's map after this call: the caller checkpoints it with the unit. */
  readonly mapaCategorias: readonly CategoriaDoJobLi[];
}

/* -------------------------------------------------------------------------- */
/*                                  The ids                                    */
/* -------------------------------------------------------------------------- */

function exigirIds(contaId: string, liId: number): void {
  if (contaId === '' || contaId.includes('/') || !Number.isSafeInteger(liId) || liId <= 0) {
    throw new RangeError(`categorias: conta ou id da loja inválido (${String(liId)})`);
  }
}

/**
 * The doc id of the categoria an import of conta `contaId` creates for store category `liId`:
 * `li-<contaId>-<liId>`. The store id is digits only and comes last, so two (conta, id) pairs never
 * share one doc id. Throws `RangeError` on an id that cannot be one (both come from parsed input).
 */
export function idCategoriaCriadaLi(contaId: string, liId: number): string {
  exigirIds(contaId, liId);
  return `li-${contaId}-${String(liId)}`;
}

/** The doc id of that categoria's link: `<contaId>-<liId>` (same rules). */
export function idVinculoCategoriaCriadoLi(contaId: string, liId: number): string {
  exigirIds(contaId, liId);
  return `${contaId}-${String(liId)}`;
}

/* -------------------------------------------------------------------------- */
/*                                  The map                                    */
/* -------------------------------------------------------------------------- */

/** How a store category stands in the map. */
type SituacaoNoMapa =
  | { readonly tipo: 'ligada'; readonly erpCategoriaId: string }
  | { readonly tipo: 'ambigua' }
  | { readonly tipo: 'livre' };

const LIVRE: SituacaoNoMapa = { tipo: 'livre' };

/**
 * Every store category's situation: `ligada` for a `vinculada` or `simulada` entry that names an
 * ERP categoria, `ambigua`, else `livre`. A repeated row of one id (the catalogue keeps them) shares
 * its id's situation.
 */
function situacoesDoMapa(mapa: readonly CategoriaDoJobLi[]): ReadonlyMap<number, SituacaoNoMapa> {
  const saida = new Map<number, SituacaoNoMapa>();
  for (const c of mapa) {
    const atual = saida.get(c.id);
    if (atual?.tipo === 'ligada') continue;
    const ligada =
      c.vinculo === VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada ||
      c.vinculo === VINCULO_CATEGORIA_IMPORTACAO_LI.simulada;
    if (ligada && c.erpCategoriaId !== null) {
      saida.set(c.id, { tipo: 'ligada', erpCategoriaId: c.erpCategoriaId });
    } else if (c.vinculo === VINCULO_CATEGORIA_IMPORTACAO_LI.ambigua) {
      saida.set(c.id, { tipo: 'ambigua' });
    } else if (atual === undefined) {
      saida.set(c.id, LIVRE);
    }
  }
  return saida;
}

/** The map with every entry of store category `id` set to `vinculo` / `erpCategoriaId`. */
function marcar(
  mapa: readonly CategoriaDoJobLi[],
  id: number,
  vinculo: VinculoCategoriaImportacaoLi,
  erpCategoriaId: string | null,
): CategoriaDoJobLi[] {
  return mapa.map((c) => (c.id === id ? { ...c, vinculo, erpCategoriaId } : c));
}

/** The motivo of the per-category aviso for a refused chain (`null`: no aviso is due). */
const AVISO_DA_CADEIA_LI = {
  ausente: null,
  'pai-ilegivel': MOTIVO_CATEGORIA_SEM_VINCULO_LI.paiIlegivel,
  'pai-ausente': MOTIVO_CATEGORIA_SEM_VINCULO_LI.paiAusente,
  ciclo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.ciclo,
  profundidade: MOTIVO_CATEGORIA_SEM_VINCULO_LI.profundidade,
} as const satisfies Record<MotivoCadeiaCategoriaLi, MotivoCategoriaSemVinculoLi | null>;

/** A refused chain's motivo as a pendência carries it (its last reference), when it is one. */
function motivoDaCadeiaLido(texto: string | undefined): MotivoCadeiaCategoriaLi | null {
  return Object.values(MOTIVO_CADEIA_CATEGORIA_LI).find((m) => m === texto) ?? null;
}

/**
 * The per-category aviso's material, re-derived at a job's END from one REPORTED category pendência
 * and the job's map (the job keeps no per-category tally across dispatches, so the items are the
 * record): exactly the `aviso` {@link resolverCategoriaDoProdutoLi} returned when it refused that
 * product — `categoria-sem-vinculo` `[<id>]` ⇒ the category's whole chain (or itself alone when the
 * chain does not read), motivo `sem-vinculo`; `categoria-recusada` `[<id>, …, <cadeia motivo>]` ⇒
 * the category alone with that motivo's aviso motivo, or nothing when none is due (`ausente`); any
 * other code, an unreadable chain (`['ilegivel']`) or a first reference that is no store id ⇒
 * `null`. The map's tree only ever changes its links during a job, never its shape, so the chain
 * read here is the one the refusal read. Pure.
 */
export function avisoDaPendenciaDeCategoriaLi(
  mapa: readonly CategoriaDoJobLi[],
  pendencia: { readonly codigo: string; readonly referencias: readonly string[] },
): AvisoDeCategoriaLi | null {
  const primeira = pendencia.referencias[0] ?? '';
  const id = /^[1-9]\d{0,14}$/.test(primeira) ? Number(primeira) : null;
  if (id === null) return null;
  if (pendencia.codigo === PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo) {
    const cadeia = arvoreCategoriasLi(mapa).cadeia(id);
    return {
      categoriaLiId: id,
      caminho: cadeia.tipo === 'ok' ? [...cadeia.ids] : [id],
      motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
    };
  }
  if (pendencia.codigo !== PENDENCIA_IMPORTACAO_LI.categoriaRecusada) return null;
  const motivoDaCadeia = motivoDaCadeiaLido(pendencia.referencias.at(-1));
  const motivo = motivoDaCadeia === null ? null : AVISO_DA_CADEIA_LI[motivoDaCadeia];
  return motivo === null ? null : { categoriaLiId: id, caminho: [id], motivo };
}

/* -------------------------------------------------------------------------- */
/*                                The decision                                 */
/* -------------------------------------------------------------------------- */

/** One pass of the decision: an outcome, or a linked parent found gone (its link is then ignored). */
type Passo =
  | {
      readonly tipo: 'fim';
      readonly categoria: CategoriaDoProdutoLi;
      readonly mapa: readonly CategoriaDoJobLi[];
    }
  | { readonly tipo: 'pai-sumiu'; readonly liId: number };

function recusada(
  pendencia: PendenciaDeCategoriaLi,
  referencias: readonly string[],
  aviso: AvisoDeCategoriaLi | null = null,
  criadas: readonly number[] = [],
): CategoriaDoProdutoLi {
  return { tipo: 'recusada', pendencia, referencias, aviso, criadas };
}

/** One categoria to create: its store category, its ERP parent and that parent's breadcrumb. */
interface Planejada {
  readonly liId: number;
  readonly nome: string;
  readonly paiErpId: string | null;
  readonly trilhaDoPai: string | null;
}

/** What creating (or, under Simular, planning) one category came to. */
type Criacao =
  | { readonly tipo: 'ok'; readonly erpCategoriaId: string; readonly trilha: string | null }
  | {
      readonly tipo: 'recusa';
      readonly pendencia: PendenciaDeCategoriaLi;
      readonly referencias: readonly string[];
    };

/** The raw `nome` / `nomeCompleto` of a stored categoria, as the breadcrumb helper takes them. */
function trilhaDoDoc(dados: unknown): string | null {
  if (typeof dados !== 'object' || dados === null) return null;
  const nome: unknown = Reflect.get(dados, 'nome');
  const nomeCompleto: unknown = Reflect.get(dados, 'nomeCompleto');
  return parentBreadcrumbFromDoc({
    nome: typeof nome === 'string' ? nome : null,
    nomeCompleto: typeof nomeCompleto === 'string' ? nomeCompleto : null,
  });
}

/** Field names of a failed parse, under the document's name (`categoria.nome`). */
function camposDe(
  prefixo: string,
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): string[] {
  return camposDoErro(issues).map((c) => `${prefixo}.${c}`);
}

/**
 * Resolve ONE product's category (module header): the leaf, then the link, the create or the
 * refusal. Returns the category and the job's map after it.
 */
export async function resolverCategoriaDoProdutoLi(
  deps: DepsCategoriasLi,
  mapaCategorias: readonly CategoriaDoJobLi[],
  uris: readonly unknown[],
): Promise<ResultadoCategoriaDoProdutoLi> {
  let mapa = mapaCategorias;
  // Each `pai-sumiu` turns one linked entry into `sem-vinculo`, so this ends within the map's size.
  for (;;) {
    const passo = await decidir(deps, mapa, uris);
    if (passo.tipo === 'fim') return { categoria: passo.categoria, mapaCategorias: passo.mapa };
    mapa = marcar(mapa, passo.liId, VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo, null);
  }
}

async function decidir(
  deps: DepsCategoriasLi,
  mapa: readonly CategoriaDoJobLi[],
  uris: readonly unknown[],
): Promise<Passo> {
  const situacoes = situacoesDoMapa(mapa);
  const situacao = (id: number): SituacaoNoMapa => situacoes.get(id) ?? LIVRE;
  const arvore = arvoreCategoriasLi(mapa);
  const fim = (categoria: CategoriaDoProdutoLi, m = mapa): Passo => ({
    tipo: 'fim',
    categoria,
    mapa: m,
  });

  const folha = folhaDoProdutoLi(uris, arvore, (id) => situacao(id).tipo !== 'livre');
  switch (folha.tipo) {
    case 'nenhuma':
      return fim({ tipo: TIPO_CATEGORIA_DO_PRODUTO_LI.nenhuma });
    case 'ilegivel':
      return fim(recusada(PENDENCIA_IMPORTACAO_LI.categoriaRecusada, ['ilegivel']));
    case 'ciclo': {
      const [primeira] = folha.ids;
      const aviso: AvisoDeCategoriaLi | null =
        primeira === undefined
          ? null
          : {
              categoriaLiId: primeira,
              caminho: [primeira],
              motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.ciclo,
            };
      return fim(
        recusada(
          PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
          [...folha.ids.map((id) => String(id)), MOTIVO_CADEIA_CATEGORIA_LI.ciclo],
          aviso,
        ),
      );
    }
    case 'ambigua':
      return fim(
        recusada(
          PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
          folha.ids.map((id) => String(id)),
        ),
      );
    case 'folha':
      break;
  }

  const idFolha = folha.id;
  const daFolha = situacao(idFolha);
  if (daFolha.tipo === 'ligada') {
    return fim({
      tipo: TIPO_CATEGORIA_DO_PRODUTO_LI.resolvida,
      categoriaLiId: idFolha,
      erpCategoriaId: daFolha.erpCategoriaId,
      criadas: [],
      criadaPelaImportacao: daFolha.erpCategoriaId === idCategoriaCriadaLi(deps.contaId, idFolha),
    });
  }
  if (daFolha.tipo === 'ambigua') {
    return fim(recusada(PENDENCIA_IMPORTACAO_LI.categoriaAmbigua, [String(idFolha)]));
  }

  // The leaf is unlinked.
  const cadeia = arvore.cadeia(idFolha);
  if (cadeia.tipo === 'recusada' && cadeia.motivo === MOTIVO_CADEIA_CATEGORIA_LI.ausente) {
    // A category the store's list does not hold: nobody can link it, so no aviso either.
    return fim(
      recusada(PENDENCIA_IMPORTACAO_LI.categoriaRecusada, [String(idFolha), cadeia.motivo]),
    );
  }
  if (deps.categorias === CATEGORIAS_IMPORTACAO_LI.soVincular) {
    return fim(
      recusada(PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo, [String(idFolha)], {
        categoriaLiId: idFolha,
        caminho: cadeia.tipo === 'ok' ? [...cadeia.ids] : [idFolha],
        motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
      }),
    );
  }
  if (cadeia.tipo === 'recusada') {
    const motivo = AVISO_DA_CADEIA_LI[cadeia.motivo];
    return fim(
      recusada(
        PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
        [String(idFolha), cadeia.motivo],
        motivo === null ? null : { categoriaLiId: idFolha, caminho: [idFolha], motivo },
      ),
    );
  }

  // `criarEVincular` over a chain that reads whole: the nearest linked ancestor is the ERP parent.
  const ids = cadeia.ids;
  let k = ids.length - 2;
  while (k >= 0 && situacao(ids[k]!).tipo === 'livre') k -= 1;
  let paiErpId: string | null = null;
  let trilha: string | null = null;
  if (k >= 0) {
    const ancestral = ids[k]!;
    const doAncestral = situacao(ancestral);
    if (doAncestral.tipo !== 'ligada') {
      return fim(recusada(PENDENCIA_IMPORTACAO_LI.categoriaAmbigua, [String(ancestral)]));
    }
    const lida = await trilhaDaLigada(deps, mapa, situacao, arvore, ancestral, new Map());
    if (lida.tipo === 'sumiu') return { tipo: 'pai-sumiu', liId: lida.liId };
    paiErpId = doAncestral.erpCategoriaId;
    trilha = lida.trilha;
  }

  let novoMapa: readonly CategoriaDoJobLi[] = mapa;
  const criadas: number[] = [];
  const idsDaLoja: ReadonlySet<number> = new Set(situacoes.keys());
  for (const liId of ids.slice(k + 1)) {
    const criacao = await criarCategoria(deps, idsDaLoja, {
      liId,
      // A chain that reads whole names only listed categories, never one of two disagreeing rows.
      nome: arvore.categoria(liId)?.nome ?? '',
      paiErpId,
      trilhaDoPai: trilha,
    });
    if (criacao.tipo === 'recusa') {
      return fim(recusada(criacao.pendencia, criacao.referencias, null, criadas), novoMapa);
    }
    novoMapa = marcar(
      novoMapa,
      liId,
      deps.modo === MODO_IMPORTACAO_LI.simular
        ? VINCULO_CATEGORIA_IMPORTACAO_LI.simulada
        : VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada,
      criacao.erpCategoriaId,
    );
    criadas.push(liId);
    paiErpId = criacao.erpCategoriaId;
    trilha = criacao.trilha;
  }
  return fim(
    {
      tipo: TIPO_CATEGORIA_DO_PRODUTO_LI.resolvida,
      categoriaLiId: idFolha,
      // The leaf is the chain's last id, so the loop above ran at least once.
      erpCategoriaId: paiErpId ?? idCategoriaCriadaLi(deps.contaId, idFolha),
      criadas,
      criadaPelaImportacao: true,
    },
    novoMapa,
  );
}

/** A linked (or `simulada`) category's breadcrumb, or the store id of a linked one now gone. */
type TrilhaLida =
  | { readonly tipo: 'ok'; readonly trilha: string | null }
  | { readonly tipo: 'sumiu'; readonly liId: number };

/**
 * The breadcrumb a child of linked store category `liId` takes: its ERP categoria as STORED
 * (`parentBreadcrumbFromDoc`). A `simulada` one that does not exist yet (Simular planned it) is
 * recomputed exactly as its create would have written it: its name under ITS nearest linked
 * ancestor's breadcrumb. A `vinculada` one that does not exist is gone (module header).
 */
async function trilhaDaLigada(
  deps: DepsCategoriasLi,
  mapa: readonly CategoriaDoJobLi[],
  situacao: (id: number) => SituacaoNoMapa,
  arvore: ReturnType<typeof arvoreCategoriasLi>,
  liId: number,
  memo: Map<number, TrilhaLida>,
): Promise<TrilhaLida> {
  const ja = memo.get(liId);
  if (ja !== undefined) return ja;
  const s = situacao(liId);
  if (s.tipo !== 'ligada') return { tipo: 'sumiu', liId };
  const snap = await categoriaCollection.docRef(deps.db, {}, s.erpCategoriaId).get();
  let lida: TrilhaLida;
  if (snap.exists) {
    lida = { tipo: 'ok', trilha: trilhaDoDoc(snap.data()) };
  } else if (!simulada(mapa, liId)) {
    lida = { tipo: 'sumiu', liId };
  } else {
    const cadeia = arvore.cadeia(liId);
    const ids = cadeia.tipo === 'ok' ? cadeia.ids : [liId];
    let k = ids.length - 2;
    while (k >= 0 && situacao(ids[k]!).tipo !== 'ligada') k -= 1;
    const acima =
      k >= 0
        ? await trilhaDaLigada(deps, mapa, situacao, arvore, ids[k]!, memo)
        : ({ tipo: 'ok', trilha: null } as const);
    const nome = arvore.categoria(liId)?.nome ?? '';
    // What its create would have stored, read back the way a stored breadcrumb is read.
    lida =
      acima.tipo === 'ok'
        ? {
            tipo: 'ok',
            trilha: trilhaDoDoc({ nome, nomeCompleto: makeNomeCompleto(nome, acima.trilha) }),
          }
        : acima;
  }
  memo.set(liId, lida);
  return lida;
}

function simulada(mapa: readonly CategoriaDoJobLi[], liId: number): boolean {
  return mapa.some((c) => c.id === liId && c.vinculo === VINCULO_CATEGORIA_IMPORTACAO_LI.simulada);
}

/* -------------------------------------------------------------------------- */
/*                                  The create                                 */
/* -------------------------------------------------------------------------- */

/** The judgement of the document found at our own id (module header, "ALREADY_EXISTS"). */
type Julgamento =
  | { readonly tipo: 'adotar'; readonly dados: unknown }
  | { readonly tipo: 'recusar'; readonly criacao: Criacao }
  | { readonly tipo: 'sumiu' };

/**
 * One document at its deterministic id (module header): `create()` under `aplicar`, a READ under
 * Simular; `ALREADY_EXISTS` re-read and judged. `planejado` is what a create writes.
 */
async function garantir(
  deps: DepsCategoriasLi,
  ref: DocumentReference,
  planejado: Record<string, unknown>,
  julgar: (dados: unknown) => Julgamento,
): Promise<{ readonly tipo: 'criado' } | Julgamento> {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_CRIACAO_CATEGORIA_LI; tentativa += 1) {
    if (deps.modo !== MODO_IMPORTACAO_LI.simular) {
      try {
        await ref.create(planejado);
        return { tipo: 'criado' };
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
    }
    const snap = await ref.get();
    if (!snap.exists) {
      // Simular: nothing there, so `aplicar` would create it.
      if (deps.modo === MODO_IMPORTACAO_LI.simular) return { tipo: 'criado' };
      continue;
    }
    return julgar(snap.data());
  }
  return { tipo: 'sumiu' };
}

/** Create (or plan) one category and its link (module header, "Create and link"). */
async function criarCategoria(
  deps: DepsCategoriasLi,
  idsDaLoja: ReadonlySet<number>,
  p: Planejada,
): Promise<Criacao> {
  const erpCategoriaId = idCategoriaCriadaLi(deps.contaId, p.liId);
  const agora = deps.agoraMs();
  const categoria = categoriaSchema.safeParse({
    nome: p.nome,
    nomeCompleto: makeNomeCompleto(p.nome, p.trilhaDoPai),
    categoriaPaiOuterRef:
      p.paiErpId === null ? null : toOuterRef(categoriaCollection.docPath({}, p.paiErpId)),
    timestamp: agora,
    ultimaModificacao: agora,
  });
  if (!categoria.success) {
    return {
      tipo: 'recusa',
      pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      referencias: camposDe('categoria', categoria.error.issues),
    };
  }
  const vinculo = categoriaLojaIntegradaLinkSchema.safeParse({
    id: String(p.liId),
    nome: p.nome,
    contaLojaIntegrada: toOuterRef(`integracao/${deps.contaId}`),
  });
  if (!vinculo.success) {
    return {
      tipo: 'recusa',
      pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      referencias: camposDe('categoriaLojaIntegrada', vinculo.error.issues),
    };
  }

  const conflito: Criacao = {
    tipo: 'recusa',
    pendencia: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
    referencias: [erpCategoriaId],
  };

  const planejada: Record<string, unknown> = { ...categoria.data };
  const daCategoria = await garantir(
    deps,
    categoriaCollection.docRef(deps.db, {}, erpCategoriaId),
    planejada,
    (dados) => {
      const lido = categoriaSchema.safeParse(dados);
      return lido.success
        ? { tipo: 'adotar', dados }
        : {
            tipo: 'recusar',
            criacao: {
              tipo: 'recusa',
              pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
              referencias: camposDe('categoria', lido.error.issues),
            },
          };
    },
  );
  if (daCategoria.tipo === 'recusar') return daCategoria.criacao;
  if (daCategoria.tipo === 'sumiu') return conflito;
  const trilha = trilhaDoDoc(daCategoria.tipo === 'adotar' ? daCategoria.dados : planejada);

  const doVinculo = await garantir(
    deps,
    categoriaLojaIntegradaLinkCollection.docRef(
      deps.db,
      { categoriaId: erpCategoriaId },
      idVinculoCategoriaCriadoLi(deps.contaId, p.liId),
    ),
    { ...vinculo.data },
    (dados) =>
      idCategoriaLiDoVinculo(dados) === p.liId &&
      vinculoCategoriaServeAConta(dados, deps.contaId, idsDaLoja)
        ? { tipo: 'adotar', dados }
        : {
            tipo: 'recusar',
            criacao: {
              tipo: 'recusa',
              pendencia: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
              referencias: [String(p.liId)],
            },
          },
  );
  if (doVinculo.tipo === 'recusar') return doVinculo.criacao;
  if (doVinculo.tipo === 'sumiu') return conflito;
  return { tipo: 'ok', erpCategoriaId, trilha };
}
