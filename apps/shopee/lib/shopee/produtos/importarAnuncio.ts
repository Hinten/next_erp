/**
 * ONE Shopee listing → the ERP (#1517, step 9). The importer the single-item
 * route, the rehearsal CLI and the mass-import job all drive.
 *
 * Three halves, and the split is the design:
 *
 *  1. {@link prepararImportacaoShopee} — **structurally WRITE-FREE**. It reads
 *     the cascade, the existing link documents, the stock rows, the category
 *     chain and the picture ids already cached, then hands them to the pure
 *     planner. No bucket, no fetch, no writer anywhere in its call graph — a
 *     test proves it by driving it with a FakeDb that throws on every write verb.
 *  2. `planejarImportacaoShopee` — **pure**, imported from `planoImportacao.ts`.
 *     Every decision of an import is a function of the preparo, which is what
 *     lets the CLI's dry run print exactly what a live run would do.
 *  3. {@link aplicarImportacaoShopee} — the writer, executing the plan in the
 *     order that module's docblock states.
 *
 * ## ⚠️ The write ORDER, restated because this is where it is EXECUTED
 *
 * taxonomia → categorias → the guarded price patch → produto → extraData →
 * estoque → the parent link → the children (each in the same internal order) →
 * `filhoUnicoId` → photos.
 *
 * Two of those placements are load-bearing rather than tidy:
 *
 *  - **taxonomia first**, because a grupo conflict that loses refuses the whole
 *    ITEM, and it must do so before any produto exists. Proceeding with a
 *    partial taxonomy leaves children whose combinations mismatch next time, and
 *    the combination rung then mints DUPLICATE children — a permanent duplicate
 *    bought for a transient conflict.
 *  - **the price patch before the produto merge**, because the merge always
 *    writes on the update path (it carries `ultimaModificacao`) and so bumps
 *    `updateTime`. Merging first would make the price precondition assert a
 *    stamp we had just invalidated ourselves, failing every price-writing
 *    import.
 *
 * ## ⚠️ ONE bounded retry, and it RE-PLANS
 *
 * Both guarded writes — the taxonomy patch and the price patch — answer a lost
 * race by failing loudly. {@link importarAnuncioShopee} then re-reads and
 * RE-PLANS the whole item exactly once, against a FRESH grupo memo. It never
 * re-applies the same patch: re-applying writes the loser's values over the
 * winner's, which is the precise thing the precondition exists to stop. A second
 * loss propagates — for the taxonomy that is `taxonomia-em-conflito`, contained
 * per item by the job, with nothing half-written because the taxonomy step is
 * first.
 *
 * ## ⚠️ This importer issues NO item read
 *
 * It receives an {@link ItemLido} — `o importador não emite nenhuma chamada de
 * item_base_info`. The job pays for the three wire reads once per item and hands
 * them down, so a catalogue walk costs one batch per dispatch instead of one
 * call per listing, and all three callers drive the same code path.
 *
 * ## ⚠️ A kit is REFUSED here, never imported as a simple produto
 *
 * A `tag.kit` listing has components, no derivable stock and its own endpoint.
 * Importing it through this path would mint a normal produto for something that
 * is not one, so it throws — naming the kit importer — rather than quietly
 * producing a wrong document.
 *
 * Next-free, clock-free: `nowMs` arrives on the deps, read ONCE per dispatch.
 */
import { isAlreadyExists } from '@delfrance/data/admin';
import { produtoCollection, produtoExtraDataCollection } from '@delfrance/data/admin/collections';

import { aplicarCategoriasShopee, caminhoDaCategoriaDoAnuncio } from './categoriaShopee';
import {
  ShopeePrecoDesatualizadoError,
  aplicarEstoqueShopee,
  aplicarPrecosShopee,
  lerLinhaDeEstoque,
} from './estoquePrecos';
import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import { idsDeImagemJaImportados, importarFotosShopee } from './fotosShopee';
import {
  ehKitDe,
  temModelosDe,
  type GrupoMemo,
  type ImportarAnuncioDeps,
  type ImportarAnuncioShopeeFn,
  type ItemLido,
  type MemoDeGrupos,
  type PrepararImportacaoShopeeDeps,
  type PrepararImportacaoShopeeFn,
  type ResultadoImportacaoShopee,
} from './itemLido';
import { aplicarLinkDaListagem } from './links';
import {
  planejarImportacaoShopee,
  type PlanoImportacaoShopee,
  type PreparoFilhoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';
import {
  idDoFilhoPlanejado,
  idDoPaiPlanejado,
  resolverFilhosDaListagem,
  resolverPaiDaListagem,
} from './resolveProduto';
import { aplicarTaxonomiaShopee, criarMemoDeGrupos } from './taxonomiaShopee';
import { planejarTaxonomia, tiersDoItem } from './taxonomiaShopeeCore';
import { aplicarFilhoShopee, aplicarFilhoUnicoShopee } from './variacoesShopee';

/** The fixed doc id of the `extraData` singleton. */
const EXTRA_DATA_DOC_ID = 'singleton';

/**
 * A kit reaching this module is a ROUTING mistake, not a listing problem, so it
 * is a plain `Error` naming the module that should have handled it — never a
 * `ShopeeImportBlockedError`, which would file a routing bug as one listing's
 * failure row and bury it in a list of broken listings.
 */
function recusarKit(itemId: number): never {
  throw new Error(
    `importarAnuncioShopee: o item ${String(itemId)} é um kit (tag.kit) — ` +
      'use importarKitShopee. Um kit nunca vira um produto simples.',
  );
}

/* -------------------------------------------------------------------------- */
/*  1. preparar — READS ONLY                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything the plan needs, READ — then planned.
 *
 * Structurally write-free by its deps type ({@link PrepararImportacaoShopeeDeps}
 * omits the bucket and the fetch) and by its call graph, which reaches only
 * readers.
 */
export const prepararImportacaoShopee: PrepararImportacaoShopeeFn = async (
  deps: PrepararImportacaoShopeeDeps,
  entrada: ItemLido,
): Promise<PlanoImportacaoShopee> => planejarImportacaoShopee(await lerPreparo(deps, entrada));

/**
 * The preparo, unplanned — what the CLI prints and what the two-pass importer
 * re-reads on a lost race.
 *
 * ⚠️ The taxonomy is planned TWICE: once here, to give the combination rung a
 * combination to compare, and once inside `planejarImportacaoShopee`. That is
 * deliberate. `planejarTaxonomia` is PURE and deterministic, so the same inputs
 * cannot produce two answers; smuggling the first result through the preparo
 * would instead make the plan depend on a value the preparo computed rather than
 * on the documents it read.
 */
export async function lerPreparo(
  deps: PrepararImportacaoShopeeDeps,
  entrada: ItemLido,
): Promise<PreparoImportacaoShopee> {
  if (ehKitDe(entrada.base)) recusarKit(entrada.itemId);

  const db = deps.db;
  const temModelos = temModelosDe(entrada);

  const pai = await resolverPaiDaListagem(db, deps.integracaoId, entrada);
  const paiId = pai.existente?.id ?? idDoPaiPlanejado(deps.integracaoId, entrada.itemId);

  // ⚠️ Lazily, and ONLY for an item that has models: a catalogue of simple
  // listings must not pay for one full `grupoDeVariacoes` read.
  const grupos: GrupoMemo = temModelos
    ? await (deps.grupos ?? criarMemoDeGrupos(db)).carregar()
    : { docs: [] };

  const categorias = await caminhoDaCategoriaDoAnuncio(deps.categorias, entrada.base.category_id);

  const modelos = entrada.models?.model ?? [];
  const tiers = temModelos
    ? tiersDoItem({
        tiers: entrada.models?.tier_variation ?? [],
        padronizados: entrada.models?.standardise_tier_variation ?? [],
      })
    : [];
  const combos =
    tiers.length > 0
      ? planejarTaxonomia({
          tiers,
          modelos,
          candidatos: grupos.docs,
          integracaoId: deps.integracaoId,
          categoryId: entrada.base.category_id ?? 0,
          // Only the COMBINATIONS are read from this pass; the entry's display
          // name belongs to the plan, which knows the resolved category chain.
          nomeCategoria: '',
          nowMs: deps.nowMs,
        }).combos
      : [];

  const resolucoes = await resolverFilhosDaListagem(
    db,
    deps.integracaoId,
    paiId,
    pai.existente !== null,
    modelos,
    combos.map((c) => ({ variacoesUid: c.variacoesUid })),
  );

  const filhos: PreparoFilhoShopee[] = [];
  for (const resolucao of resolucoes) {
    const modelId = typeof resolucao.modelo.model_id === 'number' ? resolucao.modelo.model_id : 0;
    const filhoId = resolucao.existente?.id ?? idDoFilhoPlanejado(paiId, modelId);
    filhos.push({
      modelo: resolucao.modelo,
      existente: resolucao.existente,
      vinculoDeOutraFamilia: resolucao.vinculoDeOutraFamilia,
      link: resolucao.link,
      estoque: await lerLinhaDeEstoque(db, filhoId, deps.depositoOuterRef),
    });
  }

  return {
    entrada,
    integracaoId: deps.integracaoId,
    nowMs: deps.nowMs,
    options: deps.options,
    tabelaNormalOuterRef: deps.tabelaNormalOuterRef,
    tabelaPromocionalOuterRef: deps.tabelaPromocionalOuterRef,
    depositoOuterRef: deps.depositoOuterRef,
    pai: {
      existente: pai.existente,
      extraData: pai.extraData,
      linkSobFilho: pai.linkSobFilho,
      jaTemFilhos: pai.jaTemFilhos,
      estoque: await lerLinhaDeEstoque(db, paiId, deps.depositoOuterRef),
    },
    filhos,
    linkPai: pai.link,
    grupos,
    categorias,
    // Only worth the reads when photos are actually being imported AND the
    // produto already exists — a produto about to be created has no arquivos.
    imagensJaCacheadas:
      deps.options.importarFotos && pai.existente !== null
        ? await idsDeImagemJaImportados(db, paiId, deps.integracaoId)
        : [],
  };
}

/* -------------------------------------------------------------------------- */
/*  3. aplicar — the writer                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Execute one plan, in the order `planoImportacao.ts`'s docblock states.
 *
 * ⚠️ `deps.grupos` must be the SAME memo object the plan was built from — its
 * `carregar()` is single-flight, so asking it again costs nothing and answers
 * the identical document set, stamps included. That is what lets the guarded
 * grupo patch assert the read it was derived from.
 */
export async function aplicarImportacaoShopee(
  deps: ImportarAnuncioDeps,
  plano: PlanoImportacaoShopee,
): Promise<ResultadoImportacaoShopee> {
  const db = deps.db;

  // ---- 1. taxonomia --------------------------------------------------------
  if (plano.taxonomia.length > 0) {
    await aplicarTaxonomiaShopee(db, {
      grupos: plano.taxonomia,
      memo: await (deps.grupos ?? criarMemoDeGrupos(db)).carregar(),
      nowMs: deps.nowMs,
      itemId: plano.itemId,
    });
  }

  // ---- 2. categorias -------------------------------------------------------
  await aplicarCategoriasShopee(db, plano.categorias);

  // ---- 3..4. the parent (the guarded price patch, then the produto) --------
  const produtoId = plano.produtoId;
  const ref = produtoCollection.docRef(db, {}, produtoId);
  let criado = plano.criar;

  if (plano.criar) {
    // On the create path the plan ALWAYS carries the full document.
    const dados = plano.produtoPai?.data ?? {};
    try {
      // `.create()` and not `.set()`: a concurrent create of the same listing
      // must not full-overwrite the winner's document.
      await ref.create(produtoCollection.parse(dados));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Someone created it between the cascade and now — merge onto theirs
      // rather than claiming a create that did not happen.
      criado = false;
      await produtoCollection.merge(db, {}, produtoId, dados);
    }
  } else {
    // ⚠️ 3 BEFORE 4 — the guarded price patch asserts the stamp of the read it
    // was derived from, and the merge below would bump exactly that stamp.
    const snap = await ref.get();
    await aplicarPrecosShopee(db, plano.precosPai, snap.updateTime);
    if (plano.produtoPai !== null) {
      await produtoCollection.merge(db, {}, produtoId, plano.produtoPai.data);
    }
  }

  // ---- 5. extraData --------------------------------------------------------
  if (plano.extraData !== null) {
    await produtoExtraDataCollection.merge(db, { produtoId }, EXTRA_DATA_DOC_ID, plano.extraData);
  }

  // ---- 6. estoque ----------------------------------------------------------
  await aplicarEstoqueShopee(db, plano.estoquePai);

  // ---- 7. the parent link, before the children that point AT it ------------
  const linkPaiId = await aplicarLinkDaListagem(db, produtoId, plano.linkPai);

  // ---- 8. the children, each in the same internal order --------------------
  let criadas = 0;
  for (const [i, filho] of plano.filhos.entries()) {
    // ⚠️ Index-aligned by CONSTRUCTION: the planner pushes `filhos[i]` and
    // `filhoUnico.idsPlanejados[i]` in the same loop iteration. The child's id
    // cannot be read off `filho.produto`, which is `null` on a byte-identical
    // re-import — and the link still has to land under the right document.
    const filhoId = plano.filhoUnico.idsPlanejados[i];
    if (filhoId === undefined) continue;
    const res = await aplicarFilhoShopee(db, filho, filhoId, produtoId, linkPaiId);
    if (res.criado) criadas += 1;
  }

  // ---- 9. filhoUnicoId, after the child set is final -----------------------
  // ⚠️ It runs whenever the listing has models OR the produto already existed —
  // never on models alone. A listing that LOST its variations plans no children
  // at all, and that is exactly the produto whose pointer most needs
  // re-deriving; gating on the payload would skip it for ever. A freshly created
  // simple produto is the one case that can own no children, so it is skipped.
  if (plano.filhos.length > 0 || !plano.criar) {
    await aplicarFilhoUnicoShopee(db, produtoId, deps.nowMs);
  }

  // ---- 10. photos — last, separate and retriable ---------------------------
  const fotos = await importarFotosShopee(
    {
      db,
      ...(deps.bucket !== undefined ? { bucket: deps.bucket } : {}),
      integracaoId: deps.integracaoId,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
    produtoId,
    plano.fotos.baixar,
    plano.fotos.ignoradas,
  );

  return {
    produtoId,
    criado,
    nome: plano.nome,
    variacoes: {
      total: plano.resultado.variacoes.total,
      criadas,
      semLink: plano.resultado.variacoes.semLink,
    },
    fotos,
  };
}

/* -------------------------------------------------------------------------- */
/*  The whole thing                                                            */
/* -------------------------------------------------------------------------- */

/** Did this failure mean "somebody else wrote first"? */
function ehCorridaPerdida(err: unknown): boolean {
  if (err instanceof ShopeePrecoDesatualizadoError) return true;
  return (
    err instanceof ShopeeImportBlockedError &&
    err.motivo === MOTIVO_IMPORT_BLOQUEADO.taxonomiaEmConflito
  );
}

/** preparar → planejar → aplicar. The BOUND name every surface imports. */
export const importarAnuncioShopee: ImportarAnuncioShopeeFn = async (
  deps: ImportarAnuncioDeps,
  entrada: ItemLido,
): Promise<ResultadoImportacaoShopee> => importarUmaVez(deps, entrada, 1);

async function importarUmaVez(
  deps: ImportarAnuncioDeps,
  entrada: ItemLido,
  tentativasRestantes: number,
): Promise<ResultadoImportacaoShopee> {
  // ⚠️ ONE memo per attempt, shared by the preparo and the writer. On the RETRY
  // it is a FRESH one, which is the whole point: the re-plan has to see what the
  // winner wrote, and reusing the memoised read would re-plan against the stale
  // documents that just lost.
  const memo: MemoDeGrupos = deps.grupos ?? criarMemoDeGrupos(deps.db);
  const comMemo: ImportarAnuncioDeps = { ...deps, grupos: memo };

  const plano = planejarImportacaoShopee(await lerPreparo(comMemo, entrada));
  try {
    return await aplicarImportacaoShopee(comMemo, plano);
  } catch (err) {
    if (tentativasRestantes > 0 && ehCorridaPerdida(err)) {
      // ⚠️ RE-PLAN, never re-apply, and with `grupos` cleared so the retry reads
      // the collection again.
      const { grupos: _memoVencido, ...semMemo } = deps;
      return importarUmaVez(semMemo, entrada, tentativasRestantes - 1);
    }
    throw err;
  }
}
