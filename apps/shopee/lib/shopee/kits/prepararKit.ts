/**
 * **Read everything ONE native-kit run needs** (step 19, #1527 — reconcile
 * §2.5.3) — and write nothing.
 *
 * `prepararKit` is the read half of `publicarKitShopee` (`publicarKit.ts`):
 * `prepararKit` → `planejarKit` (`planoKit.ts`, pure) → the arm's applier. It
 * builds the frozen {@link ContextoKit} plus the photos it resolved, in ONE
 * order, and every step of that order is load-bearing:
 *
 * 1. **Firestore first** — K, its children (`lerFilhos`, in TIER order), the
 *    description, the grupos, the conta's `prodshopee` of K, every child's
 *    `variashopee` of the conta and, on a CREATE arm, the rung-2 query step 9's
 *    import will run for this kit (`produtos (sku == K.sku, paiId == null)
 *    limit(2)`, the existing composite).
 * 2. **Phase A** (`problemasDaFaseA`, Firestore-only rows). On a create arm ANY
 *    miss throws ONE aggregated `ShopeePublishBlockedError` HERE, before the
 *    first Shopee read — so the duplicate scan never runs on a null, padded or
 *    shared SKU, and a refused run costs zero Shopee calls (R-c). On
 *    `kit-atualizar` the misses are only CARRIED: the republish completes an
 *    interrupted create first and refuses after (S2C-06).
 * 3. **The Shopee reads**: the component resolution with its ONE batched
 *    `has_model` read (`lerTemModelosDosComponentes`, inside
 *    `componentesKit.ts`), the target's live read on `kit-atualizar` (through
 *    ONE narrowing adapter: an absent or illegible row is a DELETED kit, never a
 *    throw — S2C-07), the kit limits of the principal's category (best-effort:
 *    the gateway's `indisponivel` is a VALUE and means "no local band"; a real
 *    failure propagates), and the UNCACHED channels. On a create arm, a NAMED
 *    `--principal` the resolution could not place throws `principal-invalido`
 *    right after the component batch, before any of the rest (OP-8).
 * 4. **The L6 scan, on a create arm ONLY** (`localizarKitsPorSku`), plus ONE
 *    batched `get_item_base_info` over our own linked kits the list did not
 *    show (S2C-02). A republish NEVER scans (L10(4)): `busca` is `null` and
 *    `nossosVivos` empty there.
 * 5. **LAST, the photos** — K's own pictures through step 11's resolver, capped
 *    at {@link tetoDeFotosDoKit} — and ONLY when the run will send content: a
 *    create arm whose scan verdict (`decidirKitNovo`) is `criar`, or a
 *    `kit-atualizar` carrying no phase-A miss whose target kit reads live (not
 *    deleted, and served as a kit). Otherwise the photos are `null`
 *    ("not resolved", never an empty pass), so a run refused by phase A or by
 *    the scan, or a completing resume, spends no `upload_image` (S3F-17). A
 *    phase-B row `planejarKit` evaluates afterwards can still refuse; an
 *    uploaded image no listing references changes nothing on Shopee.
 *
 * ⚠️ **Write-free, structurally.** {@link PrepararPublicacaoDeps} reaches no
 * writer, the resolver it is handed is CALLED only in step 5 (its uploads are
 * step 11's `arquivos.externalIds` cache, not this module's), and no link or
 * row is written here: the one write a create arm may make before
 * `add_kit_item` (a `nossos` link that read deleted ⇒ `removido`) is the
 * applier's. Nothing in this folder opens a multi-document atomic write.
 *
 * The six step-11 readers it reuses are EXPORTED from `publicarAnuncio.ts`, not
 * copied: a second copy of any of them would be the #1369 drift.
 */
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import {
  componentesKitSchema,
  ehFamiliaDeUm,
  fotoSchema,
  parseFakePath,
  parseRef,
  principalDoKitShopee,
  propagaPrecoAosFilhos,
  type EnderecoShopeeDoComponente,
  type Foto,
} from '@delfrance/schemas';
import {
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { idDoRef } from '../core/vinculosShopee';
import { ShopeePublishBlockedError, temProblemaDeBloqueio } from '../anuncios/errosPublicacao';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import type { FotosResolvidas } from '../anuncios/planoPublicacao';
import {
  filhoParaPublicar,
  lerCanaisDaLoja,
  lerDescricao,
  lerFilhos,
  lerGrupos,
  varianteDoFilhoNoGrupo,
  type EntradaDePublicacao,
  type PrepararPublicacaoDeps,
} from '../anuncios/publicarAnuncio';
import { lerLimitesKitCached, type LimitesKitLidos } from '../taxonomia/cache';
import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from '../produtos/errosImportacao';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { linhasLidasDoModeloKit } from './aplicarKit';
import { lerBaseInfoDosItens, resolverComponentesDoKitErp } from './componentesKit';
import { localizarKitsPorSku } from './localizarKitPorSku';
import {
  decidirKitNovo,
  kitVivoRemovido,
  mapaDeKitArmazenado,
  problemaDoPrincipalSolicitado,
  problemasDaFaseA,
  situacaoDoSkuDoKit,
  tetoDeFotosDoKit,
  vinculosNativosDoKit,
} from './planoKit';
import type { ArmaDePublicacao, ContextoKit, FilhoDoKit, VinculoDaConta } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** A native-kit arm — every arm but step 11's item arm. */
export type ArmaDeKit = Exclude<ArmaDePublicacao, { readonly arma: 'item' }>;

/** What the route and the CLI resolve to, plus the operator's `--principal` (L1). */
export type EntradaDeKit = EntradaDePublicacao & { readonly principal: string | null };

/**
 * The frozen {@link ContextoKit} plus the photos `prepararKit` resolved LAST.
 *
 * ⚠️ `fotos` is `null` when the photo pass was SKIPPED (a refused or a completing
 * run), never an empty `FotosResolvidas` — `planejarKit` evaluates `sem-fotos`
 * only on a non-null value (V2R2-06), so a skipped pass is not a missing photo.
 * It rides BESIDE the context rather than inside it: `ContextoKit` is the frozen
 * seam every applier reads, and the photos are an input of the plan, not a fact
 * about the listing.
 */
export type ContextoKitPreparado = ContextoKit & { readonly fotos: FotosResolvidas | null };

/* -------------------------------------------------------------------------- */
/*                          small tolerant projections                         */
/* -------------------------------------------------------------------------- */

function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' ? bruto : null;
}

function idDeItemUtilizavel(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/** The last segment of an outerRef, through the SHARED parser (`idDeRef`'s rule in step 11). */
function idDeRefOuNull(ref: string | null): string | null {
  if (ref === null) return null;
  const { id } = parseRef(ref);
  return id.length > 0 ? id : null;
}

/** A stored `componentesKit`, through the schema; anything unreadable is `null`. */
function componentesDe(bruto: unknown): FilhoDoKit['componentesKit'] {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const lido = componentesKitSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/**
 * K's own pictures, row by row through the schema — a row that does not parse is
 * dropped, the others kept (step 11's `fotosDeProduto` rule: one malformed
 * picture must not make the kit unpublishable).
 */
function fotosDe(bruto: unknown): readonly Foto[] {
  if (!Array.isArray(bruto)) return [];
  const fotos: Foto[] = [];
  for (const linha of bruto) {
    const lido = fotoSchema.safeParse(linha);
    if (lido.success) fotos.push(lido.data);
  }
  return fotos;
}

/**
 * Does a stored conta ref name THIS conta? The shared fold (1) of
 * `core/vinculosShopee.ts` — `idDoRef`, the last path segment, so BOTH stored
 * encodings (`documents/integracao/<id>` and the bare `integracao/<id>`) read
 * equal and every other id stays distinct. Steps 12/13 attribute links with it.
 */
function daConta(bruto: unknown, integracaoId: string): boolean {
  return idDoRef(bruto) === integracaoId;
}

/* -------------------------------------------------------------------------- */
/*                               Firestore reads                               */
/* -------------------------------------------------------------------------- */

/**
 * K's `prodshopee` for THIS conta — the whole subcollection (no `where`, so no
 * index), the conta compared in memory through {@link daConta}.
 */
async function lerVinculosDeK(
  deps: PrepararPublicacaoDeps,
  produtoId: string,
): Promise<readonly VinculoDaConta[]> {
  const snap = await produtoShopeeLinkCollection.ref(deps.db, { produtoId }).get();
  return snap.docs
    .map((d) => ({ id: d.id, raw: (d.data() ?? {}) as Record<string, unknown> }))
    .filter((v) => daConta(v.raw.contaProdutoShopeeOuterRef, deps.integracaoId));
}

/**
 * EVERY child's `variashopee` for this conta (V2R1-03), each with the link id
 * its `produtoShopeeOuterRef` names (`idDoRef`, BOTH stored encodings; `null` =
 * unreadable, never bound). The children are already in hand, so this is one
 * unfiltered subcollection read per child, conta compared in memory.
 */
async function lerLinhasDaConta(
  deps: PrepararPublicacaoDeps,
  filhoIds: readonly string[],
): Promise<ContextoKit['linhasDaConta']> {
  const saida: {
    produtoId: string;
    docId: string;
    linkDocId: string | null;
    raw: Record<string, unknown>;
  }[] = [];
  for (const produtoId of filhoIds) {
    const snap = await variacaoShopeeLinkCollection.ref(deps.db, { produtoId }).get();
    for (const d of snap.docs) {
      const raw = (d.data() ?? {}) as Record<string, unknown>;
      if (!daConta(raw.contaVariacaoShopeeOuterRef, deps.integracaoId)) continue;
      saida.push({ produtoId, docId: d.id, linkDocId: idDoRef(raw.produtoShopeeOuterRef), raw });
    }
  }
  return saida;
}

/**
 * The ids of the ROOT produtos carrying K's SKU — step 9's parent rung 2, byte
 * for byte (`where sku == … and paiId == null`, `limit(2)`, the existing
 * `produtos (sku, paiId)` composite). `kit-sku-repetido` refuses unless it
 * answers exactly K: two hits make the rung decline and MINT a new produto, so
 * the L9 recovery (an unlinked kit re-imported onto K) would land elsewhere.
 *
 * `null` when there is nothing to ask: no SKU, or one step 9's fold would not
 * read back as itself (`situacaoDoSkuDoKit` — both are phase-A refusals of their
 * own, and the rung never runs on them either).
 */
async function lerRaizesComOSku(
  deps: PrepararPublicacaoDeps,
  sku: string | null,
): Promise<readonly string[] | null> {
  if (sku === null || situacaoDoSkuDoKit(sku) !== 'ok') return null;
  const snap = await produtoCollection
    .ref(deps.db, {})
    .where('sku', '==', sku)
    .where('paiId', '==', null)
    .limit(2)
    .get();
  return snap.docs.map((d) => d.id);
}

/* -------------------------------------------------------------------------- */
/*                                Shopee reads                                 */
/* -------------------------------------------------------------------------- */

/**
 * S2C-02: the live `item_status` of each of OUR linked kits the scan did not
 * list — through the component reader's batch (`lerBaseInfoDosItens`: ≤ 50 ids
 * per `get_item_base_info`, reconciled by id, the batch verdict "none exists"
 * narrowed), usually one id, usually none. `null` = Shopee answered no readable
 * row for it, which is the existing fold's reading of an absent status
 * (`statusAnuncio.ts`: absent ⇒ `removido`); the applier writes that.
 */
async function lerStatusDosNossos(
  client: ShopeeClient,
  itemIds: readonly number[],
): Promise<ReadonlyMap<number, string | null>> {
  const saida = new Map<number, string | null>();
  if (itemIds.length === 0) return saida;
  const { linhas } = await lerBaseInfoDosItens(client, itemIds);
  for (const itemId of itemIds) saida.set(itemId, linhas.get(itemId)?.item_status ?? null);
  return saida;
}

/** The target kit's live read (`ContextoKit.vivo`) plus the component `has_model`s it carried. */
interface KitVivoLido {
  readonly vivo: NonNullable<ContextoKit['vivo']>;
  readonly temModelos: ReadonlyMap<number, boolean>;
}

/**
 * THE narrowing adapter of a target's live read (S2C-07): `lerAnuncioShopee` =
 * `get_item_base_info` + `get_kit_item_info` for a kit (+ its components'
 * `has_model`). An absent or illegible row is the reverify's own reading of a
 * DELETED listing (`item-nao-encontrado`) and reads `{ status: null, kit: null
 * }` — a kit purged ~90 days after its delete must not throw every run.
 * Everything else propagates (rule 6).
 */
async function lerKitVivo(client: ShopeeClient, itemId: number): Promise<KitVivoLido> {
  try {
    const item = await lerAnuncioShopee(client, itemId);
    return {
      vivo: {
        status: item.base.item_status ?? null,
        kit: item.kit ?? null,
        criadoEm: item.base.create_time ?? null,
      },
      temModelos: item.temModelosDosComponentes ?? new Map<number, boolean>(),
    };
  } catch (err) {
    if (
      err instanceof ShopeeImportBlockedError &&
      err.motivo === MOTIVO_IMPORT_BLOQUEADO.itemNaoEncontrado
    ) {
      return {
        vivo: { status: null, kit: null, criadoEm: null },
        temModelos: new Map<number, boolean>(),
      };
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 the principal                               */
/* -------------------------------------------------------------------------- */

/**
 * `--principal` (an ERP component produto id) → its Shopee address, through the
 * component resolution this run already holds (the named id rides the component
 * batch, so a PUBLISHED produto that is not a component of the kit still
 * resolves — and `planejarKit` refuses it `principal-invalido`, naming it).
 * `null` when it was not sent or did not resolve. A NAMED one that did not
 * resolve never reaches the plan as "not sent": on a create arm
 * `problemaDoPrincipalSolicitado` refuses it `principal-invalido` right after
 * the resolution (OP-8), and the raw id rides `ContextoKit.principalSolicitado`.
 */
function enderecoDoPrincipal(
  principal: string | null,
  resolucao: ContextoKit['resolucao'],
): EnderecoShopeeDoComponente | null {
  if (principal === null) return null;
  const r = resolucao.get(principal);
  return r !== undefined && r.ok ? r.endereco : null;
}

/**
 * The category whose kit limits apply (R-i): the principal's stored
 * `prodshopee.category_id`, keyed by the ERP component whose address IS the
 * principal. With no principal on a create arm, the kit's ONE distinct Shopee
 * item (the default main `escolherPrincipalDoKit` will pick) — and none when the
 * resolved components span 2+ items, whose main the operator must name.
 */
function categoriaDoPrincipal(
  principal: EnderecoShopeeDoComponente | null,
  resolucao: ContextoKit['resolucao'],
  categoriaPorProduto: ContextoKit['categoriaPorProduto'],
): number | null {
  const resolvidos = [...resolucao.entries()].flatMap(([produtoId, r]) =>
    r.ok ? [{ produtoId, endereco: r.endereco }] : [],
  );
  const itemAlvo =
    principal?.itemId ??
    (new Set(resolvidos.map((r) => r.endereco.itemId)).size === 1
      ? (resolvidos[0]?.endereco.itemId ?? null)
      : null);
  if (itemAlvo === null) return null;
  for (const r of resolvidos) {
    if (r.endereco.itemId !== itemAlvo) continue;
    // ⚠️ The ITEM decides, never the model: every model of one listing shares the
    // listing's category, and the stored value lives on the listing link.
    const categoria = categoriaPorProduto.get(r.produtoId) ?? null;
    if (categoria !== null) return categoria;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                   preparar                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read the whole graph of ONE native-kit run, in the module header's order.
 *
 * @throws ShopeePublishBlockedError on a CREATE arm with any phase-A miss — all
 *   of them, aggregated, before the first Shopee read.
 */
export async function prepararKit(
  deps: PrepararPublicacaoDeps,
  entrada: EntradaDeKit,
  arma: ArmaDeKit,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<ContextoKitPreparado> {
  const db = deps.db;
  const ehCriacao = arma.arma !== 'kit-atualizar';

  /* ---- 1. Firestore, all of it, before anything else. --------------------- */
  const produtoSnap = await produtoCollection.docRef(db, {}, entrada.produtoId).get();
  if (!produtoSnap.exists) {
    // The entry point (PR 7) answers an absent produto with a 404 before an arm
    // is chosen, so reaching here is a caller defect, never an operator's.
    throw new Error(`prepararKit: o produto ${entrada.produtoId} não existe`);
  }
  const raw = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  const produto = { id: entrada.produtoId, sku: textoOuNull(raw.sku), raw };

  const vinculos = await lerVinculosDeK(deps, produto.id);
  const alvo = alvoDoArma(arma, vinculos);

  const descricao = await lerDescricao(db, produto.id);
  const filhosCrus = [...(await lerFilhos(db, produto.id))];
  const grupos = await lerGrupos(db, filhosCrus);

  const precoDoPai = {
    precos: raw.precos,
    propagaPreco: propagaPrecoAosFilhos(raw.propagatePriceToChildren),
  };
  const tabelaNormalId = idDeRefOuNull(deps.tabelaNormalOuterRef);
  const projetados = await Promise.all(
    filhosCrus.map((filho) =>
      // The kit reads only the PRICE off this projection (and the ordem/SKU);
      // the empty link list and stock map leave its stock fields inert.
      filhoParaPublicar(db, deps, filho, precoDoPai, tabelaNormalId, [], {}),
    ),
  );

  // ⚠️ The axis is the ERP's INTENT — the distinct grupos the children's fake
  // paths name — not merely the grupos that could be read: an unreadable grupo
  // is still a second axis.
  const grupoIds = [
    ...new Set(
      filhosCrus.flatMap((f) =>
        (Array.isArray(f.raw.variacoesUid) ? (f.raw.variacoesUid as unknown[]) : []).flatMap(
          (c) => {
            const p = typeof c === 'string' ? parseFakePath(c) : null;
            return p === null ? [] : [p.grupoId];
          },
        ),
      ),
    ),
  ];
  const grupoLido = grupoIds.length === 1 ? grupos.find((g) => g.grupoId === grupoIds[0]) : null;
  const filhoUnicoId = textoOuNull(raw.filhoUnicoId);
  const familiaDeUm =
    ehFamiliaDeUm({ id: produto.id, paiId: textoOuNull(raw.paiId), filhoUnicoId }) &&
    filhosCrus.length === 1 &&
    filhosCrus[0]?.id === filhoUnicoId;
  const grupo =
    familiaDeUm || grupoIds.length !== 1
      ? null
      : { id: grupoIds[0]!, nome: grupoLido?.nome ?? grupoIds[0]! };

  const ordenados = filhosCrus
    .map((cru, i) => {
      const projetado = projetados[i]!;
      const varianteId = grupo === null ? null : varianteDoFilhoNoGrupo(projetado, grupo.id);
      // The tier OPTION TEXT is the variante's NAME in the grupo (step 11's tier
      // planner writes the same name), never its id.
      const varianteLida =
        varianteId === null
          ? undefined
          : grupoLido?.variacoes.find((v) => v.varianteId === varianteId);
      const filho: FilhoDoKit = {
        produtoId: cru.id,
        sku: textoOuNull(cru.raw.sku),
        ordem: projetado.ordem,
        componentesKit: componentesDe(cru.raw.componentesKit),
        // The SAME map unparsed — the stamp's input (R1-RT7-02).
        componentesKitArmazenado: mapaDeKitArmazenado(cru.raw.componentesKit),
        preco: projetado.preco,
        variante: varianteLida?.nome ?? null,
      };
      // R-8: the ONE tier lists its options in the GRUPO's order — step 11's
      // `montarTiers` walks `grupo.variacoes` — so a child's tier position is its
      // variante's index there; a child with no variante sorts last.
      return { filho, posicao: varianteLida?.ordem ?? Number.MAX_SAFE_INTEGER };
    })
    // The grupo's order (R-8), then `ordem` (absent last, step 11's rule), then
    // the id: ONE stable order the tier positions, the plan and every dry run
    // agree on. `planoKit.ts` reads the tier off THIS order.
    .sort(
      (a, b) =>
        a.posicao - b.posicao ||
        a.filho.ordem - b.filho.ordem ||
        (a.filho.produtoId < b.filho.produtoId ? -1 : 1),
    );
  const filhos: readonly FilhoDoKit[] = ordenados.map((o) => o.filho);

  const linhasDaConta = await lerLinhasDaConta(
    deps,
    filhos.map((f) => f.produtoId),
  );
  const linhasDoAnuncio =
    alvo === null
      ? []
      : linhasDaConta
          .filter((l) => l.linkDocId === alvo.linkDocId)
          .map(({ produtoId, docId, raw: r }) => ({ produtoId, docId, raw: r }));

  const raizesComOSku = ehCriacao ? await lerRaizesComOSku(deps, produto.sku) : null;

  /* ---- 2. phase A — Firestore-only refusals, before the first Shopee read. - */
  const faseA = problemasDaFaseA({
    arma,
    produto,
    filhos,
    familiaDeUm,
    grupo,
    gruposDistintos: grupoIds.length,
    descricao,
    alvo,
    raizesComOSku,
  });
  if (ehCriacao && temProblemaDeBloqueio(faseA)) {
    throw new ShopeePublishBlockedError({ produtoId: produto.id, itemId: null, problemas: faseA });
  }

  /* ---- 3. the Shopee reads. ----------------------------------------------- */
  // A named `--principal` rides the SAME batch even when no recipe names it:
  // resolved, it is an address `planejarKit` can refuse `principal-invalido`
  // about (naming it) instead of reading "no principal" and defaulting.
  const componenteIds = [
    ...new Set([
      ...filhos.flatMap((f) => Object.keys(f.componentesKit ?? {})),
      ...(entrada.principal === null ? [] : [entrada.principal]),
    ]),
  ];
  const resolvidos = await resolverComponentesDoKitErp(
    db,
    deps.client,
    deps.integracaoId,
    componenteIds,
  );
  const temModelos = new Map<number, boolean>(resolvidos.temModelos);

  // OP-8: a NAMED `--principal` that did not resolve refuses a create arm HERE,
  // right after the batch that resolved it and before the scan, the limits and
  // the photos — never read as "no principal" (which would default a one-item
  // kit's main or ask a two-item one for the principal the operator gave).
  const principalInvalido = problemaDoPrincipalSolicitado({
    arma,
    filhos,
    resolucao: resolvidos.resolucao,
    principalSolicitado: entrada.principal,
  });
  if (principalInvalido !== null) {
    throw new ShopeePublishBlockedError({
      produtoId: produto.id,
      itemId: null,
      problemas: [principalInvalido],
    });
  }

  let vivo: ContextoKit['vivo'] = null;
  if (arma.arma === 'kit-atualizar' && alvo !== null) {
    const itemId = idDeItemUtilizavel(alvo.raw.item_id);
    if (itemId !== null) {
      const lido = await lerKitVivo(deps.client, itemId);
      vivo = lido.vivo;
      // The live components' `has_model`, read by `lerAnuncioShopee` itself: the
      // ERP-resolved reading wins where both answered (same call, same field).
      for (const [id, tem] of lido.temModelos) if (!temModelos.has(id)) temModelos.set(id, tem);
    }
  }

  const principalPedido = enderecoDoPrincipal(entrada.principal, resolvidos.resolucao);
  // L1: a create NAMES the main; a republish READS it back from Shopee.
  const principal =
    arma.arma === 'kit-atualizar'
      ? vivo?.kit == null
        ? null
        : principalDoKitShopee(vivo.kit.model_list.map(linhasLidasDoModeloKit), temModelos)
      : principalPedido;

  const categoria = categoriaDoPrincipal(
    principal,
    resolvidos.resolucao,
    resolvidos.categoriaPorProduto,
  );
  const limites: LimitesKitLidos | null =
    categoria === null ? null : await lerLimitesKitCached(deps.taxonomia, categoria);

  const canais = await lerCanaisDaLoja(deps.client);

  /* ---- 4. the L6 scan — create arms only (L10(4)). ------------------------ */
  // OURS and K's superseded kits, split by the plan's OWN reader — the very
  // call `planejarKit` makes, so the photo decision below and the plan's
  // `decidirKitNovo` read one derivation (#1369).
  const nativos = vinculosNativosDoKit(vinculos, alvo?.linkDocId ?? null);
  let busca: ContextoKit['busca'] = null;
  let nossosVivos: ReadonlyMap<number, string | null> = new Map();
  if (ehCriacao && produto.sku !== null) {
    busca = await localizarKitsPorSku(deps.client, db, {
      integracaoId: deps.integracaoId,
      sku: produto.sku,
      // `kit-criar` excludes nothing (an ordinary listing is not a kit row);
      // PR 6's recriar excludes its target's `item_id` here.
      excluirItemIds: new Set<number>(),
    });
    const listados = new Set(busca.achados.map((a) => a.itemId));
    nossosVivos = await lerStatusDosNossos(
      deps.client,
      [...nativos.nossos.keys()].filter((id) => !listados.has(id)),
    );
  }

  const contexto: ContextoKit = {
    arma,
    integracaoId: deps.integracaoId,
    produto,
    filhos,
    familiaDeUm,
    grupo,
    gruposDistintos: grupoIds.length,
    descricao,
    resolucao: resolvidos.resolucao,
    temModelos,
    categoriaPorProduto: resolvidos.categoriaPorProduto,
    principal,
    principalPedido,
    principalSolicitado: entrada.principal,
    statusPedido: entrada.statusPedido,
    limites,
    canais,
    vinculos,
    alvo,
    vivo,
    linhasDoAnuncio,
    linhasDaConta,
    busca,
    nossosVivos,
  };

  /* ---- 5. LAST, the photos — only when this run will send content. --------- */
  // `kit-atualizar` sends `update_kit_item` only to a kit that READ live: a
  // carried phase-A miss refuses after the completion, and a target that reads
  // deleted (or not as a kit at all) refuses `listagem-removida` before it — so
  // neither spends an `upload_image` (PR 5's republish hook, S3F-17).
  const enviaConteudo = ehCriacao
    ? busca !== null &&
      decidirKitNovo(busca, nativos.nossos, nossosVivos, nativos.substituidos, nativos.sucessorDe)
        .acao === 'criar'
    : !temProblemaDeBloqueio(faseA) && vivo?.kit != null && !kitVivoRemovido(vivo, deps.nowMs);
  const fotos = enviaConteudo ? await resolverFotosDoKit(contexto, limites, resolvedor) : null;

  return { ...contexto, fotos };
}

/**
 * The target link of the arm: `kit-atualizar`'s named link (the dispatcher hands
 * only a live native link of THIS conta), `null` for a first create.
 */
function alvoDoArma(arma: ArmaDeKit, vinculos: readonly VinculoDaConta[]): ContextoKit['alvo'] {
  if (arma.arma !== 'kit-atualizar') return null;
  const achado = vinculos.find((v) => v.id === arma.linkDocId);
  if (achado === undefined) {
    // A link of another conta (or none) never reaches a kit arm: the dispatcher
    // reads this very list. Reaching here is a caller defect.
    throw new Error(`prepararKit: o vínculo ${arma.linkDocId} não é desta conta neste produto`);
  }
  return { linkDocId: achado.id, raw: achado.raw };
}

/**
 * K's own pictures through step 11's ONE resolver, capped by `planoKit.ts`'s
 * {@link tetoDeFotosDoKit} (R-3) — the SAME rule the plan slices the cover with
 * (OP-10), never a second copy. A kit carries no option images (R-8) and no size
 * chart (it syncs from the main), so those two passes are `null` by construction.
 */
async function resolverFotosDoKit(
  contexto: ContextoKit,
  limites: LimitesKitLidos | null,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<FotosResolvidas> {
  const cap = tetoDeFotosDoKit(
    limites !== null && limites.estado === 'servido' ? limites.limites : null,
  );
  const item = await resolvedor.resolver(fotosDe(contexto.produto.raw.fotos), { cap });
  return { item, imagensDeOpcao: null, tabelaDeMedidas: null, resumo: resolvedor.resumo() };
}
