/**
 * The publish PLAN as data (step 11, P2 §7) — one graph in, one derivation out.
 *
 * PURE: no Firestore, no Shopee call, no clock, no environment. It calls the
 * wave-4 mappers (`montarAnuncio`, `construirLogistica`, `montarTaxInfo`,
 * `montarTiers`, `reconciliarModelos`), concatenates their refusals and derives
 * {@link PlanoPublicacao.passos} — the step list the CLI's dry run prints AND
 * the one `publicarAnuncio.test.ts` asserts the applier executed. One
 * derivation, two readers: a hand-listed second copy is how a dry run starts
 * lying about what the publisher does.
 *
 * ## ⚠️ The photos are resolved BEFORE the plan exists, not after
 *
 * P2 §8.3 draws the upload as step 1 of `aplicar`, i.e. AFTER planning, and its
 * `PlanoPublicacao.fotos` carries the split (`reutilizadas` vs `aEnviar`) as two
 * lists. That shape cannot be built against the frozen resolver seam: the
 * resolver reads the `arquivos.externalIds` cache INSIDE its own async
 * `resolver()` (C7/C16), so nothing pure can know which pictures are cache hits;
 * and `montarAnuncio` needs the real `image_id[]` to build a body at all — an
 * empty list is `sem-fotos`, a refusal. So the order is inverted here: the
 * caller resolves the pictures, then plans, then applies.
 *
 * Two consequences a caller must know, both recorded rather than commented away:
 *
 *  1. A BLOCKED plan may already have paid for its uploads. That cost is paid
 *     ONCE — every `image_id` lands in `arquivos.externalIds` and the next
 *     publish reuses it — so it buys the operator a body that names every
 *     refusal instead of one that stops at "no pictures".
 *  2. {@link PassoPublicacao} spells the photo step `enviadas`, not the design's
 *     `aEnviar`. By the time the plan exists they are sent; a field named for
 *     the future would be a name denying what the value means.
 *
 * ## ⚠️ `plano.modelos` is PROVISIONAL on the update path
 *
 * `get_model_list` is deliberately NOT read while preparing (§2.8): a stale live
 * tree in the plan is the omission-deletes defect — `update_tier_variation` is a
 * FULL-LIST replace and a model missing from the list loses its mapping. So the
 * plan reconciles against `viva: null`, which is exact on a CREATE and a
 * PLACEHOLDER on an update, and `modelosPublicacao.ts` re-derives both mappers
 * against the FRESH reading before it sends anything. That is why
 * {@link PlanoPublicacao.modelosEntrada} exists: the applier re-runs the pure
 * pair from the same inputs rather than sending the plan's view.
 */
import {
  type ShopeeItemStatusWritable,
  type ShopeeLogisticsChannel,
  SHOPEE_ITEM_STATUS_WRITABLE,
} from '@delfrance/integrations-shopee';

import type { AtributosProjetados } from '../taxonomia/dto';
import type { VerdictoFolha } from '../taxonomia/categorias';
import type { LimitesDeItemLidos } from '../taxonomia/limites';
import { ESPERA_APOS_ADD_ITEM_MS, RELIST_PRIMEIRO } from './constantesAnuncio';
import {
  type ProblemaDeBloqueio,
  type ProblemaPublicacao,
  MOTIVO_PUBLICACAO_BLOQUEADA,
} from './errosPublicacao';
import type {
  FalhaDeFotoPublicacao,
  ResolvedorDeImagensShopee,
  ResultadoFotosPublicacao,
  ResumoFotosPublicacao,
} from './fotosPublicacao';
import type { ResultadoLeituraImposto } from './lerImpostoDoProduto';
import type { LinkDeVariacao } from './linkAnuncio';
import { type ResultadoLogistica, construirLogistica } from './logisticaPublicacao';
import {
  type ItemMontado,
  type LinkListagemLido,
  type ProdutoParaPublicar,
  dimensaoParaPublicar,
  montarAnuncio,
  pesoParaPublicar,
} from './montagemAnuncio';
import { type MotivoTaxInfoOmitido, montarTaxInfo } from './taxInfoPublicacao';
import {
  type BandaDeEstoque,
  type FilhoParaPublicar,
  type GrupoParaTier,
  type ModeloArmazenado,
  type PlanoDeModelos,
  type TierMontado,
  montarTiers,
  reconciliarModelos,
} from './tiersPublicacao';

/* -------------------------------------------------------------------------- */
/*                                   Inputs                                   */
/* -------------------------------------------------------------------------- */

/**
 * What `prepararPublicacao` hands the plan — the whole graph, read ONCE.
 *
 * ⚠️ **Declared here rather than in `publicarAnuncio.ts`**, which is written
 * after this file: the plan's input type belongs beside the plan, and a second
 * structural copy over there is exactly the two-declarations-one-shape drift the
 * app guide bans. `publicarAnuncio.ts` imports this name.
 *
 * Four fields beyond the reconciler's §2.8 listing, each forced by a wave-4
 * mapper that §2.8 had no input for — {@link ContextoPublicacao.integracaoId}
 * (`montarTiers` selects the grupo's binding entry by conta),
 * {@link ContextoPublicacao.tabelaNormalId},
 * {@link ContextoPublicacao.ownDisponivel} and
 * {@link ContextoPublicacao.disponivelByProdutoId} (`montarAnuncio`'s price and
 * kit-aware quantity).
 */
export interface ContextoPublicacao {
  /** The conta's BARE doc id — never an outerRef. */
  readonly integracaoId: string;
  readonly produto: ProdutoParaPublicar;
  /** `produtoExtraData.descricao`; the stored link's description WINS over it. */
  readonly descricao: string | null;
  readonly filhos: readonly FilhoParaPublicar[];
  readonly grupos: readonly GrupoParaTier[];
  readonly link: LinkListagemLido | null;
  readonly linkDocId: string | null;
  readonly linksDeVariacao: readonly LinkDeVariacao[];
  readonly limites: LimitesDeItemLidos;
  readonly atributos: AtributosProjetados;
  readonly veredictoFolha: VerdictoFolha;
  /** The route's optional body field (C36); `link.category_id` WINS over it. */
  readonly categoryId: number | null;
  readonly marca: { readonly brandId: number; readonly nome: string | null };
  /** `get_channel_list`, UNCACHED, one call per publish. */
  readonly canais: readonly ShopeeLogisticsChannel[];
  readonly imposto: ResultadoLeituraImposto;
  /** ONE resolver per publish — the item pass and the option pass share its memo. */
  readonly resolvedorDeImagens: ResolvedorDeImagensShopee;
  readonly ehAtualizacao: boolean;
  /** The status the OPERATOR asked for. See {@link PlanoPublicacao.statusInicial}. */
  readonly statusPedido: ShopeeItemStatusWritable;
  /**
   * ⚠️ The DOC ID of the conta's normal price list — the trailing segment of
   * `deps.tabelaNormalOuterRef`, folded by the composition root. A whole
   * outerRef resolves no price and the produto reads as priceless.
   */
  readonly tabelaNormalId: string | null;
  /** This produto's available stock at the conta's depósito. */
  readonly ownDisponivel: number;
  /** Kit component id → available, for `montarAnuncio`'s kit branch. */
  readonly disponivelByProdutoId: Record<string, number | null | undefined>;
  readonly nowMs: number;
}

/**
 * Everything the resolver produced for ONE publish, handed to the plan.
 *
 * ⚠️ `imagensDeOpcao` is ALL-OR-NONE and keyed by
 * `varianteFakePath(grupoId, varianteId)` — a variante identity, not a position
 * — so it survives the tier re-ordering the fresh `get_model_list` may impose.
 * A partial map yields NO image on any option (`montarTiers` re-applies the rule
 * defensively).
 */
export interface FotosResolvidas {
  /** The ITEM pass: `imageIds` in render ORDER, never re-sorted. */
  readonly item: ResultadoFotosPublicacao;
  readonly imagensDeOpcao: ReadonlyMap<string, string> | null;
  /** The running totals across every `resolver()` call of this publish. */
  readonly resumo: ResumoFotosPublicacao;
}

/**
 * The exact inputs `modelosPublicacao.ts` re-runs `montarTiers` and
 * `reconciliarModelos` with, against the FRESH `get_model_list`.
 *
 * ⚠️ It carries no live tree on purpose. `viva` is the ONE argument the applier
 * supplies, and it is the only one that can be stale.
 */
export interface EntradaDeModelos {
  readonly integracaoId: string;
  /** The PARENT produto id — the key `sincronizarLinksDeVariacao` reconciles by. */
  readonly produtoPaiId: string;
  /** The RESOLVED leaf category, read off the built `add_item` body. */
  readonly categoryId: number;
  readonly grupos: readonly GrupoParaTier[];
  readonly filhos: readonly FilhoParaPublicar[];
  readonly bandaDeEstoque: BandaDeEstoque | null;
  readonly imagensDeOpcao: ReadonlyMap<string, string> | null;
  readonly armazenados: readonly ModeloArmazenado[];
}

/* -------------------------------------------------------------------------- */
/*                                  The plan                                  */
/* -------------------------------------------------------------------------- */

/** One executable step of a publish. Eleven kinds, and nothing else runs. */
export type PassoPublicacao =
  | {
      readonly tipo: 'fotos';
      /**
       * ⚠️ `enviadas`, not P2 §7's `aEnviar` — the pictures are already up by
       * the time the plan exists. See the module header.
       */
      readonly enviadas: number;
      readonly reutilizadas: number;
    }
  | { readonly tipo: 'add_item'; readonly statusInicial: ShopeeItemStatusWritable }
  | { readonly tipo: 'update_item' }
  | { readonly tipo: 'esperar'; readonly ms: number }
  | { readonly tipo: 'init_tier_variation'; readonly tiers: number; readonly modelos: number }
  | { readonly tipo: 'update_tier_variation'; readonly modelos: number }
  | { readonly tipo: 'add_model'; readonly modelos: number }
  | { readonly tipo: 'update_model'; readonly modelos: number }
  | { readonly tipo: 'get_model_list' }
  | { readonly tipo: 'relistagem'; readonly ordem: readonly OrdemDeRelistagem[] }
  | { readonly tipo: 'leitura-de-volta' };

/** The two documented re-list paths, in the order they are tried. */
export type OrdemDeRelistagem = 'unlist' | 'update';

/**
 * The re-list order, DERIVED from the single literal `RELIST_PRIMEIRO`.
 *
 * ⚠️ Never a second literal: `constantesAnuncio.ts` owns the choice and one
 * annotation widens it to the union so the other arm is not narrowed away as
 * dead code. Flipping that constant flips this array and `pausarAnuncio.ts`'s
 * `reativar` fallback together.
 */
export const ORDEM_RELISTAGEM: readonly OrdemDeRelistagem[] =
  RELIST_PRIMEIRO === 'unlist' ? ['unlist', 'update'] : ['update', 'unlist'];

/** One publish, decided. Data only — nothing here executes and nothing throws. */
export interface PlanoPublicacao {
  readonly produtoId: string;
  readonly linkDocId: string | null;
  /** `null` on a first publish; a stored non-positive id folds to `null`. */
  readonly itemId: number | null;
  readonly ehAtualizacao: boolean;
  readonly temFilhos: boolean;
  /** What the OPERATOR asked for. */
  readonly statusPedido: ShopeeItemStatusWritable;
  /**
   * What `add_item` actually sends: `UNLIST` for a create WITH children (the
   * item is tiered while invisible, then re-listed), the requested status
   * otherwise. Unused on the update path — an update never carries `item_status`.
   */
  readonly statusInicial: ShopeeItemStatusWritable;
  readonly item: ItemMontado;
  readonly tiers: readonly TierMontado[];
  /** ⚠️ PROVISIONAL on the update path — see the module header. */
  readonly modelos: PlanoDeModelos;
  readonly modelosEntrada: EntradaDeModelos;
  readonly logistica: ResultadoLogistica;
  /** ONE field, whichever half refused: the reader's motivo or the mapper's. */
  readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  readonly fotos: FotosResolvidas;
  /** Pictures this publish could not resolve. Counted, never fatal. */
  readonly falhasDeFoto: readonly FalhaDeFotoPublicacao[];
  /** `null` unless the re-list dance is planned. */
  readonly relistagem: readonly OrdemDeRelistagem[] | null;
  readonly passos: readonly PassoPublicacao[];
  /**
   * ⚠️ NON-EMPTY means BLOCKED: nothing is sent, and the applier throws
   * `ShopeePublishBlockedError` before the first write. Hand it straight to
   * `temProblemaDeBloqueio`.
   */
  readonly problemas: readonly ProblemaDeBloqueio[];
}

/* -------------------------------------------------------------------------- */
/*                              Small pure helpers                            */
/* -------------------------------------------------------------------------- */

const MOTIVOS_DE_BLOQUEIO: ReadonlySet<string> = new Set<string>(
  Object.values(MOTIVO_PUBLICACAO_BLOQUEADA),
);

function ehBloqueio(problema: ProblemaPublicacao): problema is ProblemaDeBloqueio {
  return MOTIVOS_DE_BLOQUEIO.has(problema.motivo);
}

/**
 * Narrow `montarAnuncio`'s wider `problemas` to the blocked vocabulary.
 *
 * TOTAL by construction — every motivo that module produces, and every one it
 * relays from the channel builder, is a `MotivoPublicacaoBloqueada` member, and
 * both files carry a test pinning their own coverage set. The three
 * wire-rejection motivos (`bloqueado-por-promocao`, `imposto-recusado`,
 * `desconhecido`) are reachable only from a Shopee ERROR, which no pure mapper
 * can see. A drop is therefore impossible; it is counted and warned rather than
 * silently filtered, because "impossible" is exactly the class of claim this
 * repo has watched drift.
 */
function bloqueiosDe(problemas: readonly ProblemaPublicacao[]): readonly ProblemaDeBloqueio[] {
  const bloqueios = problemas.filter(ehBloqueio);
  if (bloqueios.length !== problemas.length) {
    console.warn('[shopee/anuncios] problema fora do vocabulário de bloqueio ao planejar', {
      total: problemas.length,
      bloqueios: bloqueios.length,
    });
  }
  return bloqueios;
}

/**
 * The child whose price and stock become the item-level throwaway of a
 * create-with-children.
 *
 * Smallest `ordem` wins; a tie is broken by the produto id in plain code-unit
 * order, so two children sharing an `ordem` cannot make one publish disagree
 * with the next. ⚠️ Never `localeCompare` — it is locale-dependent.
 */
export function primeiroFilhoDoItem(
  filhos: readonly FilhoParaPublicar[],
): FilhoParaPublicar | null {
  let melhor: FilhoParaPublicar | null = null;
  for (const filho of filhos) {
    if (melhor === null) {
      melhor = filho;
      continue;
    }
    if (filho.ordem < melhor.ordem) {
      melhor = filho;
      continue;
    }
    if (filho.ordem === melhor.ordem && filho.produtoId < melhor.produtoId) melhor = filho;
  }
  return melhor;
}

/**
 * Whether the tier/model leg runs at all.
 *
 * ONE rule, read by BOTH halves: the plan derives its `passos` from it and
 * `aplicarModelos` decides whether to open the leg with it. A produto with no
 * children AND no stored child links has no models to reconcile, so the leg
 * emits zero Shopee calls and runs no sync — a sync over an empty reading would
 * MARK every stored link as unavailable.
 */
export function legDeModelosNecessario(entrada: EntradaDeModelos): boolean {
  return entrada.filhos.length > 0 || entrada.armazenados.length > 0;
}

/**
 * The tier/model leg's steps, derived from a `PlanoDeModelos`.
 *
 * ⚠️ The ONE derivation, called twice with two different readings: by
 * {@link planejarPublicacao} with the provisional reconciliation (so the CLI's
 * dry run can print a leg) and by `aplicarModelos` with the FRESH one (so a test
 * can compare what ran against what was decided). A second hand-listed copy is
 * how the dry run and the publisher start disagreeing.
 *
 * `leraFresco` is the update path's opening `get_model_list`; the closing
 * reconciliation read is emitted exactly when something was SENT, because a leg
 * that sent nothing already holds a current reading.
 */
export function passosDoLegDeModelos(
  plano: PlanoDeModelos,
  tiers: number,
  leraFresco: boolean,
): readonly PassoPublicacao[] {
  const passos: PassoPublicacao[] = [];
  if (leraFresco) passos.push({ tipo: 'get_model_list' });

  if (plano.acao === 'init') {
    passos.push({ tipo: 'init_tier_variation', tiers, modelos: plano.novos.length });
  } else if (plano.acao === 'update') {
    passos.push({ tipo: 'update_tier_variation', modelos: plano.modelList.length });
    if (plano.novos.length > 0) passos.push({ tipo: 'add_model', modelos: plano.novos.length });
    if (plano.atualizarSku.length > 0) {
      passos.push({ tipo: 'update_model', modelos: plano.atualizarSku.length });
    }
  }

  if (plano.acao !== 'nenhuma') passos.push({ tipo: 'get_model_list' });
  return passos;
}

/* -------------------------------------------------------------------------- */
/*                             planejarPublicacao                             */
/* -------------------------------------------------------------------------- */

/**
 * The whole publish, decided from the prepared graph and the resolved pictures.
 *
 * It never throws and it never writes. A plan whose `problemas` is non-empty is
 * a BLOCKED plan: its `passos` carries the photo step ALONE — the only thing
 * that already ran — and the applier raises `ShopeePublishBlockedError` before
 * the first Shopee write.
 *
 * ⚠️ The refusals are the UNION of the item mapper's and the tier mapper's, in
 * that order. The channel builder's are NOT concatenated again: `montarAnuncio`
 * already relays them, and a second copy would report one broken shop channel
 * twice.
 */
export function planejarPublicacao(
  contexto: ContextoPublicacao,
  fotos: FotosResolvidas,
): PlanoPublicacao {
  const { produto, filhos } = contexto;
  const temFilhos = filhos.length > 0;
  const itemId = itemIdUtilizavel(contexto.link);

  const statusInicial =
    !contexto.ehAtualizacao && temFilhos
      ? SHOPEE_ITEM_STATUS_WRITABLE.unlist
      : contexto.statusPedido;

  const logistica = construirLogistica({
    canais: contexto.canais,
    armazenado: contexto.link?.logistic_info ?? null,
    pesoKg: pesoParaPublicar(produto),
    dimensaoCm: dimensaoParaPublicar(produto),
    ofereceFreteGratis: produto.ofereceFreteGratis,
  });

  const { taxInfo, omitido } = montarTaxInfo(contexto.imposto.imposto);
  const taxInfoOmitido = contexto.imposto.motivo ?? omitido;

  const primeiro = primeiroFilhoDoItem(filhos);

  const item = montarAnuncio({
    produto,
    descricao: contexto.descricao,
    link: contexto.link,
    limites: contexto.limites,
    atributos: contexto.atributos,
    veredictoFolha: contexto.veredictoFolha,
    categoryId: contexto.categoryId,
    marca: contexto.marca,
    logistica,
    taxInfo: { taxInfo, omitido },
    imagens: fotos.item.imageIds,
    ehAtualizacao: contexto.ehAtualizacao,
    statusPedido: statusInicial,
    temFilhos,
    tabelaNormalId: contexto.tabelaNormalId,
    precoDoPrimeiroFilho: primeiro?.preco ?? null,
    estoqueDoPrimeiroFilho: primeiro?.estoque ?? null,
    ownDisponivel: contexto.ownDisponivel,
    disponivelByProdutoId: contexto.disponivelByProdutoId,
  });

  // ⚠️ The RESOLVED leaf category, read off the body the item mapper built —
  // never re-deriving `link.category_id ?? contexto.categoryId` here. Two copies
  // of one cascade is how the tiers get authored against a different category
  // than the item was.
  const categoryId = item.criar.category_id;

  const modelosEntrada: EntradaDeModelos = {
    integracaoId: contexto.integracaoId,
    produtoPaiId: produto.id,
    categoryId,
    grupos: contexto.grupos,
    filhos,
    bandaDeEstoque: contexto.limites.limites.stockLimit,
    imagensDeOpcao: fotos.imagensDeOpcao,
    armazenados: armazenadosDeLinks(contexto.linksDeVariacao, filhos),
  };

  const montagemTiers = montarTiers({ ...entradaParaTiers(modelosEntrada), viva: null });
  const modelos = reconciliarModelos({
    montados: montagemTiers.modelos,
    armazenados: modelosEntrada.armazenados,
    viva: null,
    profundidadeNossa: montagemTiers.tiers.length,
  });

  const problemas: readonly ProblemaDeBloqueio[] = [
    ...bloqueiosDe(item.problemas),
    ...montagemTiers.problemas,
  ];

  const passoFotos: PassoPublicacao = {
    tipo: 'fotos',
    enviadas: fotos.resumo.enviadas,
    reutilizadas: fotos.resumo.reutilizadas,
  };

  const relistagem =
    !contexto.ehAtualizacao &&
    temFilhos &&
    contexto.statusPedido === SHOPEE_ITEM_STATUS_WRITABLE.normal
      ? ORDEM_RELISTAGEM
      : null;

  const passos =
    problemas.length > 0
      ? [passoFotos]
      : [
          passoFotos,
          contexto.ehAtualizacao
            ? ({ tipo: 'update_item' } as const)
            : ({ tipo: 'add_item', statusInicial } as const),
          ...(!contexto.ehAtualizacao && temFilhos
            ? [{ tipo: 'esperar', ms: ESPERA_APOS_ADD_ITEM_MS } as const]
            : []),
          ...passosDoLegDeModelos(
            modelos,
            montagemTiers.tiers.length,
            contexto.ehAtualizacao && legDeModelosNecessario(modelosEntrada),
          ),
          ...(relistagem !== null ? [{ tipo: 'relistagem', ordem: relistagem } as const] : []),
          { tipo: 'leitura-de-volta' } as const,
        ];

  return {
    produtoId: produto.id,
    linkDocId: contexto.linkDocId,
    itemId,
    ehAtualizacao: contexto.ehAtualizacao,
    temFilhos,
    statusPedido: contexto.statusPedido,
    statusInicial,
    item,
    tiers: montagemTiers.tiers,
    modelos,
    modelosEntrada,
    logistica,
    taxInfoOmitido,
    fotos,
    falhasDeFoto: fotos.item.falhas,
    relistagem,
    passos,
    problemas,
  };
}

/**
 * The tier mapper's arguments, minus the one the applier supplies.
 *
 * Exported so `modelosPublicacao.ts` re-runs `montarTiers` from EXACTLY what the
 * plan used, with `viva` as the only difference.
 */
export function entradaParaTiers(entrada: EntradaDeModelos): {
  readonly integracaoId: string;
  readonly categoryId: number;
  readonly grupos: readonly GrupoParaTier[];
  readonly filhos: readonly FilhoParaPublicar[];
  readonly bandaDeEstoque: BandaDeEstoque | null;
  readonly imagensDeOpcao: ReadonlyMap<string, string> | null;
} {
  return {
    integracaoId: entrada.integracaoId,
    categoryId: entrada.categoryId,
    grupos: entrada.grupos,
    filhos: entrada.filhos,
    bandaDeEstoque: entrada.bandaDeEstoque,
    imagensDeOpcao: entrada.imagensDeOpcao,
  };
}

/** A stored `item_id` that is not a positive number is "no listing yet". */
function itemIdUtilizavel(link: LinkListagemLido | null): number | null {
  const bruto = link?.item_id ?? null;
  return typeof bruto === 'number' && Number.isFinite(bruto) && bruto > 0 ? bruto : null;
}

/**
 * The stored child links, projected for `reconciliarModelos`.
 *
 * ⚠️ `model_sku` is NOT a field of `variacaoShopeeLinkSchema`; OUR sku for a
 * model is the CHILD produto's, which is also what `montarTiers` sends. Joining
 * here is what lets `mesmoModelo`'s sku rung recover a child whose `model_id` an
 * earlier `init_tier_variation` invalidated.
 *
 * A link whose stored `model_id` is unusable arrives as `0` — the sentinel the
 * reconciler and the sync both already refuse to bind.
 */
function armazenadosDeLinks(
  links: readonly LinkDeVariacao[],
  filhos: readonly FilhoParaPublicar[],
): readonly ModeloArmazenado[] {
  const skuPorProduto = new Map(filhos.map((f) => [f.produtoId, f.sku]));
  return links.map((link) => ({
    produtoId: link.produtoId,
    linkDocId: link.linkDocId,
    modelId: link.modelId ?? 0,
    modelSku: skuPorProduto.get(link.produtoId) ?? null,
    tierIndex: link.tierIndex,
  }));
}
