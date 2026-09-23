/**
 * **Publish ONE produto to Shopee** (#1519, step 11 — S2/S3/S7): the IO half.
 *
 * Three functions, in one order: {@link prepararPublicacao} READS the whole
 * graph (structurally write-free), `planejarPublicacao` (`planoPublicacao.ts`)
 * DECIDES, and {@link aplicarPublicacao} EXECUTES the eleven steps of the
 * reconciler's §2.4 order. {@link publicarAnuncioShopee} is that sequence; the
 * first two are exported separately so the CLI's dry run can print the PLAN
 * without applying it.
 *
 * It owns exactly four Shopee calls — `add_item`, `update_item`, `unlist_item`
 * and `get_item_base_info` (the read-back, through `produtos/lerAnuncio.ts`) —
 * plus `get_channel_list` in `preparar` and the bounded `get_brand_list` paging
 * of the brand cascade. The five tier/model calls are
 * `modelosPublicacao.ts`'s and `upload_image` is `fotosPublicacao.ts`'s; no
 * other module under `anuncios/` calls Shopee at all, which is what makes
 * "which module owns which call" answerable by FILE.
 *
 * ## ⚠️ The read-back is the ONLY source of listing STATE (O5)
 *
 * `add_item` / `update_item` answer an echo, and the sandbox probe measured that
 * echo carrying a **stale `item_status`** while `get_item_base_info` answered the
 * right one on the same item in the same second (`announcement 1395` is removing
 * the response's logistics block for the same reason, and `announcement 1394`
 * says to call `get_item_base_info` instead). So the only thing this module ever
 * reads out of a write response is the `item_id` of a create — an IDENTIFIER,
 * not state — and `item_status`, `estadoAnuncio`, `deboost`,
 * `original_brand_name` and `logistic_info` all come from step 10's read-back.
 *
 * ## ⚠️ Write-back #1 lands the instant Shopee confirms, for RESUMABILITY
 *
 * A publish is a sequence of provider calls that can fail anywhere in the
 * middle, and Shopee keeps whatever already landed. Persisting the `item_id` the
 * moment `add_item` answers is what makes a half-failed publish RESUMABLE
 * instead of orphaned: a link document holding an `item_id` and no models makes
 * the next publish an UPDATE that runs the tier leg. The alternative — one write
 * at the end — loses the id of a listing that exists, and the next attempt
 * creates a SECOND one.
 *
 * Clock-free and timer-free: `deps.nowMs` is the ONE clock read and
 * `deps.esperar` the ONE wait, both parameters. Every Firestore access goes
 * through a `@delfrance/data/admin/collections` handle and nothing here opens a
 * multi-document atomic write.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_BRAND_MAX_PAGE_SIZE,
  SHOPEE_BRAND_STATUS,
  SHOPEE_ITEM_STATUS_WRITABLE,
  ShopeeApiError,
  ShopeeError,
  ShopeeRateLimitError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeAddItemRequest,
  type ShopeeClient,
  type ShopeeItemStatusWritable,
  type ShopeeItemWriteResponse,
  type ShopeeLogisticsChannel,
  type ShopeePartnerClient,
  type ShopeeTaxInfoRequest,
  type ShopeeUpdateItemRequest,
} from '@delfrance/integrations-shopee';
import {
  SHOPEE_ITEM_STATUS,
  componentesKitSchema,
  estoqueDisponivel,
  fotoSchema,
  kitEstoqueDisponivel,
  parseFakePath,
  parseRef,
  toOuterRef,
  varianteFakePath,
  type ComponentesKit,
  type EstadoAnuncioShopee,
  type Foto,
} from '@delfrance/schemas';
import {
  grupoDeVariacoesCollection,
  integracaoCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { ShopeeImportBlockedError } from '../produtos/errosImportacao';
import { lerLinhaDeEstoque } from '../produtos/estoquePrecos';
import {
  ehKitDe,
  itemStatusDe,
  temModelosDe,
  type ItemLido,
  type MemoDeCategorias,
} from '../produtos/itemLido';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { aplicarLinkDaListagem } from '../produtos/links';
import { itemStatusDeLink } from '../produtos/mapeamento';
import { avisoDeShopee, lerAtributos } from '../taxonomia/atributos';
import { lerMarcasCached, type ShopeeTaxonomiaCtx } from '../taxonomia/cache';
import { ehFolha } from '../taxonomia/categorias';
import { projetarAtributos, type AtributosProjetados } from '../taxonomia/dto';
import { lerLimitesDeItem, type LimitesDeItemLidos } from '../taxonomia/limites';
import { MOTIVO_RESOLUCAO_ANUNCIO, resolverAvisoDeAnuncio } from './avisoAnuncio';
import {
  ESPERA_APOS_ADD_ITEM_MS,
  FRASE_TAX_INFO_INCOMPLETO,
  MAX_PAGINAS_MARCAS,
} from './constantesAnuncio';
import {
  ETAPA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  limitarMensagemProblema,
  temProblemaDeBloqueio,
  type EtapaPublicacao,
  type ProblemaDeBloqueio,
  type ProblemaPublicacao,
} from './errosPublicacao';
import {
  criarResolvedorDeImagens,
  type FalhaDeFotoPublicacao,
  type ResolvedorDeImagensShopee,
  type ResumoFotosPublicacao,
} from './fotosPublicacao';
import { criarLeitorDeImpostoShopee } from './lerImpostoDoProduto';
import { lerLinksDeVariacao, resolverLinkPorProduto, type LinkDeVariacao } from './linkAnuncio';
import { aplicarModelos, type ResultadoModelos } from './modelosPublicacao';
import {
  kitNativoDoAnuncio,
  type LinkListagemLido,
  type ProdutoParaPublicar,
} from './montagemAnuncio';
import {
  planejarPublicacao,
  type ContextoPublicacao,
  type FotosResolvidas,
  type OrdemDeRelistagem,
  type PlanoPublicacao,
} from './planoPublicacao';
import { problemaDeErroShopee, problemasDeErroShopee } from './problemasPublicacao';
import { agendadoParaMsDe, estadoDoAnuncio } from './statusAnuncio';
import { MOTIVO_TAX_INFO_OMITIDO, type MotivoTaxInfoOmitido } from './taxInfoPublicacao';
import {
  fotoDaOpcaoDeTier,
  ordenarTiers,
  type FilhoParaPublicar,
  type GrupoParaTier,
  type VarianteDoTier,
} from './tiersPublicacao';

/* -------------------------------------------------------------------------- */
/*                                    Deps                                    */
/* -------------------------------------------------------------------------- */

export interface PublicarAnuncioDeps {
  readonly db: Firestore;
  readonly client: ShopeeClient;
  /**
   * The PARTNER client, as a factory (C8). `upload_image` is Public-signed, so
   * it is the client that never asks for an access token; the factory is the
   * composition root's seam and the photo unit receives a bound FUNCTION rather
   * than a client.
   */
  readonly partnerClient: () => ShopeePartnerClient;
  /** The conta's BARE doc id. */
  readonly integracaoId: string;
  readonly tabelaNormalOuterRef: string | null;
  readonly depositoOuterRef: string | null;
  readonly operacaoOuterRef: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Read at the COMPOSITION ROOT — never from the environment here. */
  readonly hostEmulador?: string | null;
  /** MILLISECONDS. ONE clock read per request, handed down. */
  readonly nowMs: number;
  /** The ONE wait of this folder — there is no timer under `anuncios/`. */
  readonly esperar: (ms: number) => Promise<void>;
  readonly taxonomia: ShopeeTaxonomiaCtx;
  readonly categorias: MemoDeCategorias;
  /**
   * The picture-resolver seam. Absent ⇒ {@link criarResolvedorDePublicacao},
   * which is what production always takes; the `ReverificarAnuncioDeps.clientFor`
   * idiom. It is the ONE resolver of the publish either way (C7).
   */
  readonly resolvedorDeImagens?: ResolvedorDeImagensShopee;
}

/**
 * The deps of the READ-ONLY half, and the proof is STRUCTURAL: no writer is
 * reachable from this type.
 *
 * `partnerClient` and `fetchImpl` are what the photo resolver needs to UPLOAD,
 * `esperar` only matters between two writes, and `hostEmulador` only widens the
 * download allow-list. Omitting all four is the `PrepararImportacaoShopeeDeps`
 * discipline: the property is proved by the call graph rather than asserted in a
 * comment — and it is also why the resolver arrives as a PARAMETER of
 * {@link prepararPublicacao} instead of being built there.
 */
export type PrepararPublicacaoDeps = Omit<
  PublicarAnuncioDeps,
  'partnerClient' | 'fetchImpl' | 'esperar' | 'hostEmulador' | 'resolvedorDeImagens'
>;

/** What the route's body (and the CLI's flags) resolve to. */
export interface EntradaDePublicacao {
  readonly produtoId: string;
  /**
   * Narrows to ONE `prodshopee` document. A `linkDocId` belonging to ANOTHER
   * conta resolves to nothing at all, so the route answers 404 instead of
   * publishing onto a listing this conta does not own.
   */
  readonly linkDocId?: string | null;
  /**
   * The operator's category choice (C36). Used ONLY when the resolved link
   * carries no `category_id`; a stored value always wins.
   */
  readonly categoryId?: number | null;
  /** What the operator asked for. A create WITH children still sends `UNLIST` first. */
  readonly statusPedido: ShopeeItemStatusWritable;
}

/** One publish, done. */
export interface ResultadoPublicacao {
  readonly plano: PlanoPublicacao;
  readonly produtoId: string;
  /** The listing id — the echo's on a create, the stored one on an update. */
  readonly itemId: number;
  readonly linkDocId: string;
  readonly ehAtualizacao: boolean;
  /**
   * The fold over the READ-BACK (O5). `null` when the read-back degraded, which
   * is the one case where nothing authoritative was read.
   */
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  /** The RAW `item_status` of the read-back; `null` when it degraded. */
  readonly itemStatus: string | null;
  readonly deboost: boolean;
  /** The FIRST non-noise envelope `warning` of this publish, in call order. */
  readonly avisoShopee: string | null;
  readonly modelos: ResultadoModelos;
  readonly fotos: ResumoFotosPublicacao;
  /** Pictures this publish could not resolve. Counted, never fatal. */
  readonly falhasDeFoto: readonly FalhaDeFotoPublicacao[];
  readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  /** Which re-list door worked; `null` when the dance was not planned. */
  readonly relistagem: OrdemDeRelistagem | null;
  /** `true` only when a violation aviso was OPEN and this publish closed it. */
  readonly avisoResolvido: boolean;
  /** `false` when the read-back could not find the listing (eventual consistency). */
  readonly leituraDeVolta: boolean;
  /**
   * Shopee calls spent by **`aplicar` only** — the budget signal, like
   * `reverificarAnuncio.ts`'s field of the same name.
   *
   * ⚠️ It does NOT include what `preparar` paid for (`get_item_limit`,
   * `get_attribute_tree`, `get_channel_list` and the brand paging): the figure
   * lives on the APPLIER's result, and `preparar` is write-free and reusable.
   * Inside `aplicar` every step is counted per CALL — the read-back included,
   * which is two for a kit or an item with models.
   */
  readonly chamadasShopee: number;
}

/* -------------------------------------------------------------------------- */
/*                          small tolerant projections                         */
/* -------------------------------------------------------------------------- */

function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' ? bruto : null;
}

function textoUtilizavel(bruto: unknown): string | null {
  const texto = textoOuNull(bruto);
  if (texto === null) return null;
  const limpo = texto.trim();
  return limpo.length > 0 ? texto : null;
}

function numeroOuNull(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null;
}

function booleano(bruto: unknown): boolean {
  return bruto === true;
}

/**
 * A stored three-valued boolean, kept three-valued.
 *
 * ⚠️ Not {@link booleano}: that one folds every non-`true` reading to `false`,
 * which is right for an ERP flag with a schema default and WRONG for a field
 * whose `null` means "this listing was never read back" — the reading and the
 * absence of a reading are different facts, and only this projection preserves
 * them. The refusal that consumes it compares `=== true` either way; what the
 * fold would destroy is every later reader's ability to tell the two apart.
 */
function booleanoOuNull(bruto: unknown): boolean | null {
  return typeof bruto === 'boolean' ? bruto : null;
}

function listaDeTextos(bruto: unknown): readonly string[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** A stored `item_id` that is not a positive number is "no listing yet". */
function itemIdUtilizavel(bruto: unknown): number | null {
  const n = numeroOuNull(bruto);
  return n !== null && n > 0 ? n : null;
}

/**
 * `produto.precos`, projected to what the mappers read.
 *
 * ⚠️ An entry whose `valor` is not a finite number is DROPPED rather than
 * coerced: a price is the one field where a guessed number reaches a buyer.
 */
function precosDeProduto(bruto: unknown): Record<string, { readonly valor: number }> | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const saida: Record<string, { readonly valor: number }> = {};
  for (const [tabela, valor] of Object.entries(bruto as Record<string, unknown>)) {
    const n = numeroOuNull((valor as { valor?: unknown } | null)?.valor);
    if (n !== null) saida[tabela] = { valor: n };
  }
  return Object.keys(saida).length > 0 ? saida : null;
}

/**
 * `produto.fotos`, row by row, through the schema.
 *
 * A row that does not parse is DROPPED with the others kept: `arquivoOuterRef`
 * is what the resolver needs and a row without one cannot be fetched at all, so
 * refusing the whole produto for one malformed picture would make a publish
 * impossible for a defect the operator can fix on one row. The count reaches the
 * one log line.
 */
function fotosDeProduto(bruto: unknown): {
  readonly fotos: readonly Foto[];
  readonly ilegiveis: number;
} {
  if (!Array.isArray(bruto)) return { fotos: [], ilegiveis: 0 };
  const fotos: Foto[] = [];
  let ilegiveis = 0;
  for (const linha of bruto) {
    const lido = fotoSchema.safeParse(linha);
    if (lido.success) fotos.push(lido.data);
    else ilegiveis += 1;
  }
  return { fotos, ilegiveis };
}

function componentesDeProduto(bruto: unknown): ComponentesKit | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const lido = componentesKitSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/**
 * ⚠️ An absent `ordem` sorts LAST, never first.
 *
 * `produto.ordem` is `.nullable()`, and the legacy sorts an absent one at the
 * end (`sortGruposByOrdem`'s `?? Infinity`). A `0` fallback would make an
 * unordered child win the item-level price of a create over a child the operator
 * explicitly put first. `MAX_SAFE_INTEGER` rather than `Infinity` so the value
 * stays a safe integer in every comparison.
 */
const ORDEM_AUSENTE = Number.MAX_SAFE_INTEGER;

function ordemDeProduto(bruto: unknown): number {
  return numeroOuNull(bruto) ?? ORDEM_AUSENTE;
}

/** One produto document, projected for the mappers. */
function produtoParaPublicar(id: string, raw: Record<string, unknown>): ProdutoParaPublicar {
  return {
    id,
    nome: textoOuNull(raw.nome) ?? '',
    sku: textoOuNull(raw.sku),
    gtin: textoOuNull(raw.gtin),
    paiId: textoUtilizavel(raw.paiId),
    ehKit: booleano(raw.ehKit),
    ehKitVirtual: booleano(raw.ehKitVirtual),
    ehUsado: booleano(raw.ehUsado),
    ofereceFreteGratis: booleano(raw.ofereceFreteGratis),
    crossdocking: numeroOuNull(raw.crossdocking),
    pesoBrutoKg: numeroOuNull(raw.pesoBrutoKg),
    pesoLiquidoKg: numeroOuNull(raw.pesoLiquidoKg),
    alturaCm: numeroOuNull(raw.alturaCm),
    larguraCm: numeroOuNull(raw.larguraCm),
    profundidadeCm: numeroOuNull(raw.profundidadeCm),
    precos: precosDeProduto(raw.precos),
    variacoesUid: listaDeTextos(raw.variacoesUid),
    componentesKit: componentesDeProduto(raw.componentesKit),
    fotos: fotosDeProduto(raw.fotos).fotos,
  };
}

/**
 * The stored `prodshopee` fields the ITEM mapper reads.
 *
 * ⚠️ `estadoAnuncio` arrives ALREADY folded by `linkAnuncio.ts` (an unrecognised
 * stored value reads as `null`), which is what lets `montarAnuncio` refuse a
 * `removido` listing without a second copy of that fold.
 *
 * ⚠️ `kitNativo` is read THREE-valued and never coerced — it is what Shopee
 * reported about the live listing, and it is the authority behind
 * `produto-e-kit` on every republish.
 */
function linkListagemLido(
  raw: Record<string, unknown>,
  estadoAnuncio: EstadoAnuncioShopee | null,
): LinkListagemLido {
  return {
    item_id: itemIdUtilizavel(raw.item_id),
    item_name: textoOuNull(raw.item_name),
    description: textoOuNull(raw.description),
    category_id: numeroOuNull(raw.category_id),
    brand_id: numeroOuNull(raw.brand_id),
    attributes: Array.isArray(raw.attributes) ? (raw.attributes as readonly unknown[]) : null,
    logistic_info: Array.isArray(raw.logistic_info)
      ? (raw.logistic_info as readonly unknown[])
      : null,
    estadoAnuncio,
    kitNativo: booleanoOuNull(raw.kitNativo),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   preparar                                  */
/* -------------------------------------------------------------------------- */

/**
 * The photo resolver of ONE publish, with the upload bound to the partner client
 * (C8) — the ONE place in this app that binds it.
 *
 * ONE resolver per publish, deliberately: its `arquivos.externalIds` memo has to
 * span the item pass AND every tier-1 option pass (C7), and a resolver per pass
 * would read its own writes.
 */
export function criarResolvedorDePublicacao(
  deps: PublicarAnuncioDeps,
  produtoId: string,
): ResolvedorDeImagensShopee {
  return criarResolvedorDeImagens({
    db: deps.db,
    integracaoId: deps.integracaoId,
    produtoId,
    // ⚠️ A FUNCTION, not a client: the photo unit stays testable with no client
    // double, and `upload_image` is Public-signed so nothing shop-scoped is
    // passed (the probe settled it; `signing` is the probe's seam alone).
    enviarImagem: (p) => deps.partnerClient().uploadImage(p),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.hostEmulador === undefined ? {} : { hostEmulador: deps.hostEmulador }),
  });
}

/**
 * Read the whole graph ONE publish needs.
 *
 * ⚠️ **It writes nothing**, and the proof is structural: {@link
 * PrepararPublicacaoDeps} reaches no writer, and the resolver it is handed is
 * never CALLED here (a test drives it with a resolver that throws).
 *
 * ⚠️ **`get_model_list` is never read here.** The live tier tree is read FRESH
 * inside `aplicarModelos`, immediately before `update_tier_variation` is built:
 * that call is a full-list replace, so a stale tree in the plan is the
 * omission-deletes defect.
 *
 * Two refusals are raised as early as they can be DECIDED — a variation child
 * (`paiId`) and a NATIVE Shopee kit ({@link kitNativoDoAnuncio}, step 19's
 * `add_kit_item`). ⚠️ That is after the link read rather than before it, because
 * the kit arm's authority on a republish is the link's `kitNativo` (what Shopee
 * itself reported), so deciding earlier would mean deciding on the produto's
 * `ehKit` — the step-11 defect that made the whole legacy kit catalogue
 * unpublishable. The cost is ONE document read on a refused publish; the photo
 * resolver, the channel list and the taxonomy are all still untouched.
 * `montarAnuncio` produces both refusals again from the same fields, so the plan
 * is consistent either way; raising here is what stops a refused publish paying
 * for a channel list and a picture upload.
 *
 * @returns `null` when this conta has nothing to publish onto — the produto does
 *   not exist, or a `linkDocId` was named and does not belong to this conta.
 *   Both are the route's **404**.
 */
export async function prepararPublicacao(
  deps: PrepararPublicacaoDeps,
  entrada: EntradaDePublicacao,
  resolvedorDeImagens: ResolvedorDeImagensShopee,
): Promise<ContextoPublicacao | null> {
  const db = deps.db;
  const produtoSnap = await produtoCollection.docRef(db, {}, entrada.produtoId).get();
  if (!produtoSnap.exists) return null;
  const raw = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  const produto = produtoParaPublicar(entrada.produtoId, raw);

  const linkResolvido = await resolverLinkPorProduto(
    db,
    deps.integracaoId,
    entrada.produtoId,
    entrada.linkDocId ?? null,
  );
  const link =
    linkResolvido === null
      ? null
      : linkListagemLido(linkResolvido.raw, linkResolvido.estadoAnuncio);

  // The kit arm reads the LINK, so this cannot run before the resolver — see the
  // function's docblock. It still runs before every other read and before the
  // first Shopee call, and it keeps its precedence over the 404 below: a produto
  // that may never be published this way is told so, whichever linkDocId the
  // caller named.
  recusarProdutoNaoPublicavel(produto, link);

  // A named link that resolves to nothing is a 404, not a first publish: the
  // conta filter runs FIRST inside the resolver, so an id can only ever narrow
  // within what this conta already owns.
  if (linkResolvido === null && textoUtilizavel(entrada.linkDocId) !== null) return null;

  const ehAtualizacao = link !== null && link.item_id !== null;

  const descricao = await lerDescricao(db, entrada.produtoId);
  const filhosCrus = await lerFilhos(db, entrada.produtoId);
  const linksDeVariacao = await lerLinksDeVariacao(db, deps.integracaoId, entrada.produtoId);
  const grupos = await lerGrupos(db, filhosCrus);

  /* ---- estoque: the produto, every child, and every kit COMPONENT of both. -- */
  const disponivelByProdutoId: Record<string, number | null | undefined> = {};
  for (const componenteId of idsDeComponentes(produto, filhosCrus)) {
    const linha = await lerLinhaDeEstoque(db, componenteId, deps.depositoOuterRef);
    disponivelByProdutoId[componenteId] = linha === null ? 0 : chao(estoqueDisponivel(linha));
  }
  const linhaDoPai = await lerLinhaDeEstoque(db, entrada.produtoId, deps.depositoOuterRef);
  // ⚠️ The produto's OWN availability, NOT the kit fold: `montarAnuncio` applies
  // `quantidadeParaPublicarShopee`, which folds the components itself. Folding
  // here too would be two copies of that rule.
  const ownDisponivel = linhaDoPai === null ? 0 : chao(estoqueDisponivel(linhaDoPai));

  const tabelaNormalId = idDeRef(deps.tabelaNormalOuterRef);
  const filhos = await Promise.all(
    filhosCrus.map((filho) =>
      filhoParaPublicar(db, deps, filho, tabelaNormalId, linksDeVariacao, disponivelByProdutoId),
    ),
  );

  /* ---- taxonomy: the leaf gate, the bands, the attributes. ----------------- */
  const categoryId = link?.category_id ?? entrada.categoryId ?? null;
  const indice = await deps.categorias.carregar();
  const veredictoFolha = categoryId === null ? 'desconhecida' : ehFolha(indice, categoryId);
  const limites: LimitesDeItemLidos = await lerLimitesDeItem(deps.taxonomia, categoryId);
  // ⚠️ The attribute tree is gated on the LEAF verdict: `get_attribute_tree`
  // answers nothing usable for a non-leaf, and `montarAnuncio` refuses such a
  // category with `categoria-invalida` anyway — so the call is skipped rather
  // than spent.
  const atributos: AtributosProjetados =
    categoryId !== null && veredictoFolha === 'folha'
      ? projetarAtributos((await lerAtributos(deps.taxonomia, categoryId)).atributos)
      : { atributos: [], truncated: false };

  const marca = await resolverMarcaDoAnuncio(deps, link, linkResolvido?.raw ?? null, categoryId);

  /* ---- the shop's channels, UNCACHED: a stale list enables a dead channel. - */
  const canais = await lerCanaisDaLoja(deps.client);

  const imposto = await criarLeitorDeImpostoShopee({
    db,
    operacaoOuterRef: deps.operacaoOuterRef,
  }).ler(entrada.produtoId);

  return {
    integracaoId: deps.integracaoId,
    produto,
    descricao,
    filhos,
    grupos,
    link,
    linkDocId: linkResolvido?.linkDocId ?? null,
    linksDeVariacao,
    limites,
    atributos,
    veredictoFolha,
    categoryId: entrada.categoryId ?? null,
    marca,
    canais,
    imposto,
    resolvedorDeImagens,
    ehAtualizacao,
    statusPedido: entrada.statusPedido,
    tabelaNormalId,
    ownDisponivel,
    disponivelByProdutoId,
    nowMs: deps.nowMs,
  };
}

/**
 * The two refusals that are about the PRODUTO (and, for the kit one, about the
 * listing it already has) rather than about a field of the payload.
 *
 * ⚠️ **`ehKit` does not appear here** — corrected in step 12 (#1520). The ERP's
 * `ehKit` produtos publish as ordinary Shopee listings and there are thousands
 * of them; only a NATIVE Shopee kit is refused, and {@link kitNativoDoAnuncio}
 * is the ONE predicate that decides it, shared with `montarAnuncio` so the two
 * producers of `produto-e-kit` cannot drift apart.
 *
 * `campo` names the field the operator must look at, and it therefore follows
 * the arm the predicate took: the link's `kitNativo` on a republish, the
 * produto's `ehKitVirtual` on a first publish. Both spellings are pinned by
 * tests, because nothing in the type system ties a label to a branch.
 */
function recusarProdutoNaoPublicavel(
  produto: ProdutoParaPublicar,
  link: LinkListagemLido | null,
): void {
  const problemas: ProblemaDeBloqueio[] = [];
  if (produto.paiId !== null) {
    problemas.push({
      campo: 'paiId',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
      mensagem:
        `o produto ${produto.id} é uma variação de ${produto.paiId} — publique o produto PAI, ` +
        'que leva as variações como modelos',
    });
  }
  if (kitNativoDoAnuncio(link, produto)) {
    problemas.push({
      campo: link !== null ? 'kitNativo' : 'ehKitVirtual',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
      mensagem:
        `o anúncio do produto ${produto.id} é um kit NATIVO da Shopee — ` +
        'a Shopee cria kits por add_kit_item, não por add_item',
    });
  }
  if (temProblemaDeBloqueio(problemas)) {
    throw new ShopeePublishBlockedError({ produtoId: produto.id, itemId: null, problemas });
  }
}

async function lerDescricao(db: Firestore, produtoId: string): Promise<string | null> {
  const snap = await produtoExtraDataCollection.docRef(db, { produtoId }, 'singleton').get();
  if (!snap.exists) return null;
  return textoOuNull((snap.data() ?? {}).descricao);
}

interface FilhoCru {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

/**
 * The variation children.
 *
 * The same `produtos (paiId == …)` query `resolveProduto.ts`'s `jaTemFilhos`
 * already runs, so its index cost is paid and no new composite is needed.
 */
async function lerFilhos(db: Firestore, produtoPaiId: string): Promise<readonly FilhoCru[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', produtoPaiId).get();
  return snap.docs.map((d) => ({
    id: d.id,
    raw: (d.data() ?? {}) as Record<string, unknown>,
  }));
}

/** Every kit component id whose availability a quantity decision reads. */
function idsDeComponentes(
  produto: ProdutoParaPublicar,
  filhos: readonly FilhoCru[],
): readonly string[] {
  const ids = new Set<string>();
  const junte = (componentes: ComponentesKit | null): void => {
    for (const id of Object.keys(componentes ?? {})) ids.add(id);
  };
  if (produto.ehKit || produto.ehKitVirtual) junte(produto.componentesKit);
  for (const filho of filhos) {
    if (!booleano(filho.raw.ehKit) && !booleano(filho.raw.ehKitVirtual)) continue;
    junte(componentesDeProduto(filho.raw.componentesKit));
  }
  return [...ids];
}

/** Floor at zero: a negative availability is a real defect and an unsendable quantity. */
function chao(valor: number): number {
  return Math.max(Math.floor(valor), 0);
}

/**
 * One child, projected for the tier mapper.
 *
 * ⚠️ `estoque` is the child's AVAILABLE quantity and is NOT clamped to the
 * shop's band here: `montarTiers` refuses a child below `stockLimit.min` and
 * clamps one above `stockLimit.max`, and a second clamp here would hide the
 * refusal. It IS floored at zero, because a negative `seller_stock` is not a
 * body Shopee accepts and `0 < min` still refuses.
 */
async function filhoParaPublicar(
  db: Firestore,
  deps: PrepararPublicacaoDeps,
  filho: FilhoCru,
  tabelaNormalId: string | null,
  links: readonly LinkDeVariacao[],
  disponivelByProdutoId: Record<string, number | null | undefined>,
): Promise<FilhoParaPublicar> {
  const linha = await lerLinhaDeEstoque(db, filho.id, deps.depositoOuterRef);
  const proprio = linha === null ? 0 : estoqueDisponivel(linha);
  const componentes = componentesDeProduto(filho.raw.componentesKit);
  const ehKit = booleano(filho.raw.ehKit) || booleano(filho.raw.ehKitVirtual);
  // The SAME fold `quantidadeParaPublicarShopee` applies at item level —
  // `kitEstoqueDisponivel(...) ?? own`, never the additive reading — so the item
  // and its models cannot disagree about what a kit has.
  const derivado = ehKit ? kitEstoqueDisponivel(componentes, disponivelByProdutoId) : null;
  const link = links.find((l) => l.produtoId === filho.id) ?? null;

  return {
    produtoId: filho.id,
    sku: textoOuNull(filho.raw.sku),
    gtin: textoOuNull(filho.raw.gtin),
    ordem: ordemDeProduto(filho.raw.ordem),
    variacoesUid: listaDeTextos(filho.raw.variacoesUid),
    preco:
      tabelaNormalId === null
        ? null
        : numeroOuNull(precosDeProduto(filho.raw.precos)?.[tabelaNormalId]?.valor),
    estoque: chao(derivado ?? proprio),
    fotos: fotosDeProduto(filho.raw.fotos).fotos,
    linkModelId: link?.modelId ?? null,
    linkDocId: link?.linkDocId ?? null,
    tierIndexArmazenado: link === null ? null : link.tierIndex,
  };
}

/**
 * Every `grupoDeVariacoes` the children reference, read once.
 *
 * ⚠️ A variante's `ordem` is its INDEX inside `grupo.variacoes` — the legacy
 * wire rule (`models.dart:2034-2057`: groups by `ordem`, variants by their
 * position in the array). The array order IS the operator's order; a stored
 * per-variante `ordem` field does not exist.
 */
async function lerGrupos(
  db: Firestore,
  filhos: readonly FilhoCru[],
): Promise<readonly GrupoParaTier[]> {
  const ids: string[] = [];
  for (const filho of filhos) {
    for (const caminho of listaDeTextos(filho.raw.variacoesUid)) {
      const parsed = parseFakePath(caminho);
      if (parsed !== null && !ids.includes(parsed.grupoId)) ids.push(parsed.grupoId);
    }
  }

  const grupos: GrupoParaTier[] = [];
  for (const grupoId of ids) {
    const snap = await grupoDeVariacoesCollection.docRef(db, {}, grupoId).get();
    if (!snap.exists) {
      console.warn('[shopee/anuncios] grupo de variações ausente ao preparar a publicação', {
        grupoId,
      });
      continue;
    }
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    const variacoes: VarianteDoTier[] = [];
    const brutas = Array.isArray(raw.variacoes) ? (raw.variacoes as readonly unknown[]) : [];
    brutas.forEach((bruta, indice) => {
      const linha = (bruta ?? {}) as Record<string, unknown>;
      const varianteId = textoUtilizavel(linha.id);
      const nome = textoUtilizavel(linha.nome);
      if (varianteId === null || nome === null) return;
      variacoes.push({ varianteId, nome, ordem: indice });
    });
    grupos.push({
      grupoId,
      nome: textoOuNull(raw.nome) ?? grupoId,
      ordem: numeroOuNull(raw.ordem) ?? ORDEM_AUSENTE,
      permiteFotos: booleano(raw.permiteFotos),
      variacoes,
      linksVariacoesShopee: Array.isArray(raw.linksVariacoesShopee)
        ? (raw.linksVariacoesShopee as readonly unknown[])
        : null,
    });
  }
  return grupos;
}

/**
 * The shop's logistics channels, read UNCACHED once per publish.
 *
 * ⚠️ Deliberately not behind a TTL cache: a stale list would enable a channel
 * the shop turned off minutes ago, and the failure is a listing the seller
 * cannot ship. The per-element `null` sentinel is filtered here — one unreadable
 * channel must not cost the whole build.
 */
async function lerCanaisDaLoja(client: ShopeeClient): Promise<readonly ShopeeLogisticsChannel[]> {
  const lista = await client.getChannelList();
  return lista.logistics_channel_list.filter((c): c is ShopeeLogisticsChannel => c !== null);
}

/** The last path segment of an outerRef, through the SHARED fold. */
function idDeRef(ref: string | null): string | null {
  if (ref === null) return null;
  const { id } = parseRef(ref);
  return id.length > 0 ? id : null;
}

/**
 * C17's brand cascade, in rungs, with the cheap rungs first.
 *
 *  1. `brand_id === 0` ⇒ **no read at all**. Shopee's own "No Brand" is a
 *     CHOICE, and `montarAnuncio` supplies its wire name — so this module never
 *     spells that literal and never spends a call on it.
 *  2. the link's stored `original_brand_name`, written by every read-back. Zero
 *     cost on a republish.
 *  3. a BOUNDED `get_brand_list` walk of the item's category
 *     (≤ {@link MAX_PAGINAS_MARCAS} pages), through step 10's TTL cache.
 *  4. `nome: null` — `montarAnuncio` then refuses a CREATE (`marca-sem-nome`)
 *     and OMITS the whole `brand` object on an update, which destroys nothing
 *     because `update_item` is field-wise.
 *
 * ⚠️ `integracao/{id}/brandshopee` is NEVER read: its schema is
 * `z.object({}).passthrough()`, so a name taken out of it is an undeclared key,
 * and it stays the curated registration shortlist with no reader.
 */
async function resolverMarcaDoAnuncio(
  deps: PrepararPublicacaoDeps,
  link: LinkListagemLido | null,
  raw: Record<string, unknown> | null,
  categoryId: number | null,
): Promise<{ readonly brandId: number; readonly nome: string | null }> {
  // ⚠️ The SAME `??` cascade `montarAnuncio` applies, so the id whose name is
  // resolved here is the id that goes out on the wire.
  const brandId = link?.brand_id ?? 0;
  if (brandId === 0) return { brandId: 0, nome: null };

  const armazenado = textoUtilizavel(raw?.original_brand_name);
  if (armazenado !== null) return { brandId, nome: armazenado };

  if (categoryId === null) return { brandId, nome: null };

  let offset = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS_MARCAS; pagina += 1) {
    const pag = await lerMarcasCached(deps.taxonomia, {
      categoryId,
      status: SHOPEE_BRAND_STATUS.normal,
      offset,
      pageSize: SHOPEE_BRAND_MAX_PAGE_SIZE,
    });
    const achada = pag.brand_list.find((m) => m.brand_id === brandId);
    if (achada !== undefined) return { brandId, nome: achada.original_brand_name };
    // ⚠️ Shopee's own cursor, VERBATIM — never `offset + pageSize`, which is
    // what makes a mutating list skip rows.
    if (!pag.has_next_page || pag.next_offset === null) break;
    offset = pag.next_offset;
  }
  console.warn('[shopee/anuncios] marca não resolvida no catálogo da categoria', {
    integracaoId: deps.integracaoId,
    categoryId,
    brandId,
    paginas: MAX_PAGINAS_MARCAS,
  });
  return { brandId, nome: null };
}

/* -------------------------------------------------------------------------- */
/*                                    fotos                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every picture this publish sends, through the ONE resolver.
 *
 * The ITEM pass first (cap `SHOPEE_ITEM_IMAGE_MAX`, in render ORDER — Shopee
 * renders `image_id_list` positionally, so the list is never re-sorted), then
 * the tier-1 option passes at `cap: 1`.
 *
 * ⚠️ **Zero usable pictures is NOT an error here.** The resolver answers an
 * empty list, `montarAnuncio` turns that into the `sem-fotos` refusal, and the
 * applier throws `ShopeePublishBlockedError` before `add_item` — so the operator
 * gets a body naming every refusal instead of one that stops at "no pictures".
 */
export async function resolverFotosDaPublicacao(
  contexto: ContextoPublicacao,
): Promise<FotosResolvidas> {
  const resolvedor = contexto.resolvedorDeImagens;
  const item = await resolvedor.resolver(contexto.produto.fotos);
  const imagensDeOpcao = await resolverImagensDeOpcao(contexto, resolvedor);
  return { item, imagensDeOpcao, resumo: resolvedor.resumo() };
}

/** Which variante of `grupoId` one child occupies, from its fake paths. */
function varianteDoFilhoNoGrupo(filho: FilhoParaPublicar, grupoId: string): string | null {
  for (const caminho of filho.variacoesUid) {
    const parsed = parseFakePath(caminho);
    if (parsed !== null && parsed.grupoId === grupoId) return parsed.varianteId;
  }
  return null;
}

/**
 * The tier-1 option images — ALL-OR-NONE, and keyed by variante IDENTITY.
 *
 * Every picture is located BEFORE the first upload, so a variante with no
 * picture costs zero calls. The map's key is `varianteFakePath(grupoId,
 * varianteId)`, not a position, so it survives the tier re-ordering a fresh
 * `get_model_list` may impose; `montarTiers` re-applies all-or-none defensively,
 * so a partial map yields no image on any option.
 *
 * ⚠️ The tier-1 grupo is chosen from the CREATE order (`ordenarTiers` with no
 * live tree), because `preparar` reads no `get_model_list`. On a republish whose
 * live tree puts a different grupo first, the uploaded ids simply go unused —
 * the cost is an upload, paid once, since every id lands in
 * `arquivos.externalIds`.
 */
async function resolverImagensDeOpcao(
  contexto: ContextoPublicacao,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<ReadonlyMap<string, string> | null> {
  if (contexto.filhos.length === 0) return null;
  const [tier1] = ordenarTiers(contexto.grupos, null);
  if (tier1 === undefined || !tier1.permiteFotos) return null;

  const pares: { readonly chave: string; readonly foto: Foto }[] = [];
  for (const variante of tier1.variacoes) {
    const usada = contexto.filhos.some(
      (f) => varianteDoFilhoNoGrupo(f, tier1.grupoId) === variante.varianteId,
    );
    if (!usada) continue;
    const foto = fotoDaOpcaoDeTier(
      variante,
      tier1.grupoId,
      contexto.filhos,
      contexto.produto.fotos,
    );
    // ALL-OR-NONE, decided before anything is sent.
    if (foto === null) return null;
    pares.push({ chave: varianteFakePath(tier1.grupoId, variante.varianteId), foto });
  }
  if (pares.length === 0) return null;

  const mapa = new Map<string, string>();
  for (const par of pares) {
    const resultado = await resolvedor.resolver([par.foto], { cap: 1 });
    const imageId = resultado.imageIds[0] ?? null;
    if (imageId === null) return null;
    mapa.set(par.chave, imageId);
  }
  return mapa;
}

/* -------------------------------------------------------------------------- */
/*                         the item write + the C13 retry                      */
/* -------------------------------------------------------------------------- */

/** What one item write answered, plus what it cost and what it gave up. */
interface EnvioDeItem {
  readonly resposta: ShopeeItemWriteResponse;
  readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  readonly chamadas: number;
}

/** A body with the BR fiscal block removed — the retry's whole mechanism. */
function semBlocoFiscal<B extends { readonly tax_info?: ShopeeTaxInfoRequest }>(
  corpo: B,
): Omit<B, 'tax_info'> {
  const { tax_info: _descartado, ...resto } = corpo;
  return resto;
}

/**
 * Is this the BR all-or-nothing refusal, on a body that HAD the block?
 *
 * ⚠️ The four conditions are the whole bound (C13). The last one — the body
 * still carrying a `tax_info` key — is what makes the retry **bounded by
 * CONSTRUCTION**: the retried body has no such key, so the identical refusal
 * cannot be retried a second time. A counter would be a second mechanism able to
 * disagree with the first.
 */
function ehRecusaDoBlocoFiscal(
  err: unknown,
  corpo: { readonly tax_info?: ShopeeTaxInfoRequest },
): err is ShopeeApiError {
  if (!(err instanceof ShopeeApiError)) return false;
  // The ONE prefix stripper lives in the package; both spellings of the code are
  // real and Shopee prints them on the same page.
  const nu = shopeeCodeSemPrefixoDeModulo(err.code);
  if (err.code !== 'error_param' && nu !== 'error_param') return false;
  if (!err.message.includes(FRASE_TAX_INFO_INCOMPLETO)) return false;
  return corpo.tax_info !== undefined;
}

/**
 * Send the item body, retrying ONCE without `tax_info` on the BR
 * all-or-nothing refusal (C13, frozen).
 *
 * The retry omits the WHOLE key — never a modified block: Shopee's BR fiscal
 * block is all-or-nothing, so a partial one is a second refusal and a repaired
 * one is a guess about the seller's own fiscal configuration.
 */
async function enviarItemComRetentativaFiscal<
  B extends { readonly tax_info?: ShopeeTaxInfoRequest },
>(
  enviar: (corpo: B | Omit<B, 'tax_info'>) => Promise<ShopeeItemWriteResponse>,
  corpo: B,
  alvo: { readonly produtoId: string; readonly etapa: EtapaPublicacao },
): Promise<EnvioDeItem> {
  try {
    return { resposta: await enviar(corpo), taxInfoOmitido: null, chamadas: 1 };
  } catch (err) {
    if (!ehRecusaDoBlocoFiscal(err, corpo)) throw err;
    console.warn('[shopee/anuncios] tax_info recusado; reenviando sem o bloco', {
      produtoId: alvo.produtoId,
      etapa: alvo.etapa,
    });
    return {
      resposta: await enviar(semBlocoFiscal(corpo)),
      taxInfoOmitido: MOTIVO_TAX_INFO_OMITIDO.recusadoIncompleto,
      chamadas: 2,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                               the write-backs                               */
/* -------------------------------------------------------------------------- */

type CorpoDeItem = ShopeeAddItemRequest | ShopeeUpdateItemRequest;

/**
 * Write-back #1 — the §2.4 field set, AS SENT, the instant Shopee confirms.
 *
 * `merge`/`add` through `aplicarLinkDaListagem`, never `mergeIfExists`:
 * `ultimaPublicacao` is a NESTED object and `mergeIfExists` is `update()`, which
 * throws on one (C15) — and a first publish must CREATE the document anyway.
 *
 * ⚠️ `publicadoEm` is written on the FIRST success only. A republish leaves the
 * stored value alone, so the field keeps meaning "when this listing first went
 * out" rather than "when it was last touched" — `ultimaPublicacao.em` is that.
 */
async function escreverWriteBack1(
  deps: PublicarAnuncioDeps,
  args: {
    readonly produtoId: string;
    readonly linkDocId: string | null;
    readonly armazenado: Record<string, unknown>;
    readonly itemId: number;
    readonly corpo: CorpoDeItem;
    readonly etapa: EtapaPublicacao;
    readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  },
): Promise<string> {
  const { armazenado, corpo } = args;
  const dados: Record<string, unknown> = {
    // Always canonical, never the stored value — the conta filter every reader
    // applies is this field.
    contaProdutoShopeeOuterRef: toOuterRef(integracaoCollection.docPath({}, deps.integracaoId)),
    item_id: args.itemId,
    ...(corpo.item_name === undefined ? {} : { item_name: corpo.item_name }),
    ...(corpo.description === undefined ? {} : { description: corpo.description }),
    ...(corpo.category_id === undefined ? {} : { category_id: corpo.category_id }),
    ...(corpo.condition === undefined ? {} : { condition: corpo.condition }),
    ...(corpo.attribute_list === undefined ? {} : { attributes: corpo.attribute_list }),
    ...(corpo.logistic_info === undefined ? {} : { logistic_info: corpo.logistic_info }),
    ...(corpo.brand === undefined ? {} : { brand_id: corpo.brand.brand_id }),
    taxInfoOmitido: args.taxInfoOmitido,
    ultimaPublicacao: { em: deps.nowMs, etapa: args.etapa, itemId: args.itemId },
    ultimaModificacao: deps.nowMs,
    ...(numeroOuNull(armazenado.publicadoEm) === null ? { publicadoEm: deps.nowMs } : {}),
    ...(numeroOuNull(armazenado.dataCadastro) === null ? { dataCadastro: deps.nowMs } : {}),
  };

  return await aplicarLinkDaListagem(deps.db, args.produtoId, {
    acao: args.linkDocId === null ? 'add' : 'merge',
    docId: args.linkDocId,
    dados,
  });
}

/**
 * Write-back #2 — everything that comes from the READ-BACK, and nothing else.
 *
 * ⚠️ Every value here was READ from `get_item_base_info` (O5). `item_status` in
 * particular is never the request's and never the echo's: the probe measured
 * `update_item` echoing a stale status while the read-back answered the live one.
 */
async function escreverWriteBack2(
  deps: PublicarAnuncioDeps,
  args: {
    readonly produtoId: string;
    readonly linkDocId: string;
    readonly item: ItemLido;
    readonly estado: EstadoAnuncioShopee;
    readonly deboost: boolean;
  },
): Promise<void> {
  const base = args.item.base;
  await aplicarLinkDaListagem(deps.db, args.produtoId, {
    acao: 'merge',
    docId: args.linkDocId,
    dados: {
      item_status: itemStatusDeLink(args.item),
      estadoAnuncio: args.estado,
      deboost: args.deboost,
      original_brand_name: base.brand?.original_brand_name ?? null,
      logistic_info: base.logistic_info,
      // A publish that got this far SUCCEEDED; leaving the last failure standing
      // would make the operator's panel lie about the current state.
      falhaPublicacao: null,
      ultimaModificacao: deps.nowMs,
    },
  });
}

/**
 * The failure stamp — and it stamps only once WRITES HAVE BEGUN.
 *
 * On a create that failed at `add_item` there is no link document, so there is
 * nothing to stamp and nothing is created: a link that does not exist cannot be
 * a ghost, while an invented one would be a listing record for a listing that
 * was never made.
 *
 * ⚠️ A failure of the stamp itself is NOT caught. Swallowing it would need
 * exactly the generic catch root `CLAUDE.md` rule 6 bans, and the two things
 * that can fail it — a Firestore outage and a patch that does not validate — are
 * both worth surfacing on their own.
 */
/**
 * The problemas the stamp stores — the ERROR'S OWN list whenever it has one.
 *
 * ⚠️ `problemasDeErroShopee` answers `[]` for anything that is not a
 * `ShopeeApiError`, and the two classes that already CARRY a populated list are
 * exactly those two: the re-list refusal (`relistar`, both doors refusing) and a
 * block raised from the FRESH tree by the model leg. Reading only the classifier
 * made the stamp contradict its own `mensagem` — "1 problema" beside an empty
 * `problemas[]` — and dropped the only text that names WHICH field or which tier
 * position failed, which is all the operator has to act on.
 */
function problemasDaFalha(err: ShopeeError): readonly ProblemaPublicacao[] {
  if (err instanceof ShopeePublishRejectedError) return err.problemas;
  if (err instanceof ShopeePublishBlockedError) return err.problemas;
  return problemasDeErroShopee(err);
}

/**
 * What the stamp's `erro` field carries: Shopee's own code whenever there is
 * one, so the row can be looked up and grouped by it, and the class name only
 * when the failure is ours. ⚠️ A `ShopeePublishRejectedError` HAS the code — in
 * `shopeeCode` — and storing its class name instead left the code reachable only
 * by reading the `mensagem` prose.
 */
function codigoDaFalha(err: ShopeeError): string {
  if (err instanceof ShopeeApiError) return err.code;
  if (err instanceof ShopeePublishRejectedError) return err.shopeeCode;
  return err.name;
}

async function carimbarFalhaDePublicacao(
  deps: PublicarAnuncioDeps,
  args: {
    readonly produtoId: string;
    readonly linkDocId: string | null;
    readonly itemId: number | null;
    readonly etapa: EtapaPublicacao;
    readonly erro: string;
    readonly mensagem: string;
    readonly problemas: readonly ProblemaPublicacao[];
  },
): Promise<void> {
  if (args.linkDocId === null) {
    console.warn('[shopee/anuncios] falha antes de qualquer vínculo; nada a carimbar', {
      produtoId: args.produtoId,
      etapa: args.etapa,
      erro: args.erro,
    });
    return;
  }
  await aplicarLinkDaListagem(deps.db, args.produtoId, {
    acao: 'merge',
    docId: args.linkDocId,
    dados: {
      falhaPublicacao: {
        em: deps.nowMs,
        etapa: args.etapa,
        erro: args.erro,
        mensagem: limitarMensagemProblema(args.mensagem),
        // ⚠️ `campo` is a REQUIRED non-nullable string on the link schema while a
        // problema's is `string | null`, so a field-less refusal stores `''`.
        // The information the operator acts on is `mensagem`, which is kept whole.
        problemas: args.problemas.map((p) => ({
          campo: p.campo ?? '',
          motivo: p.motivo,
          mensagem: p.mensagem,
        })),
      },
      ultimaModificacao: deps.nowMs,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 relistagem                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ONE refusal that earns the second door.
 *
 * ⚠️ `pausarAnuncio.ts` holds a private twin of this token for its own
 * `reativar` fallback. Neither module exports it, and de-duplicating them is one
 * import in a later pass — recorded rather than silently duplicated.
 */
const TOKEN_RELISTAGEM_RECUSADA = 'error_set_normal_unlisted_item';

/** A bare Shopee code at the START of a refusal sentence. */
const RE_CODIGO_ANCORADO = /^error_[a-z0-9_]*/;

/**
 * The code inside a `failure_list[].failed_reason`, which is a SENTENCE
 * embedding one.
 *
 * `''` when the sentence names none: `shopeeCode` is a CODE field and inventing
 * a plausible-looking one would be worse than saying Shopee gave us none. The
 * prose still reaches the operator through the problema's `mensagem`.
 */
function codigoDaRecusa(reason: string | null | undefined): string {
  const bruto = (reason ?? '').trim();
  if (bruto === '') return '';
  const semPrefixo = shopeeCodeSemPrefixoDeModulo(bruto) ?? bruto;
  return RE_CODIGO_ANCORADO.exec(semPrefixo)?.[0] ?? '';
}

/**
 * ⚠️ A **substring** test, because `failed_reason` is a SENTENCE embedding the
 * code token, and over the prefix-STRIPPED text, because Shopee prints
 * `error_param` and `product.error_param` on the same page.
 */
function ehRelistagemRecusada(texto: string | null | undefined): boolean {
  if (typeof texto !== 'string') return false;
  const semPrefixo = shopeeCodeSemPrefixoDeModulo(texto) ?? texto;
  return semPrefixo.includes(TOKEN_RELISTAGEM_RECUSADA);
}

/** One door's verdict. */
type VerdictoDaPorta =
  | { readonly kind: 'ok'; readonly aviso: string | null }
  | {
      readonly kind: 'recusada';
      readonly codigo: string;
      readonly mensagem: string;
      readonly outraPorta: boolean;
    };

/**
 * `unlist_item { unlist: false }` — the documented re-list (`guide 221 §6`), and
 * the probe confirmed it re-lists a seller-created `UNLIST`.
 *
 * ⚠️ Per-entry verdicts are DATA: a valid request answers 200 even when the
 * entry was refused, so `failure_list` is read rather than "no throw" being
 * taken for success. A whole-call failure propagates untouched — the applier
 * stamps it — EXCEPT an envelope error that classifies as the re-list refusal,
 * which is that refusal for every id of the call and therefore earns the second
 * door.
 */
async function portaUnlist(client: ShopeeClient, itemId: number): Promise<VerdictoDaPorta> {
  try {
    const res = await client.unlistItem({ item_list: [{ item_id: itemId, unlist: false }] });
    const aviso = avisoDeShopee(res.warning);
    if (res.response.success_list.some((l) => l.item_id === itemId)) return { kind: 'ok', aviso };
    const recusa = res.response.failure_list.find((l) => l.item_id === itemId);
    const reason = recusa?.failed_reason ?? null;
    return {
      kind: 'recusada',
      codigo: codigoDaRecusa(reason),
      mensagem:
        reason ?? 'unlist_item não reportou este item_id nem em success_list nem em failure_list.',
      outraPorta: ehRelistagemRecusada(reason),
    };
  } catch (err) {
    // ⚠️ `ShopeeRateLimitError` EXTENDS `ShopeeApiError`, so it is excluded
    // explicitly: a burst limit is a transient the caller must see, never a
    // per-entry refusal.
    if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
      if (ehRelistagemRecusada(err.code)) {
        return { kind: 'recusada', codigo: err.code, mensagem: err.message, outraPorta: true };
      }
    }
    throw err;
  }
}

/**
 * `update_item { item_id, item_status: 'NORMAL' }` — the fallback door, and the
 * ONLY `item_status` this module ever sends.
 *
 * ⚠️ The body carries **nothing else**: a status bundled with other fields is
 * silently ignored on some listings.
 */
async function portaUpdateItem(client: ShopeeClient, itemId: number): Promise<VerdictoDaPorta> {
  try {
    const res = await client.updateItem({
      item_id: itemId,
      item_status: SHOPEE_ITEM_STATUS_WRITABLE.normal,
    });
    return { kind: 'ok', aviso: avisoDeShopee(res.warning) };
  } catch (err) {
    if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
      if (ehRelistagemRecusada(err.code)) {
        return { kind: 'recusada', codigo: err.code, mensagem: err.message, outraPorta: true };
      }
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   aplicar                                   */
/* -------------------------------------------------------------------------- */

/** Every etapa that is ALSO the trailing segment of a Shopee API path. */
const ETAPAS_QUE_SAO_OPERACOES: ReadonlySet<string> = new Set<string>(
  Object.values(ETAPA_PUBLICACAO),
);

/**
 * Which call a Shopee failure happened at, from the error's OWN path.
 *
 * ⚠️ Consulted for the tier/model leg ALONE, and that is the point:
 * `aplicarModelos` owns FIVE calls and answers one result, so the applier cannot
 * know which of them refused — while `err.path` does, and it is a string this
 * repo builds. Every other step is one call, so the applier's own cursor is
 * already exact; refining those would MIS-attribute the re-list fallback (whose
 * path segment is `update_item`) to the item write.
 *
 * A segment that is not an etapa member (`unlist_item`, `get_item_base_info`)
 * keeps the fallback.
 */
function etapaDaFalha(err: unknown, fallback: EtapaPublicacao): EtapaPublicacao {
  if (!(err instanceof ShopeeApiError)) return fallback;
  const segmento =
    err.path
      .split('/')
      .filter((s) => s.length > 0)
      .at(-1) ?? '';
  return ETAPAS_QUE_SAO_OPERACOES.has(segmento) ? (segmento as EtapaPublicacao) : fallback;
}

/** Collects the first non-noise envelope `warning` of a publish, in call order. */
class ColetorDeAviso {
  private primeiro: { readonly aviso: string; readonly etapa: EtapaPublicacao } | null = null;

  juntar(
    aviso: string | null,
    etapa: EtapaPublicacao,
    alvo: { produtoId: string; itemId: number | null },
  ): void {
    if (aviso === null || this.primeiro !== null) return;
    this.primeiro = { aviso, etapa };
    // ⚠️ The ETAPA and the ids only. An envelope `warning` is provider prose and
    // a log line in this app carries ids, counts, enum tokens and booleans — the
    // string itself reaches the operator through the RESULT.
    console.warn('[shopee/anuncios] a Shopee respondeu um warning na publicação', {
      produtoId: alvo.produtoId,
      itemId: alvo.itemId,
      etapa,
    });
  }

  valor(): string | null {
    return this.primeiro?.aviso ?? null;
  }
}

/**
 * Execute one plan, in EXACTLY the reconciler's §2.4 order.
 *
 *  1. the pictures — already resolved into the plan (`planoPublicacao.ts`'s
 *     header says why the upload precedes the plan);
 *  2. `add_item` | `update_item`, with the C13 one-shot fiscal retry;
 *  3. **parent write-back #1**, the instant Shopee confirms;
 *  4. `esperar(ESPERA_APOS_ADD_ITEM_MS)` — a create WITH children only;
 *  5–8. `aplicarModelos` (the fresh `get_model_list`, the tier/model writes, the
 *     reconciliation read and the child links);
 *  9. the re-list dance;
 * 10. the read-back through `lerAnuncioShopee`;
 * 11. **parent write-back #2**, from the read-back alone.
 *
 * ⚠️ The order is not a style: the wait exists because `init_tier_variation`
 * right after `add_item` fails on a listing Shopee has not finished indexing,
 * and write-back #1 precedes the tier leg because that is what makes a failure
 * in the tier leg RESUMABLE.
 *
 * ⚠️ **The PLAN is the whole input**, and the `ContextoPublicacao` §2.4 sketches
 * as a third parameter is deliberately not taken: everything the applier needs
 * is already on the plan, and a second graph beside it is a second source of
 * truth for values the plan states — exactly what "the plan as DATA" exists to
 * prevent. The three write-time facts that are NOT on the plan
 * (`publicadoEm`/`dataCadastro` first-time and the stored violation count) are
 * read from the link document itself, which is fresher than any context.
 */
export async function aplicarPublicacao(
  deps: PublicarAnuncioDeps,
  plano: PlanoPublicacao,
): Promise<ResultadoPublicacao> {
  if (temProblemaDeBloqueio(plano.problemas)) {
    throw new ShopeePublishBlockedError({
      produtoId: plano.produtoId,
      itemId: plano.itemId,
      problemas: plano.problemas,
    });
  }

  const produtoId = plano.produtoId;
  const avisos = new ColetorDeAviso();
  let etapa: EtapaPublicacao = plano.ehAtualizacao
    ? ETAPA_PUBLICACAO.updateItem
    : ETAPA_PUBLICACAO.addItem;
  let linkDocId = plano.linkDocId;
  let itemId = plano.itemId;
  let chamadasShopee = 0;

  // Read BEFORE the first write: the "first publish only" fields and the
  // violation count are decided from the document as it stands right now.
  const armazenado = await lerLinkArmazenado(deps.db, produtoId, linkDocId);

  try {
    /* ---- (2) the item write. -------------------------------------------- */
    const envio = await enviarItem(deps, plano);
    chamadasShopee += envio.chamadas;
    const corpo = envio.corpo;
    // ⚠️ The echo's `item_id` is an IDENTIFIER, not state — the one thing this
    // module ever takes from a write response (O5).
    itemId = plano.ehAtualizacao ? plano.itemId : envio.resposta.response.item_id;
    if (itemId === null || !Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new Error(
        `publicarAnuncioShopee: a Shopee confirmou a escrita do produto ${produtoId} sem um ` +
          `item_id utilizável (${JSON.stringify(envio.resposta.response.item_id)}).`,
      );
    }
    const taxInfoOmitido = envio.taxInfoOmitido ?? plano.taxInfoOmitido;
    avisos.juntar(avisoDeShopee(envio.resposta.warning), etapa, { produtoId, itemId });

    /* ---- (3) write-back #1. --------------------------------------------- */
    linkDocId = await escreverWriteBack1(deps, {
      produtoId,
      linkDocId,
      armazenado,
      itemId,
      corpo,
      etapa,
      taxInfoOmitido,
    });

    /* ---- (4) the wait — exactly when the plan says so. ------------------ */
    if (plano.passos.some((p) => p.tipo === 'esperar')) {
      await deps.esperar(ESPERA_APOS_ADD_ITEM_MS);
    }

    /* ---- (5-8) the tier/model leg, in ONE call. ------------------------- */
    etapa = ETAPA_PUBLICACAO.getModelList;
    const modelos = await aplicarModelos(deps, plano, itemId, linkDocId);
    // Every step of that leg IS one Shopee call — the derivation is the leg's
    // own `passos`, never a second count here.
    chamadasShopee += modelos.passos.length;
    for (const aviso of modelos.avisos) {
      avisos.juntar(aviso, ETAPA_PUBLICACAO.initTierVariation, { produtoId, itemId });
    }

    /* ---- (9) the re-list dance. ---------------------------------------- */
    etapa = ETAPA_PUBLICACAO.relistagem;
    const relistagem =
      plano.relistagem === null
        ? null
        : await relistar(deps, plano.relistagem, { produtoId, itemId }, avisos);
    if (relistagem !== null) chamadasShopee += relistagem.chamadas;

    /* ---- (10) the read-back — the ONLY state source. -------------------- */
    etapa = ETAPA_PUBLICACAO.leituraDeVolta;
    const leitura = await lerDeVolta(deps, itemId);
    chamadasShopee += leitura.chamadas;

    /* ---- (11) write-back #2 + the aviso resolver. ----------------------- */
    let estadoAnuncio: EstadoAnuncioShopee | null = null;
    let itemStatus: string | null = null;
    let deboost = false;
    let avisoResolvido = false;
    if (leitura.item !== null) {
      itemStatus = itemStatusDe(leitura.item);
      const fold = estadoDoAnuncio(
        {
          kind: 'lido',
          itemStatus,
          deboost: leitura.item.base.deboost,
          agendadoParaMs: agendadoParaMsDe(leitura.item.base.scheduled_publish_time),
        },
        deps.nowMs,
      );
      estadoAnuncio = fold.estado;
      deboost = fold.deboost;
      await escreverWriteBack2(deps, {
        produtoId,
        linkDocId,
        item: leitura.item,
        estado: fold.estado,
        deboost: fold.deboost,
      });

      // ⚠️ The publisher makes no `get_item_violation_info` call, so "no
      // violations" is the STORED reading — the strongest signal it holds. The
      // resolver answers a TRANSITION, so a produto with no open aviso simply
      // answers `false`.
      const normalizado =
        itemStatus === SHOPEE_ITEM_STATUS.normal &&
        !fold.deboost &&
        violacoesArmazenadas(armazenado) === 0;
      avisoResolvido = normalizado
        ? await resolverAvisoDeAnuncio(
            deps.db,
            { integracaoId: deps.integracaoId, produtoId },
            MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
            { nowMs: deps.nowMs },
          )
        : false;
    }

    const resultado: ResultadoPublicacao = {
      plano,
      produtoId,
      itemId,
      linkDocId,
      ehAtualizacao: plano.ehAtualizacao,
      estadoAnuncio,
      itemStatus,
      deboost,
      avisoShopee: avisos.valor(),
      modelos,
      fotos: plano.fotos.resumo,
      falhasDeFoto: plano.falhasDeFoto,
      taxInfoOmitido,
      relistagem: relistagem?.porta ?? null,
      avisoResolvido,
      leituraDeVolta: leitura.item !== null,
      chamadasShopee,
    };
    registrarPublicacao(deps, resultado);
    return resultado;
  } catch (err) {
    // ⚠️ The BASE class, and it is safe here for one reason: nothing is
    // swallowed. Every error rethrows; the narrow decides only whether a
    // `falhaPublicacao` stamp is worth writing, and a failure Shopee reported is
    // exactly the class an operator's panel has to show. A Firestore error is
    // NOT one — it would most likely fail the stamp too.
    if (err instanceof ShopeeError) {
      const problemas = problemasDaFalha(err);
      // The model leg is the ONE step whose exact call the applier cannot know;
      // everywhere else the cursor already is the call.
      const etapaReal = etapa === ETAPA_PUBLICACAO.getModelList ? etapaDaFalha(err, etapa) : etapa;
      await carimbarFalhaDePublicacao(deps, {
        produtoId,
        linkDocId,
        itemId,
        etapa: etapaReal,
        erro: codigoDaFalha(err),
        mensagem: err.message,
        problemas,
      });
      // A rate limit is excluded: it is a transient with its own HTTP mapping,
      // not a refusal of this publish.
      if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
        throw new ShopeePublishRejectedError({
          etapa: etapaReal,
          // VERBATIM, module prefix and all — the prefix says which page's error
          // list to read.
          shopeeCode: err.code,
          produtoId,
          itemId,
          problemas,
        });
      }
    }
    throw err;
  }
}

/**
 * The stored parent link document, read at APPLY time.
 *
 * ⚠️ One `get`, and it is not the one `preparar` paid for: `ContextoPublicacao`
 * carries the link PROJECTION (§2.8's frozen shape), which deliberately holds
 * only the fields the ITEM mapper reads. Three write-time decisions need the
 * document itself and none of them can be derived from that projection:
 * `publicadoEm` and `dataCadastro` are "first time only" (and `publicadoEm` may
 * legitimately be absent on a link step 9 IMPORTED, which is an update with no
 * first publish of ours), and the violation count decides whether the aviso
 * resolver runs. Reading it here rather than in `preparar` also makes those
 * decisions from the freshest reading there is.
 *
 * `{}` when there is no link yet — every "first time" test then answers true.
 */
async function lerLinkArmazenado(
  db: Firestore,
  produtoId: string,
  linkDocId: string | null,
): Promise<Record<string, unknown>> {
  if (linkDocId === null) return {};
  const snap = await produtoShopeeLinkCollection.docRef(db, { produtoId }, linkDocId).get();
  return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : {};
}

/**
 * How many violation rows the STORED link carries.
 *
 * ⚠️ The publisher makes no `get_item_violation_info` call (it is not in its
 * ownership row), so the stored list is the strongest evidence it holds. An
 * unreadable value counts as ZERO rows rather than blocking the resolver: the
 * resolver answers a TRANSITION, so at worst it closes a row a re-verify would
 * have closed anyway.
 */
function violacoesArmazenadas(raw: Record<string, unknown>): number {
  return Array.isArray(raw.violations) ? raw.violations.length : 0;
}

/** `add_item` or `update_item`, with the body that was actually sent. */
async function enviarItem(
  deps: PublicarAnuncioDeps,
  plano: PlanoPublicacao,
): Promise<EnvioDeItem & { readonly corpo: CorpoDeItem }> {
  if (!plano.ehAtualizacao) {
    const corpo = plano.item.criar;
    const envio = await enviarItemComRetentativaFiscal((c) => deps.client.addItem(c), corpo, {
      produtoId: plano.produtoId,
      etapa: ETAPA_PUBLICACAO.addItem,
    });
    return { ...envio, corpo: envio.taxInfoOmitido === null ? corpo : semBlocoFiscal(corpo) };
  }

  const corpo = plano.item.atualizar;
  if (corpo === null) {
    // Unreachable through `prepararPublicacao`, which only sets `ehAtualizacao`
    // when the stored `item_id` is a positive number — and that is exactly when
    // `montarAnuncio` builds the update body.
    throw new Error(
      `publicarAnuncioShopee: o plano do produto ${plano.produtoId} pede um update_item sem item_id.`,
    );
  }
  const envio = await enviarItemComRetentativaFiscal((c) => deps.client.updateItem(c), corpo, {
    produtoId: plano.produtoId,
    etapa: ETAPA_PUBLICACAO.updateItem,
  });
  return { ...envio, corpo: envio.taxInfoOmitido === null ? corpo : semBlocoFiscal(corpo) };
}

/**
 * Walk the re-list doors in the planned order.
 *
 * `RELIST_PRIMEIRO` decides the first door and the fallback is the other one.
 * **If both refuse there is no third attempt**: there is no other re-list API
 * for a BR shop item, so the publish is REJECTED at `relistagem` with the real
 * code.
 */
async function relistar(
  deps: PublicarAnuncioDeps,
  ordem: readonly OrdemDeRelistagem[],
  alvo: { readonly produtoId: string; readonly itemId: number },
  avisos: ColetorDeAviso,
): Promise<{ readonly porta: OrdemDeRelistagem; readonly chamadas: number }> {
  let chamadas = 0;
  let ultima: { readonly codigo: string; readonly mensagem: string } | null = null;

  for (const porta of ordem) {
    chamadas += 1;
    const verdicto =
      porta === 'unlist'
        ? await portaUnlist(deps.client, alvo.itemId)
        : await portaUpdateItem(deps.client, alvo.itemId);

    if (verdicto.kind === 'ok') {
      avisos.juntar(verdicto.aviso, ETAPA_PUBLICACAO.relistagem, alvo);
      return { porta, chamadas };
    }
    ultima = { codigo: verdicto.codigo, mensagem: verdicto.mensagem };
    if (!verdicto.outraPorta) break;
  }

  throw new ShopeePublishRejectedError({
    etapa: ETAPA_PUBLICACAO.relistagem,
    shopeeCode: ultima?.codigo ?? '',
    produtoId: alvo.produtoId,
    itemId: alvo.itemId,
    problemas: ultima === null ? [] : [problemaDeErroShopee(ultima.codigo, ultima.mensagem)],
  });
}

/**
 * The read-back — it DEGRADES, and never fails a publish that landed.
 *
 * `lerAnuncioShopee` raises `ShopeeImportBlockedError(item-nao-encontrado)` when
 * Shopee answers no row. At this point the item was just created or updated, so
 * that answer is eventual consistency, not a missing listing: the applier skips
 * write-back #2 and returns with the mechanism named. Turning a landed publish
 * into a 422 would tell the operator to fix a listing that exists.
 *
 * Everything else — a rate limit, a network failure, a schema mismatch —
 * propagates and is stamped: none of those is a property of this listing.
 */
async function lerDeVolta(
  deps: PublicarAnuncioDeps,
  itemId: number,
): Promise<{ readonly item: ItemLido | null; readonly chamadas: number }> {
  try {
    const item = await lerAnuncioShopee(deps.client, itemId);
    // ⚠️ The read-back is ONE call only for a plain listing. `lerAnuncioShopee`
    // spends a SECOND — `get_kit_item_info` for a kit, `get_model_list` for an
    // item with models — and both of its predicates read fields of the row that
    // decided it, so they answer the same here as they did there. A hardcoded
    // `1` made the publisher's `chamadasShopee` incomparable with the same figure
    // in `reverificarAnuncio.ts`, which counts per call.
    return { item, chamadas: ehKitDe(item.base) || temModelosDe(item) ? 2 : 1 };
  } catch (err) {
    if (!(err instanceof ShopeeImportBlockedError)) throw err;
    console.warn('[shopee/anuncios] leitura de volta não encontrou o anúncio recém-publicado', {
      itemId,
      motivo: err.motivo,
    });
    return { item: null, chamadas: 1 };
  }
}

/** ONE line per publish: ids, counts, enum tokens and booleans. */
function registrarPublicacao(deps: PublicarAnuncioDeps, r: ResultadoPublicacao): void {
  // eslint-disable-next-line no-console -- expected on every healthy publish; a warn nobody can act on is what hides the real ones
  console.info('[shopee/anuncios] publicação de anúncio', {
    integracaoId: deps.integracaoId,
    produtoId: r.produtoId,
    itemId: r.itemId,
    ehAtualizacao: r.ehAtualizacao,
    statusPedido: r.plano.statusPedido,
    statusInicial: r.plano.statusInicial,
    estadoAnuncio: r.estadoAnuncio,
    deboost: r.deboost,
    leituraDeVolta: r.leituraDeVolta,
    relistagem: r.relistagem,
    taxInfoOmitido: r.taxInfoOmitido,
    fotos: r.fotos,
    falhasDeFoto: r.falhasDeFoto.length,
    modelos: {
      acao: r.modelos.acao,
      total: r.modelos.total,
      criados: r.modelos.criados,
      repontados: r.modelos.repontados,
      atualizados: r.modelos.atualizados,
      marcados: r.modelos.marcados,
      semFilho: r.modelos.semFilho.length,
      desaparecidos: r.modelos.desaparecidos.length,
      ignorados: r.modelos.ignorados,
    },
    canaisPulados: r.plano.logistica.pulados.length,
    temAviso: r.avisoShopee !== null,
    avisoResolvido: r.avisoResolvido,
    chamadasShopee: r.chamadasShopee,
  });
}

/* -------------------------------------------------------------------------- */
/*                            publicarAnuncioShopee                            */
/* -------------------------------------------------------------------------- */

/**
 * Publish ONE produto: read, resolve the pictures, plan, then apply.
 *
 * @returns `null` when this conta has nothing to publish onto (the produto does
 *   not exist, or a named `linkDocId` is not this conta's) — the route's **404**.
 *   Every refusal is a throw: `ShopeePublishBlockedError` before the first write,
 *   `ShopeePublishRejectedError` for a wire refusal after writes began.
 */
export async function publicarAnuncioShopee(
  deps: PublicarAnuncioDeps,
  entrada: EntradaDePublicacao,
): Promise<ResultadoPublicacao | null> {
  const resolvedorDeImagens =
    deps.resolvedorDeImagens ?? criarResolvedorDePublicacao(deps, entrada.produtoId);
  const contexto = await prepararPublicacao(deps, entrada, resolvedorDeImagens);
  if (contexto === null) return null;

  // ⚠️ The pictures BEFORE the plan: `montarAnuncio` needs the real `image_id[]`
  // to build a body at all, and an empty list is the `sem-fotos` REFUSAL rather
  // than an error.
  const fotos = await resolverFotosDaPublicacao(contexto);
  const plano = planejarPublicacao(contexto, fotos);
  return await aplicarPublicacao(deps, plano);
}

/**
 * Re-exported for the CLI's dry run, which prints the PLAN and applies nothing.
 * One name, one implementation: a second import path is how a dry run starts
 * describing a different sequence from the one the publisher runs.
 */
export { planejarPublicacao };
export type { ContextoPublicacao, FotosResolvidas, PlanoPublicacao };
