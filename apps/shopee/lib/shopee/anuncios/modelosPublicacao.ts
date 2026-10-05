/**
 * The tier/model IO leg of a publish (step 11, P2 §9).
 *
 * It owns EXACTLY five Shopee calls — `get_model_list`, `init_tier_variation`,
 * `update_tier_variation`, `add_model`, `update_model` — and every child-link
 * write. No other module under `anuncios/` makes any of them, which is what
 * makes "who calls what" answerable by file rather than by grep.
 *
 * ## ⚠️ The `model_list` comes from the FRESH read, never from the plan
 *
 * `update_tier_variation` is a FULL-LIST replace: a live model omitted from
 * `model_list` loses its mapping, and the package deliberately carries no
 * completeness guard because it cannot know which models are live. So this
 * module opens the update path with its own `get_model_list` and re-runs the two
 * PURE mappers (`montarTiers`, `reconciliarModelos`) against that reading, from
 * `plano.modelosEntrada` — the same inputs the plan used, with `viva` as the
 * only difference. The plan's own `modelos` is a provisional reconciliation
 * against `viva: null` (see `planoPublicacao.ts`'s header) and is NEVER sent.
 *
 * ## ⚠️ `get_model_list` is the authority; the write echo is a cross-check
 *
 * `init_tier_variation` answers `model[]` pairing `model_id` with `tier_index`,
 * but its own table types `tier_index` as `object[]`, it carries no
 * `model_status` (which the child-link schema needs), and an unreadable row
 * arrives as a `null` in place. So the pairing is compared by COUNT and a
 * mismatch is ONE `console.warn` — never a value that reaches a document.
 *
 * ## The child links, in three passes and one order
 *
 *  1. **Re-point** — `init_tier_variation` invalidates every `model_id`, so an
 *     existing child link is merged onto the fresh model at ITS `tier_index`
 *     before anything else looks at it. Reconciliation BY `model_id` cannot
 *     express this: the stored id is simply gone, so a sync would MARK every
 *     child unavailable and the mint pass would then create a SECOND link doc
 *     beside it. P2 §4's own instruction for this arm is "rewrite EVERY child
 *     link in place (new model_id + new tier_index)".
 *  2. **Sync** — `sincronizarLinksDeVariacao` (C10, `linkAnuncio.ts`): the ONE
 *     implementation, shared with `reverificarAnuncio.ts`. It refreshes what
 *     matches and MARKS what vanished; it never mints and never deletes.
 *  3. **Mint** — a live model with no child link, matched to one of OUR models
 *     by `tier_index`, becomes a new `variashopee` document through
 *     `aplicarLinkDaVariacao`. A model Shopee answered with `model_id: 0` is
 *     never written: `0` is the "this item has no variation" sentinel and a link
 *     carrying it binds any line of any listing.
 *
 * Clock-free (`deps.nowMs`) and wait-free: the pause between `add_item` and this
 * leg belongs to `publicarAnuncio.ts`, which owns `deps.esperar`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type {
  ShopeeClient,
  ShopeeModel,
  ShopeeStandardiseTierRequest,
  ShopeeTierWriteResponse,
} from '@delfrance/integrations-shopee';

import { aplicarLinkDaVariacao } from '../produtos/links';
import { dadosLinkVariacao } from '../produtos/mapeamento';
import { avisoDeShopee } from '../taxonomia/atributos';
import {
  type EtapaPublicacao,
  ETAPA_PUBLICACAO,
  ShopeePublishBlockedError,
  temProblemaDeBloqueio,
} from './errosPublicacao';
import { sincronizarLinksDeVariacao } from './linkAnuncio';
import {
  type EntradaDeModelos,
  type PassoPublicacao,
  type PlanoPublicacao,
  entradaParaTiers,
  legDeModelosNecessario,
  passosDoLegDeModelos,
} from './planoPublicacao';
import {
  type ArvoreVivaDoItem,
  type ModeloMontado,
  type TierMontado,
  montarTiers,
  reconciliarModelos,
  requisicaoDeModelo,
} from './tiersPublicacao';

/* -------------------------------------------------------------------------- */
/*                                    Deps                                    */
/* -------------------------------------------------------------------------- */

/**
 * The five listing calls this leg owns, and NOTHING else of the client.
 *
 * A `Pick` rather than the whole `ShopeeClient`: the ownership table becomes a
 * compile error instead of a convention, and the unit test's double implements
 * five methods instead of forty. `PublicarAnuncioDeps` is assignable as-is.
 */
export type ClienteDeModelos = Pick<
  ShopeeClient,
  'getModelList' | 'initTierVariation' | 'updateTierVariation' | 'addModel' | 'updateModel'
>;

export interface DepsModelos {
  readonly db: Firestore;
  readonly client: ClienteDeModelos;
  /** The conta's BARE doc id. */
  readonly integracaoId: string;
  /** ONE clock read per request, taken at the composition root. */
  readonly nowMs: number;
}

/* -------------------------------------------------------------------------- */
/*                                   Result                                   */
/* -------------------------------------------------------------------------- */

/** A live model nothing in this ERP binds. Reported, never bound. */
export interface ModeloSemVinculo {
  readonly model_id: number;
  readonly model_sku: string | null;
}

/** A stored child link whose model is gone from the listing. The MARK is the sync's. */
export interface VinculoDesaparecido {
  readonly produtoId: string;
  readonly modelId: number;
}

/**
 * What one model leg did.
 *
 * ⚠️ `atualizados` and `marcados` are the sync's WRITE counters, not
 * populations: a second run over an unchanged reading answers `0` for both while
 * the same models are still bound. The durable signal is the child link's stored
 * `model_status` / `modeloAusenteEm`. P2 §9 typed `marcados` as a LIST; the one
 * implementation of the sync answers a count, and the list of stored links whose
 * model vanished is {@link ResultadoModelos.desaparecidos}, which the
 * reconciliation already produced.
 */
export interface ResultadoModelos {
  readonly acao: 'init' | 'update' | 'nenhuma';
  /** Live models in the authoritative reading, `model_id > 0` only. */
  readonly total: number;
  /** Child links MINTED here. */
  readonly criados: number;
  /** Child links re-pointed after an `init_tier_variation` invalidated their id. */
  readonly repontados: number;
  /** Child links the sync REFRESHED. */
  readonly atualizados: number;
  /** Child links the sync newly MARKED `MODEL_UNAVAILABLE`. */
  readonly marcados: number;
  readonly semFilho: readonly ModeloSemVinculo[];
  readonly desaparecidos: readonly VinculoDesaparecido[];
  /**
   * Rows of the authoritative reading whose `model_id` is not usable (`0`,
   * absent, unreadable). Counted so a silent drop is visible; never bound.
   */
  readonly ignorados: number;
  /** Every non-noise envelope `warning` this leg collected, in call order. */
  readonly avisos: readonly string[];
  /** What actually ran, derived by the SAME function the plan's `passos` uses. */
  readonly passos: readonly PassoPublicacao[];
}

/* -------------------------------------------------------------------------- */
/*                            Small pure projections                          */
/* -------------------------------------------------------------------------- */

/**
 * `standardise_tier_variation[]` from the built tiers — a mechanical projection,
 * in ONE place so no caller spreads a `TierMontado` onto a wire body by hand.
 *
 * `variation_id` always; `variation_name` only when non-null (it is REQUIRED iff
 * `variation_id === 0` and FORBIDDEN otherwise); `variation_group_id` only when
 * non-null; `image_id` only when the option has one.
 *
 * ⚠️ `variation_option_id` is REQUIRED on `update_tier_variation` and `0` is
 * LEGAL there — the documented CUSTOM sentinel, a value and not an absence — so
 * it is always sent.
 */
export function padronizadasDeTiers(
  tiers: readonly TierMontado[],
): readonly ShopeeStandardiseTierRequest[] {
  return tiers.map((tier) => ({
    variation_id: tier.variation_id,
    ...(tier.variation_name !== null ? { variation_name: tier.variation_name } : {}),
    ...(tier.variation_group_id !== null ? { variation_group_id: tier.variation_group_id } : {}),
    variation_option_list: tier.opcoes.map((opcao) => ({
      variation_option_id: opcao.variation_option_id,
      variation_option_name: opcao.variation_option_name,
      ...(opcao.image_id !== null ? { image_id: opcao.image_id } : {}),
    })),
  }));
}

/**
 * `tier_index` equality — the coordinate that pairs one of OUR models with a
 * live one after a write.
 *
 * **PAIR:** `[0, 1]` ≡ `[0, 1]` — the same position, so the same model.
 * **NEAR-MISS:** `[0, 1]` and `[1, 0]` are DISTINCT, and so are `[0]` and
 * `[0, 0]`. `tier_index` names the option chosen at EACH tier level, in order; a
 * set or a length comparison would bind a child to the wrong variação, which is
 * exactly the identity defect `model_id: 0` already causes one collection over.
 *
 * ⚠️ Hand-rolled: the repo's shared deep-equality helper is an inventoried fold
 * helper and is banned under this folder, and a length-plus-element-wise
 * comparison is what the property actually is. It derives no key and folds
 * nothing — there is no `join`, so `[1, 23]` and `[12, 3]` cannot collide.
 */
function mesmaPosicao(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}

/** Our model occupying a live model's position, or `null`. */
function montadoNaPosicao(
  montados: readonly ModeloMontado[],
  tierIndex: readonly number[],
): ModeloMontado | null {
  return montados.find((m) => mesmaPosicao(m.tier_index, tierIndex)) ?? null;
}

/**
 * The response pairing, compared by COUNT only.
 *
 * `guide 211 §7` note 5 teaches a `get_model_list` re-read precisely because
 * this echo is not authoritative, and the payload tolerates a `null` row (the
 * models are already minted by the time it arrives). So a divergence is one log
 * line naming counts and an etapa token — never a value, never provider prose.
 */
function cruzarPareamento(
  resposta: ShopeeTierWriteResponse,
  esperados: number,
  etapa: EtapaPublicacao,
): void {
  const recebidos = resposta.response.model.filter((linha) => linha !== null).length;
  if (recebidos === esperados) return;
  console.warn('[shopee/anuncios] pareamento de modelos divergiu da resposta da Shopee', {
    etapa,
    esperados,
    recebidos,
  });
}

/* -------------------------------------------------------------------------- */
/*                                aplicarModelos                              */
/* -------------------------------------------------------------------------- */

/**
 * Run the tier/model leg of one publish.
 *
 * ⚠️ **A Shopee failure PROPAGATES.** Nothing here is caught: a rate limit, a
 * reauth, an `error_param` on the tier body and any Firestore error all reach
 * `publicarAnuncio.ts`, which stamps `falhaPublicacao` with the etapa and
 * rethrows. Swallowing one would leave a listing whose models disagree with its
 * links and no record of why.
 *
 * ⚠️ It CAN throw `ShopeePublishBlockedError`: the FRESH tree can make the tier
 * authoring unsendable (a live option position that cannot be read back, an
 * option union past the wire cap) where the plan's `viva: null` pass saw
 * nothing. The item already exists at that point, so the next publish resumes as
 * an update and runs this leg again — the resumability invariant, not a loss.
 *
 * @param itemId   the listing id, already confirmed by `add_item`/`update_item`
 * @param linkPaiId the PARENT link document id every child link points at
 */
export async function aplicarModelos(
  deps: DepsModelos,
  plano: PlanoPublicacao,
  itemId: number,
  linkPaiId: string,
): Promise<ResultadoModelos> {
  const entrada = plano.modelosEntrada;
  if (!legDeModelosNecessario(entrada)) return legaVazia();

  const avisos: string[] = [];

  /* 1 — the FRESH reading, on the update path only. ------------------------- */
  const viva: ArvoreVivaDoItem | null = plano.ehAtualizacao
    ? await deps.client.getModelList({ itemId })
    : null;

  /* 2 — re-derive both PURE mappers against it. ----------------------------- */
  const montagem = montarTiers({ ...entradaParaTiers(entrada), viva });
  if (temProblemaDeBloqueio(montagem.problemas)) {
    throw new ShopeePublishBlockedError({
      produtoId: entrada.produtoPaiId,
      itemId,
      problemas: montagem.problemas,
    });
  }
  const planoModelos = reconciliarModelos({
    montados: montagem.modelos,
    armazenados: entrada.armazenados,
    viva,
    profundidadeNossa: montagem.tiers.length,
  });

  const padronizadas = padronizadasDeTiers(montagem.tiers);

  /* 3 — the writes, in the ONE order Shopee accepts. ------------------------ */
  if (planoModelos.acao === 'init') {
    const resposta = await deps.client.initTierVariation({
      item_id: itemId,
      model: planoModelos.novos.map(requisicaoDeModelo),
      standardise_tier_variation: padronizadas,
    });
    coletarAviso(avisos, resposta.warning);
    cruzarPareamento(resposta, planoModelos.novos.length, ETAPA_PUBLICACAO.initTierVariation);
  } else if (planoModelos.acao === 'update') {
    // The FULL list, re-listing every live model — including the ones no child
    // binds. Omission DELETES a mapping, so a delta here is a silent data loss.
    const ack = await deps.client.updateTierVariation({
      item_id: itemId,
      model_list: planoModelos.modelList,
      standardise_tier_variation: padronizadas,
    });
    coletarAviso(avisos, ack.warning);

    if (planoModelos.novos.length > 0) {
      // ⚠️ AFTER `update_tier_variation`: a new combination's position has to
      // exist before a model can be placed on it (`error_param: Model
      // tier_index error`).
      const resposta = await deps.client.addModel({
        item_id: itemId,
        model_list: planoModelos.novos.map(requisicaoDeModelo),
      });
      coletarAviso(avisos, resposta.warning);
      cruzarPareamento(resposta, planoModelos.novos.length, ETAPA_PUBLICACAO.addModel);
    }

    if (planoModelos.atualizarSku.length > 0) {
      const ackSku = await deps.client.updateModel({
        item_id: itemId,
        model: planoModelos.atualizarSku,
      });
      coletarAviso(avisos, ackSku.warning);
    }
  }

  /* 4 — the authoritative reading. ------------------------------------------ */
  // A leg that SENT nothing already holds a current reading; re-reading it would
  // buy nothing and cost a call. A leg that sent something must re-read: only
  // `get_model_list` carries `model_status`, and only it pairs the ids Shopee
  // just minted with the positions we asked for.
  const leitura: ArvoreVivaDoItem | null =
    planoModelos.acao === 'nenhuma' ? viva : await deps.client.getModelList({ itemId });

  const passos = passosDoLegDeModelos(planoModelos, montagem.tiers.length, plano.ehAtualizacao);

  if (leitura === null) {
    // Nothing was sent and nothing was read — a create with stored links and no
    // children. There is no authoritative reading, so the sync must not run: it
    // would MARK every stored link against an empty model list.
    return {
      ...legaVazia(),
      acao: planoModelos.acao,
      desaparecidos: desaparecidosDe(planoModelos),
      avisos,
      passos,
    };
  }

  /* 5 — the child links: re-point, sync, mint. ------------------------------ */
  const modelos = leitura.model;
  const repontados =
    planoModelos.acao === 'init'
      ? await repontarVinculosDeModelo(deps, entrada, linkPaiId, montagem.modelos, modelos)
      : 0;

  const sincronia = await sincronizarLinksDeVariacao(
    deps.db,
    deps.integracaoId,
    entrada.produtoPaiId,
    modelos,
    deps.nowMs,
  );

  const mintagem = await criarVinculosDeModelo(
    deps,
    entrada,
    linkPaiId,
    montagem.modelos,
    modelos,
    sincronia.modelosSemFilho.map((m) => m.modelId),
  );

  return {
    acao: planoModelos.acao,
    total: modelos.filter((m) => m.model_id > 0).length,
    criados: mintagem.criados,
    repontados,
    atualizados: sincronia.atualizados,
    marcados: sincronia.marcados,
    semFilho: mintagem.restantes,
    desaparecidos: desaparecidosDe(planoModelos),
    ignorados: modelos.filter((m) => !(m.model_id > 0)).length,
    avisos,
    passos,
  };
}

/* -------------------------------------------------------------------------- */
/*                              The three passes                              */
/* -------------------------------------------------------------------------- */

/**
 * Re-point the EXISTING child links after an `init_tier_variation`.
 *
 * Every `model_id` the listing had is gone, so a link is matched to its fresh
 * model by `tier_index` — the position the init was asked to create — and merged
 * in place. `modeloAusenteEm: null` rides along: a link that a previous run had
 * marked unavailable is bound again, not left claiming a model that is back.
 *
 * ⚠️ A merge through `aplicarLinkDaVariacao`, never `mergeIfExists`: the patch
 * carries an outerRef object and `mergeIfExists` is `update()` plus a NOT_FOUND
 * narrow, which THROWS on a nested plain object (C15).
 */
async function repontarVinculosDeModelo(
  deps: DepsModelos,
  entrada: EntradaDeModelos,
  linkPaiId: string,
  montados: readonly ModeloMontado[],
  modelos: readonly ShopeeModel[],
): Promise<number> {
  let repontados = 0;
  for (const montado of montados) {
    if (montado.linkDocId === null) continue;
    const vivo = modelos.find(
      (m) => m.model_id > 0 && mesmaPosicao(m.tier_index, montado.tier_index),
    );
    if (vivo === undefined) continue;
    const dados = dadosLinkVariacao(vivo, null, null, deps.integracaoId);
    if (dados === null) continue;
    await aplicarLinkDaVariacao(
      deps.db,
      montado.produtoId,
      { acao: 'merge', docId: montado.linkDocId, dados: { ...dados, modeloAusenteEm: null } },
      entrada.produtoPaiId,
      linkPaiId,
    );
    repontados += 1;
  }
  return repontados;
}

/**
 * Mint a child link for every live model one of OUR children occupies and no
 * stored link binds.
 *
 * The candidates are the sync's `modelosSemFilho` — which already drops a row
 * whose `model_id` is not usable — and each is paired to a child by
 * `tier_index`. A model no child of ours occupies is REPORTED (`semFilho`),
 * never bound: it belongs to the seller, and `update_tier_variation` already
 * kept its position.
 */
async function criarVinculosDeModelo(
  deps: DepsModelos,
  entrada: EntradaDeModelos,
  linkPaiId: string,
  montados: readonly ModeloMontado[],
  modelos: readonly ShopeeModel[],
  semVinculo: readonly number[],
): Promise<{ readonly criados: number; readonly restantes: readonly ModeloSemVinculo[] }> {
  const alvos = new Set<number>(semVinculo);
  const restantes: ModeloSemVinculo[] = [];
  let criados = 0;

  for (const modelo of modelos) {
    if (!alvos.has(modelo.model_id)) continue;
    const montado = montadoNaPosicao(montados, modelo.tier_index);
    if (montado === null) {
      restantes.push({ model_id: modelo.model_id, model_sku: modelo.model_sku });
      continue;
    }
    const dados = dadosLinkVariacao(modelo, null, null, deps.integracaoId);
    if (dados === null) {
      // Unreachable through `modelosSemFilho` (it drops the sentinel first) and
      // kept anyway: `model_id: 0` binds any line of any listing, so the refusal
      // lives at every writer rather than in a comment claiming the caller did it.
      restantes.push({ model_id: modelo.model_id, model_sku: modelo.model_sku });
      continue;
    }
    await aplicarLinkDaVariacao(
      deps.db,
      montado.produtoId,
      { acao: 'add', docId: null, dados },
      entrada.produtoPaiId,
      linkPaiId,
    );
    criados += 1;
  }

  return { criados, restantes };
}

/* -------------------------------------------------------------------------- */
/*                                   Bits                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keep an envelope `warning` that is not Shopee's own noise.
 *
 * ⚠️ The string is carried on the RESULT (the operator reads it) and is NOT
 * logged: a log line in this app carries ids, counts, enum tokens and booleans,
 * never provider prose. P2 §8.3 sketched a `console.warn` with the string; the
 * app's log rule is the later, direct instruction.
 */
function coletarAviso(avisos: string[], warning: string | null | undefined): void {
  const aviso = avisoDeShopee(warning);
  if (aviso !== null) avisos.push(aviso);
}

function desaparecidosDe(plano: {
  readonly desaparecidos: readonly { readonly produtoId: string; readonly modelId: number }[];
}): readonly VinculoDesaparecido[] {
  return plano.desaparecidos.map((d) => ({ produtoId: d.produtoId, modelId: d.modelId }));
}

/** No children and no stored links: zero Shopee calls, zero writes, no sync. */
function legaVazia(): ResultadoModelos {
  return {
    acao: 'nenhuma',
    total: 0,
    criados: 0,
    repontados: 0,
    atualizados: 0,
    marcados: 0,
    semFilho: [],
    desaparecidos: [],
    ignorados: 0,
    avisos: [],
    passos: [],
  };
}
