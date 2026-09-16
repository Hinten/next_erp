/**
 * **The plan** of the Shopee listing import (#1517, step 9): everything the
 * importer has already READ (`PreparoImportacaoShopee`) → every write it is
 * going to make, as ORDERED DATA (`PlanoImportacaoShopee`). Nothing here
 * executes anything.
 *
 * Pure: no Firestore, no wire call, no ambient clock read and nothing from the
 * Next runtime. That is what makes the CLI's dry run structurally write-free —
 * it stops here — and what lets the whole decision surface of an import be
 * tested with literals.
 *
 * ## ⚠️ THE WRITE ORDER, and why each step sits where it does
 *
 * `aplicarImportacaoShopee` (wave 5) executes the plan in exactly this order:
 *
 *  1. **taxonomia** — the `grupoDeVariacoes` creates and guarded patches. First,
 *     because a conflict that loses its bounded retries refuses the ITEM
 *     (`taxonomia-em-conflito`) and must do so **before any produto write**:
 *     proceeding with a partial taxonomy leaves children whose combinations
 *     mismatch on the next import, and the combination rung then mints
 *     DUPLICATE children — a permanent duplicate bought for a transient
 *     conflict.
 *  2. **categorias** — create-if-absent, root→leaf, so a child's
 *     `categoriaPaiOuterRef` always points at a document that already exists.
 *  3. **the guarded price patch** (`precosPai`), on the UPDATE path only, and
 *     **BEFORE** the produto merge. The merge always writes (it carries
 *     `ultimaModificacao`), which BUMPS `updateTime`; running it first would
 *     make this precondition assert a stamp we had just invalidated ourselves,
 *     failing every price-writing import.
 *  4. **the produto**, 5. **extraData**, 6. **estoque**, 7. **the parent link** —
 *     the link last of the four because its document path is what every child
 *     link points AT.
 *  8. **the children**, each in the same internal order (price patch → produto →
 *     estoque → link).
 *  9. **`filhoUnicoId`** — after the child set is final, in the same unit of
 *     work, because it is a denormalisation of exactly that set.
 * 10. **the photos** — last, separate and RETRIABLE. The legacy committed its
 *     batch and then downloaded, leaving a produto with no images and no record
 *     that images were owed.
 *
 * ## ⚠️ Three refusals, all raised BEFORE a plan exists
 *
 * {@link planejarImportacaoShopee} throws `ShopeeImportBlockedError` for
 * `item-deletado`, `sem-nome` and `vinculo-inconsistente` before it builds
 * anything. That is the contract the job relies on to contain a blocked item: it
 * leaves no half-written produto, no half-written link and no orphan grupo
 * behind, so the next dispatch may retry the same id from a clean state.
 *
 * ## ⚠️ No clock, no microseconds
 *
 * `nowMs` arrives on the preparo — ONE read per dispatch, handed down. No
 * module under `produtos/` reads the ambient clock and none holds a microsecond
 * helper: every stamp this plan carries is MILLISECONDS, and Shopee's own
 * `create_time` / `update_time` (wire SECONDS) are neither read nor stored.
 */
import type { ShopeeCategoria, ShopeeModel } from '@delfrance/integrations-shopee';
import { toOuterRef, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import { temModelosDe, type GrupoMemo, type ItemLido } from './itemLido';
import {
  caminhoDoLinkDaListagem,
  dadosLinkListagem,
  dadosLinkVariacao,
  ehListagemDeletada,
  mapearFilho,
  mapearProdutoPai,
  type LinhaEstoqueLida,
  type MotivoEstoqueIgnorado,
  type MotivoPrecoIgnorado,
  type PaiDoFilhoShopee,
} from './mapeamento';
import {
  planejarTaxonomia,
  tiersDoItem,
  type ComboResolvido,
  type GrupoPlanejado,
} from './taxonomiaShopeeCore';

/* -------------------------------------------------------------------------- */
/*  The preparo — everything the IO layer already read                         */
/* -------------------------------------------------------------------------- */

/** A document this import already resolved, with the id it lives at. */
export interface DocumentoLido {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

/** What the parent cascade settled. */
export interface PreparoProdutoPaiShopee {
  /** `null` ⇒ no produto resolved; the plan mints the deterministic id. */
  readonly existente: DocumentoLido | null;
  readonly extraData: Record<string, unknown> | null;
  /**
   * ⚠️ The `prodshopee` that resolved this parent sits under a produto whose
   * `paiId` is NOT null — a listing link under a CHILD. The order resolver's
   * SKU rung would then return that child as the parent for every line of the
   * listing, so the item is refused rather than written around.
   */
  readonly linkSobFilho: boolean;
  /**
   * Does the ERP already hold children for this produto? Half of the
   * "never stock a parent that owns children" test; the payload's `has_model` is
   * the other half, and the two part company when a seller consolidates a
   * listing.
   */
  readonly jaTemFilhos: boolean;
  readonly estoque: LinhaEstoqueLida | null;
}

/** What one model's cascade settled. */
export interface PreparoFilhoShopee {
  readonly modelo: ShopeeModel;
  readonly existente: DocumentoLido | null;
  /**
   * ⚠️ The `variashopee` that resolved this model points at a produto of ANOTHER
   * family. That document binds a model of THIS listing to someone else's child,
   * and the order resolver moves stock on it. The legacy resolved this by
   * DELETING the document; step 9 never deletes, so refusing loudly is the only
   * remaining honest move.
   */
  readonly vinculoDeOutraFamilia: boolean;
  readonly link: DocumentoLido | null;
  readonly estoque: LinhaEstoqueLida | null;
}

/** Everything the write-free half READ, and the only input to the plan. */
export interface PreparoImportacaoShopee {
  readonly entrada: ItemLido;
  readonly integracaoId: string;
  /** MILLISECONDS. */
  readonly nowMs: number;
  readonly options: ImportacaoShopeeOptions;
  readonly tabelaNormalOuterRef: string | null;
  /**
   * ⚠️ Carried and DELIBERATELY never written — see `mapeamento.ts`'s header.
   * It is on the preparo so the CLI can say out loud that the conta HAS a
   * promotional table and that the import is not using it.
   */
  readonly tabelaPromocionalOuterRef: string | null;
  readonly depositoOuterRef: string | null;
  readonly pai: PreparoProdutoPaiShopee;
  /** One entry per model, in `get_model_list` order. Empty for a no-model listing. */
  readonly filhos: readonly PreparoFilhoShopee[];
  /** The `prodshopee` document the parent cascade found, if any. */
  readonly linkPai: DocumentoLido | null;
  /** The per-dispatch `grupoDeVariacoes` memo (C10). */
  readonly grupos: GrupoMemo;
  /** The category chain, ROOT-FIRST and inclusive. Empty for an unknown id. */
  readonly categorias: readonly ShopeeCategoria[];
  /**
   * The Shopee `image_id`s already cached on this produto's arquivos for THIS
   * integração. A picture whose id is here is not downloaded again.
   */
  readonly imagensJaCacheadas: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  The plan                                                                   */
/* -------------------------------------------------------------------------- */

/** A `categorias/shopee-<id>` document to create IF ABSENT, root-first. */
export interface CategoriaParaCriar {
  readonly docId: string;
  readonly data: Record<string, unknown>;
}

/** A produto write: the FULL document on create, a merge patch on update. */
export interface EscritaDeProduto {
  readonly produtoId: string;
  readonly criar: boolean;
  readonly data: Record<string, unknown>;
}

/** A stock write, keyed to the row that was READ. */
export interface EscritaDeEstoque {
  readonly produtoId: string;
  readonly docId: string;
  readonly criar: boolean;
  readonly data: Record<string, unknown>;
}

/** A link-document write: `merge` onto the resolved id, or `add` at a fresh one. */
export interface EscritaDeLink {
  readonly acao: 'add' | 'merge';
  /** The resolved document id on `merge`; `null` on `add` (Firestore mints it). */
  readonly docId: string | null;
  readonly dados: Record<string, unknown>;
}

/** The guarded dotted-path price patch, on the UPDATE path only. */
export interface EscritaDePrecos {
  readonly produtoId: string;
  /** `{ 'precos.<tabelaId>': { valor } }` — set-only; nothing ever deletes a key. */
  readonly patch: Record<string, unknown>;
}

/** One picture to fetch, paired with the id that makes it dedupable. */
export interface ParDeImagemShopee {
  readonly url: string;
  /** `null` when Shopee sent more URLs than ids — imported, but not dedupable. */
  readonly imageId: string | null;
}

/** One model's whole write plan. */
export interface PlanoFilhoShopee {
  readonly modelId: number;
  readonly produto: EscritaDeProduto | null;
  readonly precos: EscritaDePrecos | null;
  readonly estoque: EscritaDeEstoque | null;
  /** `null` ⇔ `model_id` is `0` — the child is created, the link is NOT written. */
  readonly link: EscritaDeLink | null;
  readonly precoIgnorado: MotivoPrecoIgnorado | null;
  readonly estoqueIgnorado: MotivoEstoqueIgnorado | null;
}

/** The ordered write plan for ONE listing. Data only — nothing here executes. */
export interface PlanoImportacaoShopee {
  readonly itemId: number;
  readonly produtoId: string;
  readonly criar: boolean;
  readonly nome: string;
  /** Step 1 — grupo creates and guarded patches, in tier order. */
  readonly taxonomia: readonly GrupoPlanejado[];
  /** Step 2 — create-if-absent, ROOT-FIRST. */
  readonly categorias: readonly CategoriaParaCriar[];
  /** Step 3 — BEFORE the produto merge. `null` on create and when no price applies. */
  readonly precosPai: EscritaDePrecos | null;
  /** Step 4. */
  readonly produtoPai: EscritaDeProduto | null;
  /** Step 5. */
  readonly extraData: Record<string, unknown> | null;
  /** Step 6. */
  readonly estoquePai: EscritaDeEstoque | null;
  /** Step 7 — written before the children, because its path is what they point at. */
  readonly linkPai: EscritaDeLink;
  /**
   * ⚠️ The parent link is an `add`, so its document id does not exist yet and no
   * child link below carries `produtoShopeeOuterRef`. Wave 5 MUST stamp it from
   * the id the `add` returned, through
   * {@link caminhoDoLinkDaListagem}. A forgotten stamp is LOUD, not silent: the
   * field is a required non-nullable `outerRefSchema`.
   */
  readonly linkPaiRefPendente: boolean;
  /** Step 8. */
  readonly filhos: readonly PlanoFilhoShopee[];
  /**
   * Step 9 — the DERIVATION INPUT, never the derived value.
   *
   * ⚠️ `derivarFilhoUnico` takes the FULL child set, and the full set is only
   * knowable after the writes land. So the plan carries the ids it is about to
   * create or keep, and wave 5 re-reads `paiId == produtoId` with `limit(2)` and
   * derives from THAT — a plan-time answer would be a confident wrong one for
   * any child this import did not touch.
   */
  readonly filhoUnico: { readonly paiId: string; readonly idsPlanejados: readonly string[] };
  /** Step 10 — retriable, after everything. */
  readonly fotos: { readonly baixar: readonly ParDeImagemShopee[]; readonly ignoradas: number };
  readonly precoPaiIgnorado: MotivoPrecoIgnorado | null;
  readonly estoquePaiIgnorado: MotivoEstoqueIgnorado | null;
  /** What the importer will report, as far as a PLAN can know it. */
  readonly resultado: {
    readonly variacoes: {
      readonly total: number;
      readonly criadas: number;
      readonly semLink: number;
    };
    readonly fotos: { readonly aBaixar: number; readonly ignoradas: number };
  };
}

/* -------------------------------------------------------------------------- */
/*  The refusals                                                               */
/* -------------------------------------------------------------------------- */

function recusar(preparo: PreparoImportacaoShopee): void {
  const itemId = preparo.entrada.itemId;

  // 1. A deleted listing, first and cheapest: nothing below it is worth deciding.
  //    Never a produto from a listing Shopee has removed.
  if (ehListagemDeletada(preparo.entrada)) {
    throw new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.itemDeletado,
      itemId,
      'item_status de exclusão na leitura',
    );
  }

  // 2. A produto with no name is not a produto — `produtoSchema.nome` is
  //    `min(1)`, so this would throw at parse time with a Zod path instead of a
  //    reason the operator can act on.
  if ((preparo.entrada.base.item_name?.trim() ?? '') === '') {
    throw new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.semNome,
      itemId,
      'item_name em branco',
    );
  }

  // 3. A link document that would bind the WRONG produto. Both arms are refused
  //    BEFORE any write, and the message names the operator's remedy.
  if (preparo.pai.linkSobFilho) {
    throw new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.vinculoInconsistente,
      itemId,
      'prodshopee sob um produto filho — remova o documento de vínculo antigo',
    );
  }
  for (const filho of preparo.filhos) {
    if (filho.vinculoDeOutraFamilia) {
      throw new ShopeeImportBlockedError(
        MOTIVO_IMPORT_BLOQUEADO.vinculoInconsistente,
        itemId,
        `variashopee do modelo ${String(filho.modelo.model_id)} aponta para outra família`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The plan builder                                                           */
/* -------------------------------------------------------------------------- */

/** `categorias/shopee-<category_id>` — the Shopee namespace inside a GLOBAL one. */
export const PREFIXO_CATEGORIA_SHOPEE = 'shopee-';

/**
 * ⚠️ PREFIXED, and the reason is the opposite of Mercado Livre's. ML uses the
 * bare `MLB…` id because the legacy Flutter app wrote the same document id;
 * there is **no legacy Shopee categoria corpus at all** (the Flutter provider
 * walked `parent_category_id` in memory and never created a Categoria document),
 * so the convergence argument does not transfer. `categorias` is a GLOBAL ERP
 * namespace shared with ML ids and operator-created documents, and a bare
 * integer is the one id shape an operator could plausibly type by hand.
 */
export function idCategoriaShopee(categoryId: number): string {
  return `${PREFIXO_CATEGORIA_SHOPEE}${String(categoryId)}`;
}

function rotuloDaCategoria(no: ShopeeCategoria): string {
  // `display_category_name` first: it is what the operator sees and what
  // `linksVariacoesShopee.name` carries.
  const nome = (no.display_category_name ?? no.original_category_name ?? '').trim();
  return nome.length > 0 ? nome : String(no.category_id);
}

function planejarCategorias(
  caminho: readonly ShopeeCategoria[],
  nowMs: number,
): readonly CategoriaParaCriar[] {
  return caminho.map((no, i) => ({
    docId: idCategoriaShopee(no.category_id),
    data: {
      nome: rotuloDaCategoria(no),
      // The deliberate cosmetic deviation ML already made: NAMES joined, not ids.
      nomeCompleto: caminho
        .slice(0, i + 1)
        .map(rotuloDaCategoria)
        .join(' > '),
      permiteCadastro: true,
      categoriaGoogleId: null,
      categoriaPaiOuterRef:
        i === 0 ? null : toOuterRef(`categorias/${idCategoriaShopee(caminho[i - 1]!.category_id)}`),
      timestamp: nowMs,
      ultimaModificacao: nowMs,
    },
  }));
}

function planejarFotos(preparo: PreparoImportacaoShopee): {
  readonly baixar: ParDeImagemShopee[];
  readonly ignoradas: number;
} {
  if (!preparo.options.importarFotos) return { baixar: [], ignoradas: 0 };
  const imagem = preparo.entrada.base.image;
  const urls = imagem?.image_url_list ?? [];
  const ids = imagem?.image_id_list ?? [];
  const cacheadas = new Set(preparo.imagensJaCacheadas);
  const baixar: ParDeImagemShopee[] = [];
  let ignoradas = 0;
  // ⚠️ The two arrays are PARALLEL-INDEXED and nothing guarantees equal lengths.
  // Pair by index; an extra URL is still imported (with no id, so not dedupable
  // next time) and an extra id is simply not a picture.
  for (const [i, url] of urls.entries()) {
    if (url.trim().length === 0) continue;
    const imageId = ids[i] ?? null;
    if (imageId !== null && cacheadas.has(imageId)) {
      ignoradas += 1;
      continue;
    }
    baixar.push({ url, imageId });
  }
  return { baixar, ignoradas };
}

/**
 * The whole import of ONE listing, as an ordered plan.
 *
 * ⚠️ It writes nothing and reads nothing. Every decision it makes is a function
 * of {@link PreparoImportacaoShopee}, which is why the CLI's dry run can stop
 * here and print exactly what a `--live` run would do.
 */
export function planejarImportacaoShopee(preparo: PreparoImportacaoShopee): PlanoImportacaoShopee {
  recusar(preparo);

  const { entrada, options, nowMs, integracaoId } = preparo;
  const temModelos = temModelosDe(entrada);
  const temFilhos = temModelos || preparo.pai.jaTemFilhos;

  // ---- 1. taxonomia --------------------------------------------------------
  const tiers = temModelos
    ? tiersDoItem({
        tiers: entrada.models?.tier_variation ?? [],
        padronizados: entrada.models?.standardise_tier_variation ?? [],
      })
    : [];
  const modelos = preparo.filhos.map((f) => f.modelo);
  const taxonomia: {
    readonly grupos: readonly GrupoPlanejado[];
    readonly combos: readonly ComboResolvido[];
  } =
    tiers.length > 0
      ? planejarTaxonomia({
          tiers,
          modelos,
          candidatos: preparo.grupos.docs,
          integracaoId,
          categoryId: entrada.base.category_id ?? 0,
          nomeCategoria:
            preparo.categorias.length > 0
              ? rotuloDaCategoria(preparo.categorias[preparo.categorias.length - 1]!)
              : '',
          nowMs,
        })
      : { grupos: [], combos: [] };

  // ---- 2. categorias -------------------------------------------------------
  // The whole leg is gated by `importarCategorias` upstream of the leaf ref —
  // never by `atualizarProdutoPai` — and an unknown category id is an empty
  // chain, which links nothing and fails nothing.
  const categorias = options.importarCategorias
    ? planejarCategorias(preparo.categorias, nowMs)
    : [];
  const folha = categorias[categorias.length - 1];
  const categoriaOuterRef = folha !== undefined ? toOuterRef(`categorias/${folha.docId}`) : null;

  // ---- 3..6. the parent ----------------------------------------------------
  const mapaPai = mapearProdutoPai({
    entrada,
    existente: preparo.pai.existente,
    existenteExtraData: preparo.pai.extraData,
    options,
    nowMs,
    integracaoId,
    tabelaNormalOuterRef: preparo.tabelaNormalOuterRef,
    depositoOuterRef: preparo.depositoOuterRef,
    categoriaOuterRef,
    temFilhos,
    estoqueExistente: preparo.pai.estoque,
  });

  const precosPai =
    !mapaPai.criar && mapaPai.precos !== null
      ? {
          produtoId: mapaPai.produtoId,
          patch: {
            [`precos.${mapaPai.precos.tabelaId}`]: { valor: mapaPai.precos.valor },
          },
        }
      : null;

  const produtoPai =
    mapaPai.criar || Object.keys(mapaPai.patchProduto).length > 1
      ? {
          produtoId: mapaPai.produtoId,
          criar: mapaPai.criar,
          data: mapaPai.patchProduto,
        }
      : null;

  const estoquePai = mapaPai.estoque
    ? {
        produtoId: mapaPai.produtoId,
        docId: mapaPai.estoque.docId,
        criar: mapaPai.estoque.criar,
        data: montarEstoque(mapaPai.produtoId, mapaPai.estoque, preparo.depositoOuterRef, nowMs),
      }
    : null;

  // ---- 7. the parent link --------------------------------------------------
  const linkPai: EscritaDeLink = {
    acao: preparo.linkPai !== null ? 'merge' : 'add',
    docId: preparo.linkPai?.id ?? null,
    dados: dadosLinkListagem(entrada, preparo.linkPai?.raw ?? null, integracaoId, nowMs),
  };

  // ---- 8. the children -----------------------------------------------------
  // ⚠️ A child inherits the parent's EFFECTIVE value — what the parent document
  // will hold after this import — not what this import happens to be writing.
  // `nome`, `ehKit` and `ehUsado` are create-only and the dimension fields are
  // fill-blank, so on an update path the patch is usually SILENT about them and
  // reading it alone would give every child of an existing kit `ehKit: false`.
  const armazenadoPai = preparo.pai.existente?.raw ?? null;
  const efetivo = (chave: string): unknown =>
    mapaPai.patchProduto[chave] ?? armazenadoPai?.[chave] ?? null;

  const pai: PaiDoFilhoShopee = {
    produtoId: mapaPai.produtoId,
    nome: typeof efetivo('nome') === 'string' ? (efetivo('nome') as string) : '',
    ehKit: efetivo('ehKit') === true,
    ehUsado: efetivo('ehUsado') === true,
    categoriaOuterRef:
      categoriaOuterRef ??
      (typeof armazenadoPai?.categoriaProdutoOuterRef === 'string'
        ? armazenadoPai.categoriaProdutoOuterRef
        : null),
    pesoLiquidoKg: numeroOuNulo(efetivo('pesoLiquidoKg')),
    pesoBrutoKg: numeroOuNulo(efetivo('pesoBrutoKg')),
    alturaCm: numeroOuNulo(efetivo('alturaCm')),
    larguraCm: numeroOuNulo(efetivo('larguraCm')),
    profundidadeCm: numeroOuNulo(efetivo('profundidadeCm')),
  };

  const filhos: PlanoFilhoShopee[] = [];
  const idsPlanejados: string[] = [];
  let criadas = 0;
  let semLink = 0;

  for (const [i, preparoFilho] of preparo.filhos.entries()) {
    const combo = taxonomia.combos[i] ?? { grupoDeVariacoesUid: null, variacoesUid: null };
    const mapa = mapearFilho({
      entrada,
      modelo: preparoFilho.modelo,
      pai,
      taxonomia: combo,
      existente: preparoFilho.existente,
      options,
      nowMs,
      tabelaNormalOuterRef: preparo.tabelaNormalOuterRef,
      depositoOuterRef: preparo.depositoOuterRef,
      estoqueExistente: preparoFilho.estoque,
    });
    idsPlanejados.push(mapa.produtoId);
    if (mapa.criar) criadas += 1;

    // ⚠️ The parent's LINK path, not the parent's produto path — that is why the
    // parent link is written first. When the parent link is an `add` its id does
    // not exist yet, so the ref is OMITTED and wave 5 stamps it from the id the
    // `add` returned (`linkPaiRefPendente`).
    const link = dadosLinkVariacao(
      preparoFilho.modelo,
      linkPai.docId !== null ? caminhoDoLinkDaListagem(mapaPai.produtoId, linkPai.docId) : null,
      preparoFilho.link?.raw ?? null,
      integracaoId,
    );
    // A `model_id` of `0` is Shopee's "no model item" sentinel and is NEVER
    // written as a link: it would bind any line of any listing on the order
    // resolver's highest-priority rung. The CHILD is still created.
    const semLinkPorModelo =
      typeof preparoFilho.modelo.model_id !== 'number' || preparoFilho.modelo.model_id === 0;
    if (semLinkPorModelo) semLink += 1;

    filhos.push({
      modelId: preparoFilho.modelo.model_id,
      produto:
        mapa.criar || Object.keys(mapa.patchProduto).length > 1
          ? { produtoId: mapa.produtoId, criar: mapa.criar, data: mapa.patchProduto }
          : null,
      precos:
        !mapa.criar && mapa.precos !== null
          ? {
              produtoId: mapa.produtoId,
              patch: { [`precos.${mapa.precos.tabelaId}`]: { valor: mapa.precos.valor } },
            }
          : null,
      estoque: mapa.estoque
        ? {
            produtoId: mapa.produtoId,
            docId: mapa.estoque.docId,
            criar: mapa.estoque.criar,
            data: montarEstoque(mapa.produtoId, mapa.estoque, preparo.depositoOuterRef, nowMs),
          }
        : null,
      link:
        semLinkPorModelo || link === null
          ? null
          : {
              acao: preparoFilho.link !== null ? 'merge' : 'add',
              docId: preparoFilho.link?.id ?? null,
              dados: link,
            },
      precoIgnorado: mapa.precoIgnorado,
      estoqueIgnorado: mapa.estoqueIgnorado,
    });
  }

  // ---- 10. photos ----------------------------------------------------------
  const fotos = planejarFotos(preparo);

  return {
    itemId: entrada.itemId,
    produtoId: mapaPai.produtoId,
    criar: mapaPai.criar,
    nome: pai.nome,
    taxonomia: taxonomia.grupos,
    categorias,
    precosPai,
    produtoPai,
    extraData: mapaPai.patchExtraData,
    estoquePai,
    linkPai,
    linkPaiRefPendente: linkPai.docId === null,
    filhos,
    filhoUnico: { paiId: mapaPai.produtoId, idsPlanejados },
    fotos,
    precoPaiIgnorado: mapaPai.precoIgnorado,
    estoquePaiIgnorado: mapaPai.estoqueIgnorado,
    resultado: {
      variacoes: { total: filhos.length, criadas, semLink },
      fotos: { aBaixar: fotos.baixar.length, ignoradas: fotos.ignoradas },
    },
  };
}

function numeroOuNulo(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function montarEstoque(
  produtoId: string,
  escrita: { readonly criar: boolean; readonly quantidade: number },
  depositoOuterRef: string | null,
  nowMs: number,
): Record<string, unknown> {
  return {
    parentId: produtoId,
    depositoOuterRef: depositoOuterRef !== null ? toOuterRef(depositoOuterRef) : null,
    quantidade: escrita.quantidade,
    ultimaModificacao: nowMs,
    ...(escrita.criar ? { dataCriacao: nowMs } : {}),
  };
}
