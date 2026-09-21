/**
 * The INVERSE of step 9's tier reading: ERP grupos + variantes + the operator's
 * `linksVariacoesShopee` bindings → Shopee's `standardise_tier_variation[]` and
 * `model[]`, plus the reconciliation of what we would send against what the
 * listing already holds (#1519, step 11).
 *
 * PURE — no Firestore, no Shopee call, no clock, no `next/server`. Everything it
 * needs about the live listing arrives as {@link ArvoreVivaDoItem}, the shape of
 * one `get_model_list` payload, and the live tree is read through step 9's own
 * `tiersDoItem` rather than a second reader.
 *
 * ## The three things that decide whether a republish destroys a listing
 *
 * 1. **The tier ORDER is derived ONCE, on the create, and afterwards read off
 *    the live listing.** `update_tier_variation` may be used only *without
 *    changing the tier structure*, and `tier_index` is POSITIONAL — so
 *    re-deriving the order on every publish would silently permute every model's
 *    coordinates the day an operator edits a grupo's `ordem` or its name. See
 *    {@link ordenarTiers}.
 * 2. **On an update the option list of a tier STARTS as the live one, at the
 *    live indices**, and only then grows. Omitting a live model from
 *    `model_list` DELETES it, and an option that moves index moves every model
 *    that sits on it. The union with "the options our children need" is what
 *    makes "never delete a model by omission" structural instead of a promise;
 *    when the union breaches a wire cap the publish is REFUSED, because refusing
 *    is recoverable and a dropped live model is not.
 * 3. **The identity fold is EXACT** — {@link mesmoModelo}, the only fold in this
 *    folder. A trim-and-lowercase rung would merge two different models and
 *    rewrite the wrong child's link document.
 *
 * ## ⚠️ The fold's SCOPE (root CLAUDE.md, #1372) — and why there is no inventory entry
 *
 * {@link mesmoModelo} decides that a STORED child link and a LIVE Shopee model
 * are the same model. What it treats as EQUAL: the same `model_id` however much
 * the `model_sku` was renamed at Seller Centre and however the options were
 * re-ordered — rung 1 dominates, and it dominates because
 * {@link reconciliarModelos} applies the rungs as PASSES over the candidate set
 * (rung 1 for every child, then rung 2, then rung 3), never as a fall-through
 * inside one `find`; a per-candidate fall-through hands the decision to
 * `get_model_list`'s row order. What must stay DISTINCT: `'az-p'` vs `'AZ-P'`
 * (rung 2 is byte-exact — no trim, no case fold), two EMPTY skus (emptiness is
 * not an identity), and `tier_index` `[0,1]` vs `[1,0]` (rung 3 is
 * element-wise and ORDERED, never a sorted or set comparison). The pair and the
 * three near-misses are the tests titled `⚠️ PAR` / `⚠️ QUASE` in
 * `tiersPublicacao.test.ts`.
 *
 * The fold is hand-rolled on purpose and files **no**
 * `equivalence-fold-inventory` entry: that guard matches a closed list of shared
 * helper names, none of which appears here, and an entry for a file naming none
 * of them reds the guard's own staleness assertion (C33).
 *
 * ## ⚠️ No local copy of a wire bound
 *
 * `SHOPEE_TIER_MAX_LEVELS` / `SHOPEE_TIER_MAX_OPTIONS` / `SHOPEE_MODEL_MAX_PER_ITEM`
 * are imported from `@delfrance/integrations-shopee`. The options cap in
 * particular was the conservative arm of a contradiction in Shopee's own pages
 * (20 and 50 on the same page) until the sandbox probe of 2026-09-17 accepted 21
 * options in one tier; a local copy here would have kept the refusing 20 alive
 * beside a comment claiming the two agreed.
 */
import {
  SHOPEE_MODEL_MAX_PER_ITEM,
  SHOPEE_TIER_MAX_LEVELS,
  SHOPEE_TIER_MAX_OPTIONS,
  type ShopeeModel,
  type ShopeeModelRequest,
  type ShopeeStandardiseTierVariation,
  type ShopeeTierVariation,
} from '@delfrance/integrations-shopee';
import {
  linkVariacoesShopeeSchema,
  parseFakePath,
  varianteFakePath,
  type Foto,
  type LinkVariacoesShopee,
} from '@delfrance/schemas';

import { tiersDoItem, type TierShopee } from '../produtos/taxonomiaShopeeCore';

import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  limitarMensagemProblema,
  type ProblemaDeBloqueio,
} from './errosPublicacao';

/* -------------------------------------------------------------------------- */
/*  The inputs                                                                 */
/* -------------------------------------------------------------------------- */

/** One ERP variante of a grupo, in the operator's own order. */
export interface VarianteDoTier {
  readonly varianteId: string;
  readonly nome: string;
  readonly ordem: number;
}

/**
 * One ERP `grupoDeVariacoes`, as the publisher reads it.
 *
 * `linksVariacoesShopee` stays `readonly unknown[] | null` because
 * `grupoDeVariacoesSchema` deliberately declares it as `z.array(z.unknown())` —
 * typing it in place would move a generated validator and both rules-gen
 * snapshots. It is parsed here, entry by entry, through
 * `linkVariacoesShopeeSchema`.
 */
export interface GrupoParaTier {
  readonly grupoId: string;
  readonly nome: string;
  readonly ordem: number;
  readonly permiteFotos: boolean;
  readonly variacoes: readonly VarianteDoTier[];
  readonly linksVariacoesShopee: readonly unknown[] | null;
}

/** One child produto (a variação) of the produto being published. */
export interface FilhoParaPublicar {
  readonly produtoId: string;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly ordem: number;
  /** Fake paths — `documents/grupoDeVariacoes/<g>/variacoes/<v>`. */
  readonly variacoesUid: readonly string[];
  readonly preco: number | null;
  readonly estoque: number;
  readonly fotos: readonly Foto[];
  /** The stored `variashopee.model_id`; `0`/null both mean "no usable id". */
  readonly linkModelId: number | null;
  readonly linkDocId: string | null;
  readonly tierIndexArmazenado: readonly number[] | null;
}

/**
 * The shop's `stock_limit` band, as `get_item_limit` reports it.
 *
 * ⚠️ Measured 2026-09-17: the sandbox refused `stock: 1` with
 * `Stock should be within 2-1000000 for model`. Below `min` is a REFUSAL, never
 * a clamp UP — rounding a child's stock up to a minimum publishes availability
 * the operator never authorised. Above `max` is clamped DOWN, which can only
 * under-state.
 *
 * Both members are independently nullable: a shop may report one bound and not
 * the other, and an absent bound must not be invented.
 */
export interface BandaDeEstoque {
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * One `get_model_list` payload, as this module consumes it.
 *
 * Structurally a `ShopeeModelList`, so the parsed response is assignable with no
 * projection. Both trees are nullable and both may be absent, in any
 * combination — that is the wire, not a defensive habit.
 */
export interface ArvoreVivaDoItem {
  readonly tier_variation: readonly ShopeeTierVariation[] | null;
  readonly standardise_tier_variation: readonly ShopeeStandardiseTierVariation[] | null;
  readonly model: readonly ShopeeModel[];
}

/** Everything {@link montarTiers} needs. */
export interface ArgsMontarTiers {
  /** The conta's BARE doc id — what `linkVariacoesShopee.integracaoShopeeId` holds. */
  readonly integracaoId: string;
  /** The item's LEAF category, which selects the grupo's binding entry. */
  readonly categoryId: number;
  readonly grupos: readonly GrupoParaTier[];
  readonly filhos: readonly FilhoParaPublicar[];
  readonly bandaDeEstoque: BandaDeEstoque | null;
  /** The FRESH `get_model_list` reading; `null`/absent = a first publish. */
  readonly viva?: ArvoreVivaDoItem | null;
  /**
   * `varianteFakePath(grupoId, varianteId)` → an already-uploaded `image_id`.
   *
   * Tier-1 only and ALL-OR-NONE: if one tier-1 option has no entry, NO option
   * image is sent at all (`error_tier_img_partial` is exactly this failure).
   */
  readonly imagensDeOpcao?: ReadonlyMap<string, string> | null;
}

/* -------------------------------------------------------------------------- */
/*  The outputs                                                                */
/* -------------------------------------------------------------------------- */

/** One authored tier option. */
export interface OpcaoMontada {
  /** `null` when the option exists ONLY to hold a live model's position. */
  readonly varianteId: string | null;
  readonly variation_option_id: number;
  readonly variation_option_name: string;
  readonly image_id: string | null;
  /** A live model sits on this position and no child of this publish claims it. */
  readonly ocupadaPorModeloSemFilho: boolean;
}

/** One authored tier, in the position it will occupy on the wire. */
export interface TierMontado {
  readonly grupoId: string;
  /** `0` = a CUSTOM variation — a VALUE, never an absence. */
  readonly variation_id: number;
  /** Sent only when non-zero. */
  readonly variation_group_id: number | null;
  /** Sent **iff** `variation_id === 0` (`announcement 873`). */
  readonly variation_name: string | null;
  readonly opcoes: readonly OpcaoMontada[];
}

/**
 * One model, with the ERP identity the link write-back needs beside the wire
 * fields.
 *
 * ⚠️ `model_sku` is ABSENT (never `''`) when the child has none: on
 * `update_model` an empty string is the documented DELETE. It is optional on
 * `add_model` and REQUIRED on `update_model`, which is why
 * {@link PlanoDeModelos.atualizarSku} carries it as a required string and this
 * shape does not.
 */
export interface ModeloMontado {
  /** The CHILD produto id — what the `variashopee` write-back is keyed on. */
  readonly produtoId: string;
  readonly linkDocId: string | null;
  readonly tier_index: readonly number[];
  readonly original_price: number;
  readonly seller_stock: readonly { readonly stock: number }[];
  readonly model_sku?: string;
  readonly gtin_code?: string;
}

/** What {@link montarTiers} answers. */
export interface ResultadoMontarTiers {
  readonly tiers: readonly TierMontado[];
  readonly modelos: readonly ModeloMontado[];
  /**
   * Every refusal found, in the order checked — the FIRST is the headline
   * motivo a `ShopeePublishBlockedError` reports. A non-empty list means the
   * publish must not proceed; `tiers`/`modelos` are then a partial reading kept
   * for the log, never a body to send.
   */
  readonly problemas: readonly ProblemaDeBloqueio[];
}

/** A stored `variashopee` child link, as {@link mesmoModelo} compares it. */
export interface ModeloArmazenado {
  readonly produtoId: string;
  readonly linkDocId: string;
  /** `0` = no usable stored id (Shopee's "this item has no variation" sentinel). */
  readonly modelId: number;
  readonly modelSku: string | null;
  readonly tierIndex: readonly number[];
}

/** Everything {@link reconciliarModelos} needs. */
export interface ArgsReconciliar {
  readonly montados: readonly ModeloMontado[];
  readonly armazenados: readonly ModeloArmazenado[];
  /** The FRESH `get_model_list` reading — NEVER the stored links. */
  readonly viva: ArvoreVivaDoItem | null;
  /** `montarTiers(...).tiers.length`. */
  readonly profundidadeNossa: number;
}

/**
 * The tier/model leg as DATA — what `modelosPublicacao.ts` (wave 5) executes.
 *
 * ⚠️ On `acao: 'init'`, {@link PlanoDeModelos.novos} is the COMPLETE `model[]`
 * of `init_tier_variation` and {@link PlanoDeModelos.modelList} is empty; on
 * `acao: 'update'`, `novos` is the delta for `add_model` and `modelList` is the
 * FULL `update_tier_variation.model_list`. `add_model` runs AFTER
 * `update_tier_variation`, because a new combination's position has to exist
 * before a model can be placed on it (`error_param: Model tier_index error`).
 */
export interface PlanoDeModelos {
  readonly acao: 'init' | 'update' | 'nenhuma';
  readonly mudouProfundidade: boolean;
  readonly modelList: readonly {
    readonly model_id: number;
    readonly tier_index: readonly number[];
  }[];
  readonly novos: readonly ModeloMontado[];
  readonly atualizarSku: readonly {
    readonly model_id: number;
    readonly model_sku: string;
    readonly gtin_code?: string;
  }[];
  readonly modelosSemFilho: readonly {
    readonly model_id: number;
    readonly tier_index: readonly number[];
    readonly model_sku: string | null;
  }[];
  /** Stored links whose model is gone. The MARK itself is `sincronizarLinksDeVariacao`'s. */
  readonly desaparecidos: readonly {
    readonly produtoId: string;
    readonly linkDocId: string;
    readonly modelId: number;
  }[];
}

/* -------------------------------------------------------------------------- */
/*  Small exact helpers — no shared fold helper reaches this folder            */
/* -------------------------------------------------------------------------- */

/** Plain code-unit comparison. ⚠️ Never `localeCompare`: it is locale-dependent. */
function compararCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Element-wise, ORDERED, exact. A sorted or set comparison is a different question. */
function mesmoTierIndex(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (const [i, valor] of a.entries()) if (valor !== b[i]) return false;
  return true;
}

/**
 * The last non-empty path segment.
 *
 * ⚠️ `linkVariacoesShopee.integracaoShopeeId` is a BARE doc id (trap 2 of its
 * schema), but that schema deliberately stores whatever it is given — so a
 * migrated entry may still hold `documents/integracao/<id>`. Both forms must
 * bind, and normalising the stored value would need a migration.
 */
function ultimoSegmento(valor: string): string {
  const partes = valor.split('/').filter((p) => p.length > 0);
  return partes.length > 0 ? partes[partes.length - 1]! : '';
}

function problema(
  campo: string,
  motivo: ProblemaDeBloqueio['motivo'],
  mensagem: string,
): ProblemaDeBloqueio {
  return { campo, motivo, mensagem: limitarMensagemProblema(mensagem) };
}

/** The `(integração, category)` binding entry of one grupo, or `null`. */
function entradaDoGrupo(
  grupo: GrupoParaTier,
  integracaoId: string,
  categoryId: number,
): LinkVariacoesShopee | null {
  for (const bruto of grupo.linksVariacoesShopee ?? []) {
    const lido = linkVariacoesShopeeSchema.safeParse(bruto);
    if (!lido.success) continue;
    if (lido.data.category_id !== categoryId) continue;
    if (ultimoSegmento(lido.data.integracaoShopeeId) !== integracaoId) continue;
    return lido.data;
  }
  return null;
}

/** The child's variante id inside one grupo, or `null`. */
function varianteDoFilho(filho: FilhoParaPublicar, grupoId: string): string | null {
  for (const uid of filho.variacoesUid) {
    const lido = parseFakePath(uid);
    if (lido && lido.grupoId === grupoId) return lido.varianteId;
  }
  return null;
}

/** Which variante ids of each grupo the children of THIS publish actually use. */
function variantesUsadas(filhos: readonly FilhoParaPublicar[]): Map<string, Set<string>> {
  const porGrupo = new Map<string, Set<string>>();
  for (const filho of filhos) {
    for (const uid of filho.variacoesUid) {
      const lido = parseFakePath(uid);
      if (!lido) continue;
      const jaVistos = porGrupo.get(lido.grupoId) ?? new Set<string>();
      jaVistos.add(lido.varianteId);
      porGrupo.set(lido.grupoId, jaVistos);
    }
  }
  return porGrupo;
}

/* -------------------------------------------------------------------------- */
/*  The tier ORDER                                                             */
/* -------------------------------------------------------------------------- */

/** The live reading a grupo was paired with, or `null` on a create. */
interface ParDeTier {
  readonly grupo: GrupoParaTier;
  readonly vivo: TierShopee | null;
}

/** The live tree plus what is needed to match our grupos onto it. */
export interface ArvoreParaOrdenar {
  readonly tiers: readonly TierShopee[];
  readonly integracaoId: string;
  readonly categoryId: number;
}

/**
 * The CREATE order: the tuple sort, ascending.
 *
 * 1. `permiteFotos ? 0 : 1` — Shopee's option images are TIER-1 ONLY, so a
 *    photo-bearing grupo landing in tier 2 has unsendable images;
 * 2. `grupo.ordem` — the operator's own integer, compared as a NUMBER;
 * 3. `grupoId`, plain code-unit comparison.
 *
 * ⛔ Never the legacy key `'<permiteFotos><ordem><nome>'`
 * (`.old/.../models.dart:4587`): it is a lexicographic compare of concatenated
 * fields, so `ordem` 2 sorts AFTER 10, and renaming a grupo permutes the tiers —
 * which moves every model's `tier_index` and invalidates every stored
 * `model_id`.
 */
function ordemDeCriacao(grupos: readonly GrupoParaTier[]): GrupoParaTier[] {
  return [...grupos].sort((a, b) => {
    const fa = a.permiteFotos ? 0 : 1;
    const fb = b.permiteFotos ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (a.ordem !== b.ordem) return a.ordem - b.ordem;
    return compararCodeUnit(a.grupoId, b.grupoId);
  });
}

function parearTiers(
  grupos: readonly GrupoParaTier[],
  viva: ArvoreParaOrdenar | null,
): ParDeTier[] {
  if (!viva || viva.tiers.length === 0) {
    return ordemDeCriacao(grupos).map((grupo) => ({ grupo, vivo: null }));
  }

  const restantes = new Set(grupos.map((g) => g.grupoId));
  const pares: ParDeTier[] = [];

  for (const tierVivo of viva.tiers) {
    const casado = grupos.find((grupo) => {
      if (!restantes.has(grupo.grupoId)) return false;
      if (tierVivo.variationId !== 0) {
        const entrada = entradaDoGrupo(grupo, viva.integracaoId, viva.categoryId);
        return entrada != null && entrada.variation_id === tierVivo.variationId;
      }
      return grupo.nome === tierVivo.nome;
    });
    if (!casado) continue;
    restantes.delete(casado.grupoId);
    pares.push({ grupo: casado, vivo: tierVivo });
  }

  for (const grupo of ordemDeCriacao(grupos.filter((g) => restantes.has(g.grupoId)))) {
    pares.push({ grupo, vivo: null });
  }
  return pares;
}

/**
 * The tier order, in the position each grupo will occupy on the wire.
 *
 * **On a CREATE** (`viva` absent or empty) it is the deterministic tuple sort of
 * {@link ordemDeCriacao}.
 *
 * **On an UPDATE the order is NOT re-derived** — it is read off the LIVE
 * listing: each live tier claims the grupo whose binding entry carries its
 * non-zero `variation_id`, else the grupo whose NAME is byte-equal to the live
 * tier's; a grupo matching nothing is APPENDED in create order.
 * `update_tier_variation` may be used only "without changing the tier
 * structure", so re-deriving would permute `tier_index` for every model the day
 * an operator edits `ordem`.
 */
export function ordenarTiers(
  grupos: readonly GrupoParaTier[],
  viva?: ArvoreParaOrdenar | null,
): readonly GrupoParaTier[] {
  return parearTiers(grupos, viva ?? null).map((par) => par.grupo);
}

/**
 * Read one `get_model_list` payload's trees through step 9's own reader.
 *
 * ⚠️ `tiersDoItem` COMPACTS: a tier or option with no usable name and no
 * non-zero id is dropped, and every survivor carries its WIRE `indice` — the
 * raw coordinate `tier_index` addresses. Reading a compacted list with a raw
 * index binds a model to another option's variante.
 */
export function tiersVivosDe(viva: ArvoreVivaDoItem | null): readonly TierShopee[] {
  if (!viva) return [];
  return tiersDoItem({
    tiers: viva.tier_variation ?? [],
    padronizados: viva.standardise_tier_variation ?? [],
  });
}

/* -------------------------------------------------------------------------- */
/*  Option images — tier 1 only, all or none                                   */
/* -------------------------------------------------------------------------- */

/**
 * The photo that represents ONE tier option, in two rungs.
 *
 * 1. the FIRST child using this variante whose own `fotos` is non-empty ⇒ its
 *    first photo;
 * 2. else the first PARENT photo whose `variantePath` parses to this
 *    `(grupoId, varianteId)`;
 * 3. else `null`.
 *
 * ⚠️ It deliberately does **not** call the shared `fotosForVariacao`: that
 * helper's third rung falls back to EVERY parent photo, which would hand every
 * option the same first parent picture — a uniform, wrong image set published on
 * the listing. Answering `null` is what lets the all-or-none rule of
 * {@link montarTiers} refuse the whole set instead.
 *
 * The children are read in the order given; the caller orders them.
 */
export function fotoDaOpcaoDeTier(
  variante: VarianteDoTier,
  grupoId: string,
  filhos: readonly FilhoParaPublicar[],
  fotosDoPai: readonly Foto[],
): Foto | null {
  for (const filho of filhos) {
    if (varianteDoFilho(filho, grupoId) !== variante.varianteId) continue;
    const propria = filho.fotos[0];
    if (propria) return propria;
  }
  for (const foto of fotosDoPai) {
    if (typeof foto.variantePath !== 'string') continue;
    const lido = parseFakePath(foto.variantePath);
    if (lido && lido.grupoId === grupoId && lido.varianteId === variante.varianteId) return foto;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  montarTiers                                                                */
/* -------------------------------------------------------------------------- */

/** An option before the image pass and before `ocupadaPorModeloSemFilho`. */
interface OpcaoCrua {
  readonly varianteId: string | null;
  readonly variation_option_id: number;
  readonly variation_option_name: string;
}

/** Rebuild the RAW live option list from the compacted reading, by wire index. */
function opcoesVivasPorIndice(tier: TierShopee): {
  readonly lista: readonly (TierShopee['opcoes'][number] | null)[];
  readonly buraco: number;
} {
  let maior = -1;
  for (const opcao of tier.opcoes) if (opcao.indice > maior) maior = opcao.indice;
  const lista: (TierShopee['opcoes'][number] | null)[] = new Array<null>(maior + 1).fill(null);
  for (const opcao of tier.opcoes) lista[opcao.indice] = opcao;
  const buraco = lista.findIndex((o) => o === null);
  return { lista, buraco };
}

/** The variante (if any) an authored option binds, and the wire identity to send. */
function opcaoDaVariante(variante: VarianteDoTier, entrada: LinkVariacoesShopee): OpcaoCrua | null {
  const ligada = entrada.variationOptions.find((o) =>
    o.arakene_variation_id.includes(variante.varianteId),
  );
  if (ligada) {
    return {
      varianteId: variante.varianteId,
      variation_option_id: ligada.shopee_option_id,
      variation_option_name: ligada.shopee_option_name,
    };
  }
  if (entrada.variation_id === 0) {
    return {
      varianteId: variante.varianteId,
      variation_option_id: 0,
      variation_option_name: variante.nome,
    };
  }
  return null;
}

/** Which of our variantes a LIVE option already stands for, if any. */
function varianteDaOpcaoViva(
  viva: TierShopee['opcoes'][number],
  grupo: GrupoParaTier,
  entrada: LinkVariacoesShopee,
): VarianteDoTier | null {
  if (viva.optionId !== 0) {
    const ligada = entrada.variationOptions.find((o) => o.shopee_option_id === viva.optionId);
    if (ligada) {
      const casada = grupo.variacoes.find((v) =>
        ligada.arakene_variation_id.includes(v.varianteId),
      );
      if (casada) return casada;
    }
    return null;
  }
  const porNomeNaEntrada = entrada.variationOptions.find(
    (o) => o.shopee_option_id === 0 && o.shopee_option_name === viva.nome,
  );
  if (porNomeNaEntrada) {
    const casada = grupo.variacoes.find((v) =>
      porNomeNaEntrada.arakene_variation_id.includes(v.varianteId),
    );
    if (casada) return casada;
  }
  return grupo.variacoes.find((v) => v.nome === viva.nome) ?? null;
}

/**
 * ERP grupos + children → the tiers and models of one publish.
 *
 * The option set of a tier is **(the options our children need) ∪ (the options
 * live models occupy)**, and on an update the live options keep their live
 * INDEX: the base is the live list, ours are appended. That is what makes
 * "never delete a live model by omission" structural. When the union breaches a
 * wire cap the publish is REFUSED with `opcoes-demais` carrying the count —
 * refusing is recoverable, dropping a live model is not.
 *
 * Every refusal is collected; the caller aggregates them into ONE
 * `ShopeePublishBlockedError`.
 */
export function montarTiers(args: ArgsMontarTiers): ResultadoMontarTiers {
  const problemas: ProblemaDeBloqueio[] = [];
  /** ⚠️ `model_id <= 0` binds nothing, so it occupies no position either. */
  const vivos = (args.viva?.model ?? []).filter((m) => m.model_id > 0);
  const pares = parearTiers(args.grupos, {
    tiers: tiersVivosDe(args.viva ?? null),
    integracaoId: args.integracaoId,
    categoryId: args.categoryId,
  });
  const usadas = variantesUsadas(args.filhos);

  /* ---- the tiers, option by option -------------------------------------- */

  const cruas: { readonly grupo: GrupoParaTier; readonly opcoes: OpcaoCrua[] }[] = [];
  const tiersParciais: Omit<TierMontado, 'opcoes'>[] = [];

  for (const par of pares) {
    const { grupo } = par;
    const entrada = entradaDoGrupo(grupo, args.integracaoId, args.categoryId);
    if (!entrada) {
      problemas.push(
        problema(
          'standardise_tier_variation',
          MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          `O grupo de variações "${grupo.nome}" não tem vínculo com esta conta para a categoria ${String(args.categoryId)}.`,
        ),
      );
      continue;
    }

    const opcoes: OpcaoCrua[] = [];
    const jaAutoradas = new Set<string>();

    if (par.vivo) {
      const { lista, buraco } = opcoesVivasPorIndice(par.vivo);
      if (buraco >= 0) {
        problemas.push(
          problema(
            'standardise_tier_variation',
            MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
            `A opção na posição ${String(buraco)} do tier "${grupo.nome}" não pôde ser lida do anúncio e a posição não pode ser reescrita.`,
          ),
        );
        continue;
      }
      for (const viva of lista) {
        if (!viva) continue;
        const casada = varianteDaOpcaoViva(viva, grupo, entrada);
        opcoes.push({
          varianteId: casada?.varianteId ?? null,
          variation_option_id: viva.optionId,
          variation_option_name: casada?.nome ?? viva.nome,
        });
        if (casada) jaAutoradas.add(casada.varianteId);
      }
    }

    const usadasDoGrupo = usadas.get(grupo.grupoId) ?? new Set<string>();
    for (const variante of grupo.variacoes) {
      if (!usadasDoGrupo.has(variante.varianteId)) continue;
      if (jaAutoradas.has(variante.varianteId)) continue;
      const crua = opcaoDaVariante(variante, entrada);
      if (!crua) {
        problemas.push(
          problema(
            'standardise_tier_variation',
            MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
            `A variante "${variante.nome}" do grupo "${grupo.nome}" não está vinculada a nenhuma opção da variação padronizada ${String(entrada.variation_id)}.`,
          ),
        );
        continue;
      }
      jaAutoradas.add(variante.varianteId);
      opcoes.push(crua);
    }

    const chaves = new Map<string, string>();
    for (const opcao of opcoes) {
      if (opcao.varianteId === null) continue;
      const chave =
        opcao.variation_option_id !== 0
          ? `id:${String(opcao.variation_option_id)}`
          : `nome:${opcao.variation_option_name}`;
      const anterior = chaves.get(chave);
      if (anterior !== undefined) {
        problemas.push(
          problema(
            'standardise_tier_variation',
            MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada,
            `As variantes "${anterior}" e "${opcao.varianteId}" do grupo "${grupo.nome}" caem na mesma opção da Shopee — duas variações ocupariam um único modelo.`,
          ),
        );
        continue;
      }
      chaves.set(chave, opcao.varianteId);
    }

    tiersParciais.push({
      grupoId: grupo.grupoId,
      variation_id: entrada.variation_id,
      variation_group_id: entrada.variation_group_list !== 0 ? entrada.variation_group_list : null,
      variation_name: entrada.variation_id === 0 ? grupo.nome : null,
    });
    cruas.push({ grupo, opcoes });
  }

  /* ---- the caps ---------------------------------------------------------- */

  if (cruas.length > SHOPEE_TIER_MAX_LEVELS) {
    problemas.push(
      problema(
        'standardise_tier_variation',
        MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais,
        `${String(cruas.length)} níveis de variação; a Shopee aceita no máximo ${String(SHOPEE_TIER_MAX_LEVELS)}.`,
      ),
    );
  }
  for (const { grupo, opcoes } of cruas) {
    if (opcoes.length > SHOPEE_TIER_MAX_OPTIONS) {
      problemas.push(
        problema(
          'standardise_tier_variation',
          MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais,
          `O grupo "${grupo.nome}" ficaria com ${String(opcoes.length)} opções; a Shopee aceita no máximo ${String(SHOPEE_TIER_MAX_OPTIONS)}.`,
        ),
      );
    }
  }

  /* ---- the models -------------------------------------------------------- */

  const modelos: ModeloMontado[] = [];
  const vistos = new Map<string, string>();
  /**
   * ⚠️ A refused tier means no model can be PLACED at all — a `tier_index` short
   * of the tier count is not a body Shopee would take, so emitting one would add
   * a second, misleading refusal on top of the tier's own.
   */
  const tiersCompletos = cruas.length === args.grupos.length;

  for (const filho of tiersCompletos ? args.filhos : []) {
    const indices: number[] = [];
    let colocado = true;
    for (const { grupo, opcoes } of cruas) {
      const varianteId = varianteDoFilho(filho, grupo.grupoId);
      const posicao =
        varianteId === null ? -1 : opcoes.findIndex((o) => o.varianteId === varianteId);
      if (posicao < 0) {
        problemas.push(
          problema(
            'model',
            MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
            `A variação ${filho.produtoId} não tem posição no grupo "${grupo.nome}" e o modelo não pode ser colocado.`,
          ),
        );
        colocado = false;
        break;
      }
      indices.push(posicao);
    }
    if (!colocado) continue;

    const chave = indices.join(',');
    const anterior = vistos.get(chave);
    if (anterior !== undefined) {
      problemas.push(
        problema(
          'model',
          MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada,
          `As variações ${anterior} e ${filho.produtoId} caem na mesma combinação de opções.`,
        ),
      );
      continue;
    }
    vistos.set(chave, filho.produtoId);

    if (filho.preco === null) {
      problemas.push(
        problema(
          'model',
          MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
          `A variação ${filho.produtoId} não tem preço e a Shopee exige um original_price por modelo.`,
        ),
      );
      continue;
    }

    const min = args.bandaDeEstoque?.min ?? null;
    const max = args.bandaDeEstoque?.max ?? null;
    if (min !== null && filho.estoque < min) {
      problemas.push(
        problema(
          'model',
          MOTIVO_PUBLICACAO_BLOQUEADA.estoqueAbaixoDoMinimo,
          `A variação ${filho.produtoId} tem ${String(filho.estoque)} em estoque e a loja exige entre ${String(min)} e ${max === null ? '∞' : String(max)}.`,
        ),
      );
      continue;
    }
    const estoque = max !== null && filho.estoque > max ? max : filho.estoque;

    const sku = filho.sku !== null && filho.sku.length > 0 ? filho.sku : null;
    const gtin = filho.gtin !== null && filho.gtin.length > 0 ? filho.gtin : null;
    modelos.push({
      produtoId: filho.produtoId,
      linkDocId: filho.linkDocId,
      tier_index: indices,
      original_price: filho.preco,
      seller_stock: [{ stock: estoque }],
      ...(sku === null ? {} : { model_sku: sku }),
      ...(gtin === null ? {} : { gtin_code: gtin }),
    });
  }

  if (modelos.length > SHOPEE_MODEL_MAX_PER_ITEM) {
    problemas.push(
      problema(
        'model',
        MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais,
        `${String(modelos.length)} modelos; a Shopee aceita no máximo ${String(SHOPEE_MODEL_MAX_PER_ITEM)} por item.`,
      ),
    );
  }

  /* ---- images (tier 1 only, all or none) and the occupancy flag ----------- */

  const imagens = args.imagensDeOpcao ?? null;
  const tiers: TierMontado[] = cruas.map(({ grupo, opcoes }, t) => {
    const podeImagem = t === 0 && grupo.permiteFotos && opcoes.length > 0;
    const resolvidas =
      imagens === null || !podeImagem
        ? []
        : opcoes.map((o) =>
            o.varianteId === null
              ? undefined
              : imagens.get(varianteFakePath(grupo.grupoId, o.varianteId)),
          );
    const todas =
      resolvidas.length === opcoes.length &&
      resolvidas.every((id) => id !== undefined && id.length > 0);

    return {
      ...tiersParciais[t]!,
      opcoes: opcoes.map((o, j) => ({
        varianteId: o.varianteId,
        variation_option_id: o.variation_option_id,
        variation_option_name: o.variation_option_name,
        image_id: todas ? (resolvidas[j] ?? null) : null,
        ocupadaPorModeloSemFilho:
          vivos.some((m) => m.tier_index[t] === j) && !modelos.some((m) => m.tier_index[t] === j),
      })),
    };
  });

  return { tiers, modelos, problemas };
}

/** Project a {@link ModeloMontado} onto the wire shape, omitting what is absent. */
export function requisicaoDeModelo(modelo: ModeloMontado): ShopeeModelRequest {
  return {
    tier_index: modelo.tier_index,
    original_price: modelo.original_price,
    seller_stock: modelo.seller_stock,
    ...(modelo.model_sku === undefined ? {} : { model_sku: modelo.model_sku }),
    ...(modelo.gtin_code === undefined ? {} : { gtin_code: modelo.gtin_code }),
  };
}

/* -------------------------------------------------------------------------- */
/*  The ONE identity fold                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Is this STORED child link the same model as this LIVE Shopee model?
 *
 * Three rungs — {@link DEGRAUS_DO_MODELO} — and every one of them exact:
 *
 * 1. a non-zero stored `modelId` equal to `vivo.model_id` — `0` is Shopee's
 *    "this item has no variation" sentinel and binds nothing;
 * 2. both `model_sku` non-empty **after no normalisation at all** and `===`;
 * 3. `tierIndex` and `tier_index` of the same length and element-wise equal.
 *
 * ⚠️ This answers ONE pair. It is deliberately NOT how the reconciler chooses a
 * binding: {@link reconciliarModelos} runs the rungs as PASSES over the whole
 * live list, because asking "does ANY rung hit?" per candidate lets a weaker
 * rung on an earlier row beat rung 1 on a later one, and the row order is
 * Shopee's, not ours.
 *
 * ⚠️ PAIR (rung 1 dominates): a model renamed at Seller Centre and re-ordered is
 * still the same model. ⚠️ NEAR-MISSES: `'az-p'` is not `'AZ-P'`; two empty skus
 * are not an identity; `[0,1]` is not `[1,0]`. The module docblock says why a
 * softer fold rewrites the wrong child's link.
 */
const DEGRAUS_DO_MODELO: readonly ((a: ModeloArmazenado, v: ShopeeModel) => boolean)[] = [
  // 1. the stored id. `0` binds nothing — it is Shopee's "no variation" sentinel.
  (a, v) => a.modelId !== 0 && a.modelId === v.model_id,
  // 2. both skus non-empty and byte-equal. No trim, no case fold.
  (a, v) =>
    a.modelSku !== null &&
    a.modelSku.length > 0 &&
    v.model_sku !== null &&
    v.model_sku.length > 0 &&
    a.modelSku === v.model_sku,
  // 3. the coordinate, element-wise and ORDERED.
  (a, v) => mesmoTierIndex(a.tierIndex, v.tier_index),
];

export function mesmoModelo(armazenado: ModeloArmazenado, vivo: ShopeeModel): boolean {
  return DEGRAUS_DO_MODELO.some((degrau) => degrau(armazenado, vivo));
}

/* -------------------------------------------------------------------------- */
/*  reconciliarModelos                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The live tier depth, in the coordinate system `tier_index` actually uses.
 *
 * The models' own `tier_index` length is the strongest signal — the trees are
 * both nullable and both may be absent — so the raw tree lengths are only the
 * fallback when the item carries no model at all.
 */
function profundidadeViva(viva: ArvoreVivaDoItem | null): number {
  if (!viva) return 0;
  let maior = 0;
  for (const modelo of viva.model) {
    if (modelo.tier_index.length > maior) maior = modelo.tier_index.length;
  }
  if (maior > 0) return maior;
  return Math.max(viva.tier_variation?.length ?? 0, viva.standardise_tier_variation?.length ?? 0);
}

/**
 * What to send on the tier/model leg, as DATA.
 *
 * - **`model_list` is built from the FRESH `get_model_list`, never from the
 *   stored links.** `update_tier_variation` is a FULL-LIST replace and omission
 *   DELETES; the completeness guard lives in the sender, with no fallback.
 * - **A live model with no ERP child KEEPS its position** and is reported in
 *   `modelosSemFilho[]` — never removed, never overwritten.
 * - **A depth change ⇒ `init_tier_variation`**, which invalidates every
 *   `model_id`; the caller then re-reads `get_model_list` and rewrites every
 *   child link IN PLACE. No link document is ever deleted, on any path.
 * - **`update_model` only for `model_sku` / `gtin_code` drift.** It sets neither
 *   price nor stock. ⚠️ A child with NO sku produces no entry at all: sending
 *   `''` is the documented DELETE, and deleting a sku the operator set at Seller
 *   Centre is not a decision this module may take.
 * - A stored link whose model is gone comes back in `desaparecidos` as a REPORT;
 *   the MARK (`model_status` + `modeloAusenteEm`) is
 *   `linkAnuncio.ts`'s `sincronizarLinksDeVariacao`, the one writer.
 *
 * ⚠️ A live model whose `model_id` is not positive is skipped entirely: `0` is
 * the "no variation" sentinel, a link carrying it binds any line of any listing,
 * and it is not addressable by `update_tier_variation` either. Same rule as the
 * child-link reader's.
 */
export function reconciliarModelos(args: ArgsReconciliar): PlanoDeModelos {
  const vivos = (args.viva?.model ?? []).filter((m) => m.model_id > 0);
  const profundidade = profundidadeViva(args.viva);
  const mudouProfundidade = profundidade > 0 && profundidade !== args.profundidadeNossa;

  if (vivos.length === 0 || mudouProfundidade) {
    const acao: PlanoDeModelos['acao'] =
      args.montados.length === 0 && vivos.length === 0 ? 'nenhuma' : 'init';
    return {
      acao,
      mudouProfundidade,
      modelList: [],
      novos: acao === 'init' ? args.montados : [],
      atualizarSku: [],
      modelosSemFilho: [],
      desaparecidos: [],
    };
  }

  const porProduto = new Map(args.armazenados.map((a) => [a.produtoId, a]));
  const casados = new Map<number, ModeloMontado>();

  // ⚠️ The rungs are PASSES over the whole candidate set, never a fall-through
  // inside one `find`. Evaluated per live candidate, a WEAKER rung matching an
  // EARLIER row beats rung 1 matching a LATER one — so the binding would be
  // decided by `get_model_list`'s row order, which Shopee promises nothing
  // about. A stored `tier_index` that went stale while the stored `model_id` is
  // still live (an option re-ordered or deleted at Seller Centre, the window
  // every republish operates in) then binds two children to each other's
  // models: `update_tier_variation` is told to SWAP two live models and
  // `update_model` to swap their skus, and every later stock/price push for a
  // variação lands on the wrong line. Rung 1 first, across EVERY child: an id
  // that is live is not a stale id.
  const pendentes = args.montados.map((montado) => ({
    montado,
    armazenado: porProduto.get(montado.produtoId) ?? null,
    // The synthetic candidate — a child whose link is new, or whose stored id an
    // earlier `init_tier_variation` invalidated. Its `modelId` is `0`, so its
    // rung 1 binds nothing and only the sku/coordinate passes can hit.
    sintetico: {
      produtoId: montado.produtoId,
      linkDocId: montado.linkDocId ?? '',
      modelId: 0,
      modelSku: montado.model_sku ?? null,
      tierIndex: montado.tier_index,
    } satisfies ModeloArmazenado,
  }));

  /** Pass order: the three STORED rungs, then the synthetic sku and coordinate. */
  const passes: readonly { readonly degrau: number; readonly sintetico: boolean }[] = [
    { degrau: 0, sintetico: false },
    { degrau: 1, sintetico: false },
    { degrau: 2, sintetico: false },
    { degrau: 1, sintetico: true },
    { degrau: 2, sintetico: true },
  ];

  const restantes = new Set(pendentes);
  for (const passe of passes) {
    for (const pendente of [...restantes]) {
      const candidato = passe.sintetico ? pendente.sintetico : pendente.armazenado;
      if (candidato === null) continue;
      const casa = DEGRAUS_DO_MODELO[passe.degrau]!;
      const achado = vivos.find((v) => !casados.has(v.model_id) && casa(candidato, v));
      if (achado === undefined) continue;
      casados.set(achado.model_id, pendente.montado);
      restantes.delete(pendente);
    }
  }

  const novos: readonly ModeloMontado[] = [...restantes].map((p) => p.montado);

  const modelList = vivos.map((vivo) => {
    const nosso = casados.get(vivo.model_id);
    return { model_id: vivo.model_id, tier_index: nosso ? nosso.tier_index : vivo.tier_index };
  });

  const atualizarSku: PlanoDeModelos['atualizarSku'] = vivos.flatMap((vivo) => {
    const nosso = casados.get(vivo.model_id);
    if (!nosso || nosso.model_sku === undefined) return [];
    const skuDivergiu = nosso.model_sku !== (vivo.model_sku ?? '');
    const gtinDivergiu =
      nosso.gtin_code !== undefined && nosso.gtin_code !== (vivo.gtin_code ?? '');
    if (!skuDivergiu && !gtinDivergiu) return [];
    return [
      {
        model_id: vivo.model_id,
        model_sku: nosso.model_sku,
        ...(nosso.gtin_code === undefined ? {} : { gtin_code: nosso.gtin_code }),
      },
    ];
  });

  const modelosSemFilho = vivos
    .filter((vivo) => !casados.has(vivo.model_id))
    .map((vivo) => ({
      model_id: vivo.model_id,
      tier_index: vivo.tier_index,
      model_sku: vivo.model_sku,
    }));

  const desaparecidos = args.armazenados
    .filter((a) => a.modelId > 0 && !vivos.some((v) => v.model_id === a.modelId))
    .map((a) => ({ produtoId: a.produtoId, linkDocId: a.linkDocId, modelId: a.modelId }));

  const listaMudou = modelList.some(
    (linha, i) => !mesmoTierIndex(linha.tier_index, vivos[i]!.tier_index),
  );
  const acao: PlanoDeModelos['acao'] =
    listaMudou || novos.length > 0 || atualizarSku.length > 0 ? 'update' : 'nenhuma';

  return {
    acao,
    mudouProfundidade,
    modelList,
    novos,
    atualizarSku,
    modelosSemFilho,
    desaparecidos,
  };
}
