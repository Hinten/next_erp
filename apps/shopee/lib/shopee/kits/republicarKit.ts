/**
 * The native-kit REPUBLISH applier — the `kit-atualizar` arm (step 19, #1527;
 * reconcile §2.6, §2.5.4 U0–U2, Lucas L4(3) and L10(4)).
 *
 * A republish sends ONE `update_kit_item` carrying what Shopee lets a kit
 * change after its create: the name, the cover, the description, the
 * logistics, the weight and dimension, the SKUs, each model's price, and
 * APPENDED models. It never sends a recipe: Shopee answers 200 to a component
 * or quantity change of an existing model and SILENTLY ignores it (probe #2,
 * P2-c), so every live model goes back with its LIVE `component_list` resent
 * VERBATIM from `get_kit_item_info` (`linhasDeReenvioDoKit` — the hidden model
 * id of a plain component included) and `tier_index: [live.tier_index[0]]`.
 *
 * ## It never blocks for a recipe reason (L4(3))
 *
 * | what the ERP holds | what the republish does |
 * |---|---|
 * | a bound child whose recipe changed (folds DISTINCT from the live model) | sends the update, warns `receita-divergente` (advice: `--recriar`) |
 * | a bound child whose recipe cannot reach Shopee (a component not published, inactive, an empty recipe, a band miss) | sends the update, warns `receita-nao-publicavel` (no `--recriar` advice: a recriar refuses on the same row) |
 * | a `--principal` that is not the live main | sends the update, warns `principal-diferente` (the main is frozen after create) |
 * | a live model no ERP child matches | resends it unchanged, warns `modelo-sem-filho` |
 * | an ERP child no live model carries | APPENDS it (`model_id: 0` + the WHOLE tier list) — or skips it with `variacao-nao-anexada` when it does not fit |
 *
 * It refuses only on the NON-recipe rows (§2.6): the content rows `planoKit.ts`
 * carries (name, description, weight, dimensions, photos, logistics and their
 * bands), a BOUND child's price, and `listagem-removida` when the target kit
 * reads deleted. `principal-*` is never evaluated (L1: the main is read back).
 *
 * ## No duplicate scan (L10(4))
 *
 * `ctx.busca` is `null` on this arm: a republish makes ZERO `get_item_list`
 * calls and names no same-SKU twin. An unlinked twin of a double create
 * surfaces on the next CREATE-arm run (R-w, register 303).
 *
 * ## It is also the completion of an interrupted create (S2C-06, §2.5.4 C2/C3)
 *
 * Nothing here assumes the target link was ever read back or that any row
 * exists. When the link has no write-back #2 (`item_status` never written) or a
 * BOUND live model has no row for this listing, `completarKit(…, 'opcao')`
 * (Shopee READS + idempotent Firestore writes, no Shopee write) runs FIRST, and
 * only then does the refusal gate throw — so a C2 kit with a later content miss
 * still gets its #2 and its rows (the aviso and step 13 can see it) while
 * nothing is sent.
 *
 * ## Verified by READ-BACK, never by the 200 (P2-c)
 *
 * After the 200 the SAME completion reads the kit back (base + kit page +
 * `get_model_list`), writes #2, binds every model (an appended one by its new
 * option text), `create()`s the missing rows and stamps `receitaKitConferida`
 * ONLY on a child whose READ-BACK model folds EQUAL to the ERP projection — an
 * appended child whose read-back lacks a sent row is not stamped, and a child
 * whose quantity Shopee ignored keeps its old stamp, so the aviso stays open.
 * Then ONE `reavaliarAvisoDeReceitaKit(…, 'republicado-igual')`.
 *
 * ## Write tiers (rule 7)
 *
 * No transaction anywhere in this folder (the inventory greps the bare word).
 * Every write is `vinculosKit.ts`'s: #2 a write of values just READ (that never
 * moves a link out of `removido` — a `lastUpdateTime` precondition, R1-RT7-05), a
 * row a `create()` at a deterministic id falling back to a flat
 * `mergeIfExists` re-stamp, a deleted target a status-only `merge` of the fact
 * read. `update_kit_item` itself is idempotent: re-running the same republish
 * resends the same content (§2.5.4 U2, V2R2-03).
 *
 * Next-free and clock-free: `deps.nowMs` is the one clock; the aviso's µs comes
 * from `avisos/autorizacao.ts`'s `agoraUsDe`.
 */
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  ShopeeApiError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  linhasDeReenvioDoKit,
  type ShopeeKitComponentRequest,
  type ShopeeKitItem,
  type ShopeeKitModel,
  type ShopeeKitTierRequest,
  type ShopeeUpdateKitItemRequest,
  type ShopeeUpdateKitModelRequest,
} from '@delfrance/integrations-shopee';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  SHOPEE_KIT_MAX_MODELOS,
  mesmaReceitaKitShopee,
  mesmoEnderecoDeComponente,
  type EnderecoShopeeDoComponente,
  type LinhaComponenteKitShopee,
} from '@delfrance/schemas';

import {
  ETAPA_PUBLICACAO,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  type ProblemaDeBloqueio,
} from '../anuncios/errosPublicacao';
import type { FotosResolvidas } from '../anuncios/planoPublicacao';
import { problemasDeErroShopee } from '../anuncios/problemasPublicacao';
import { agoraUsDe } from '../avisos/autorizacao';
import {
  MOTIVO_VARIACAO_NAO_ANEXADA,
  avisoModeloSemFilho,
  avisoReceitaDivergente,
  avisoVariacaoNaoAnexada,
  completarKit,
  ligarModelosDoKit,
  linhasLidasDoModeloKit,
  type LigacaoDeModeloKit,
} from './aplicarKit';
import {
  avisoReceitaNaoPublicavel,
  kitVivoRemovido,
  opcaoDoTierKit,
  planejarKit,
  problemaKitRemovido,
  problemasDePrecoDoKit,
  type LinhaDeReceitaDoKit,
  type PlanoKit,
} from './planoKit';
import { problemasDaRecusaKit } from './recusaKit';
import type { AvisoKit, ContextoKit, KitDeps, ResultadoPublicacaoKit } from './resultadoKit';
import { escreverLeituraDoKit } from './vinculosKit';

/* -------------------------------------------------------------------------- */
/*                         The republish's own sentences                       */
/* -------------------------------------------------------------------------- */

/**
 * The reasons an ERP child may NOT be appended that the four of
 * `MOTIVO_VARIACAO_NAO_ANEXADA` (§2.5.3) do not cover: an append needs an
 * option text of its own in the ONE tier and a price, and a missing one is a
 * CONTENT hole the seam leaves unnamed. Skipping keeps L4(3)'s promise — the
 * update still goes out for everything else — instead of refusing the whole
 * republish over a child Shopee does not hold yet.
 */
export const MOTIVO_ANEXO_IMPOSSIVEL = {
  semOpcao:
    'ela não tem uma opção própria no eixo do kit (a variante falta, repete uma opção que já ' +
    'existe ou o eixo do kit na Shopee não pôde ser relido)',
  semPreco: 'ela não tem preço na tabela normal da conta',
  precoForaDaFaixa: 'o preço dela está fora da faixa da categoria do componente principal',
} as const;

type MotivoNaoAnexada =
  | (typeof MOTIVO_VARIACAO_NAO_ANEXADA)[keyof typeof MOTIVO_VARIACAO_NAO_ANEXADA]
  | (typeof MOTIVO_ANEXO_IMPOSSIVEL)[keyof typeof MOTIVO_ANEXO_IMPOSSIVEL];

/**
 * `variacao-nao-anexada` for any reason. The four of §2.5.3 go through their
 * ONE builder (`aplicarKit.ts`); the republish's own reasons reuse its exact
 * sentence (`republicarKit.test.ts` pins that both read alike).
 */
function avisoNaoAnexada(filhoId: string, motivo: MotivoNaoAnexada): AvisoKit {
  switch (motivo) {
    case MOTIVO_VARIACAO_NAO_ANEXADA.variacoesDemais:
    case MOTIVO_VARIACAO_NAO_ANEXADA.doisEixos:
    case MOTIVO_VARIACAO_NAO_ANEXADA.receitaNaoResolvida:
    case MOTIVO_VARIACAO_NAO_ANEXADA.kitJaExistia:
      return avisoVariacaoNaoAnexada(filhoId, motivo);
    default:
      return {
        codigo: 'variacao-nao-anexada',
        produtoId: filhoId,
        mensagem: `a variação ${filhoId} não foi anexada ao kit: ${motivo}`,
      };
  }
}

/**
 * `principal-diferente` — the operator named a `--principal` that is not the
 * live kit's main. A warning, never a block: the main is frozen after create
 * (P2-a), and changing it is a recriar (R-m). Exported so the recriar's gate
 * (PR 6) words it the same way.
 */
export function avisoPrincipalDiferente(a: {
  /** K — the kit produto the sentence is about. */
  readonly produtoId: string;
  readonly itemId: number;
  readonly linkDocId: string;
  /** The named principal, as a component produtoId (or its Shopee address). */
  readonly pedido: string;
  /** The live main, the same way. */
  readonly vivo: string;
}): AvisoKit {
  return {
    codigo: 'principal-diferente',
    produtoId: a.produtoId,
    mensagem:
      `o componente principal informado (${a.pedido}) não é o principal do kit ` +
      `${String(a.itemId)} na Shopee (${a.vivo}); a Shopee não deixa trocar o principal de um ` +
      'kit, então ele foi mantido — para trocá-lo, recrie o kit com ' +
      `--link ${a.linkDocId} --recriar --principal <componente>`,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Small readers                                  */
/* -------------------------------------------------------------------------- */

/** Trimmed and non-empty, or `null` — blank means ABSENT. */
function textoUtilizavel(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const limpo = bruto.trim();
  return limpo.length > 0 ? limpo : null;
}

/** A stored string sent back VERBATIM when it is not blank. */
function textoVerbatim(bruto: unknown): string | null {
  return textoUtilizavel(bruto) === null ? null : (bruto as string);
}

function itemIdEnderecavel(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/** UTF-16 code-unit order — never `localeCompare`. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The ONE tier's option texts, by index; `[]` when the kit page carries none. */
function opcoesDoTier(kit: ShopeeKitItem): (string | null)[] {
  const tier = kit.tier_variation_list?.[0];
  return tier === undefined ? [] : tier.option_list.map((o) => o.option ?? null);
}

/**
 * A component address for a sentence: the lexically-first ERP component that
 * resolves to it, else its Shopee address. Display only.
 */
function rotuloDoEndereco(ctx: ContextoKit, endereco: EnderecoShopeeDoComponente): string {
  const ids = [...ctx.resolucao]
    .filter(([, r]) => r.ok && mesmoEnderecoDeComponente(r.endereco, endereco))
    .map(([id]) => id)
    .sort(compararTexto);
  const primeiro = ids[0];
  if (primeiro !== undefined) return primeiro;
  return endereco.modelId === null
    ? `item ${String(endereco.itemId)}`
    : `item ${String(endereco.itemId)} modelo ${String(endereco.modelId)}`;
}

/** An APPENDED model's rows: the ERP projection, never a main (frozen after create). */
function linhasDoAnexo(linhas: readonly LinhaComponenteKitShopee[]): ShopeeKitComponentRequest[] {
  return linhas.map((l) => ({
    component_item_id: l.component_item_id,
    ...(l.component_model_id === undefined ? {} : { component_model_id: l.component_model_id }),
    quantity: l.quantity,
  }));
}

/* -------------------------------------------------------------------------- */
/*                         The republish plan (pure)                           */
/* -------------------------------------------------------------------------- */

/** What one republish decided — nothing in it has been sent or written. */
export interface PlanoDeRepublicacao {
  /** The plan's non-recipe refusals plus each BOUND child's price rows. Empty ⇔ the update may go. */
  readonly problemas: readonly ProblemaDeBloqueio[];
  /** The plan's warnings, then the republish's own, in order. */
  readonly avisos: readonly AvisoKit[];
  /** Every live model and the child it binds to (`null` ⇒ `modelo-sem-filho`). */
  readonly ligacoes: readonly LigacaoDeModeloKit[];
  /** The link has no #2, or a BOUND live model has no row for this listing (S2C-06). */
  readonly precisaCompletar: boolean;
  /** The `update_kit_item` body; `null` whenever `problemas` is not empty. */
  readonly corpo: ShopeeUpdateKitItemRequest | null;
  /** The children appended (`model_id: 0`), in tier order. */
  readonly anexos: readonly string[];
  /** Children already warned `variacao-nao-anexada` (a skipped append). */
  readonly naoAnexados: ReadonlySet<string>;
  /** BOUND children warned `receita-nao-publicavel` (their recipe cannot be compared). */
  readonly naoPublicaveis: ReadonlySet<string>;
}

/**
 * The republish of ONE live kit, decided (§2.6). Pure: `ctx` is what
 * `prepararKit` read, `plano` what `planejarKit` decided for `kit-atualizar`,
 * `vivo` the target's live kit page.
 *
 * Binding (§2.6): ROWS FIRST — a live model with a row on THIS listing
 * (`ctx.linhasDoAnuncio`, the `idDoRef` fold over both stored encodings)
 * binds to the row's owner — then the child whose `variante` equals the
 * model's tier option, then the one whose `sku` equals its `model_sku`; a
 * família de um's single model binds to the member. It is NEVER the tier
 * position recomputed from the ERP (the children's order may have moved since
 * the create). A live model is never re-appended; only an ERP child that NO
 * live model carries is an append candidate.
 */
export function planejarRepublicacaoDoKit(
  ctx: ContextoKit,
  plano: PlanoKit,
  vivo: { readonly itemId: number; readonly linkDocId: string; readonly kit: ShopeeKitItem },
): PlanoDeRepublicacao {
  const kitId = ctx.produto.id;
  const opcoesVivas = opcoesDoTier(vivo.kit);
  const { ligacoes, filhosSemModelo } = ligarModelosDoKit({
    modelos: vivo.kit.model_list,
    opcoes: opcoesVivas,
    filhos: ctx.filhos,
    familiaDeUm: ctx.familiaDeUm,
    linhasDoLink: ctx.linhasDoAnuncio,
    ligacao: 'opcao',
    tierPorFilho: new Map<string, number>(),
  });

  const ligados = new Set(ligacoes.flatMap((l) => (l.filhoId === null ? [] : [l.filhoId])));
  const comLinha = new Set(ctx.linhasDoAnuncio.map((l) => l.raw.model_id));
  const semLeituraDeVolta = ctx.alvo === null || ctx.alvo.raw.item_status == null;
  // Not implied by the row half: a link whose #2 is missing while every bound
  // model already has its row (republicarKit.test.ts, R6-M13 RP6) still completes.
  const precisaCompletar =
    semLeituraDeVolta ||
    ligacoes.some((l) => l.filhoId !== null && !comLinha.has(l.modelo.model_id));

  const receitaDe = new Map<string, LinhaDeReceitaDoKit[]>();
  for (const linha of plano.receita ?? []) {
    const doFilho = receitaDe.get(linha.filhoId) ?? [];
    doFilho.push(linha);
    receitaDe.set(linha.filhoId, doFilho);
  }

  const avisos: AvisoKit[] = [...plano.avisos];
  const naoPublicaveis = new Set<string>();
  const naoAnexados = new Set<string>();
  const modelList: ShopeeUpdateKitModelRequest[] = [];

  /* ---- every LIVE model: resent with its live components, verbatim ------- */
  for (const { modelo, filhoId } of ligacoes) {
    const filho = filhoId === null ? undefined : ctx.filhos.find((f) => f.produtoId === filhoId);
    if (filhoId === null) {
      avisos.push(avisoModeloSemFilho(vivo.itemId, modelo.model_id));
    } else {
      const linhas = receitaDe.get(filhoId) ?? [];
      if (linhas.length > 0) {
        // Not an ERP edit Shopee lacks — a recipe that cannot reach Shopee at
        // all (a component's listing, a model hole, a band): never "--recriar".
        naoPublicaveis.add(filhoId);
        for (const linha of linhas) avisos.push(avisoReceitaNaoPublicavel(linha));
      } else {
        const projecao = plano.modelos.find((m) => m.filhoId === filhoId);
        if (
          projecao?.projecaoCompleta === true &&
          !mesmaReceitaKitShopee(projecao.linhas, linhasLidasDoModeloKit(modelo), ctx.temModelos)
        ) {
          avisos.push(avisoReceitaDivergente(filhoId, vivo.linkDocId));
        }
      }
    }
    const reenvio = modeloReenviado(modelo, filho ?? null);
    if (reenvio === null) {
      // A model with no tier index or an unreadable quantity has nothing
      // verbatim to resend; omitted, it is KEPT as it is (a PARTIAL update).
      console.error(
        '[shopee/kits] modelo vivo sem tier_index ou quantidade legível; não reenviado',
        {
          integracaoId: ctx.integracaoId,
          produtoId: kitId,
          itemId: vivo.itemId,
          modelId: modelo.model_id,
        },
      );
      continue;
    }
    modelList.push(reenvio);
  }

  /* ---- a named --principal that is not the live main (L1: a warning) ----- */
  if (
    ctx.principalPedido !== null &&
    ctx.principal !== null &&
    !mesmoEnderecoDeComponente(ctx.principalPedido, ctx.principal)
  ) {
    avisos.push(
      avisoPrincipalDiferente({
        produtoId: kitId,
        itemId: vivo.itemId,
        linkDocId: vivo.linkDocId,
        pedido: rotuloDoEndereco(ctx, ctx.principalPedido),
        vivo: rotuloDoEndereco(ctx, ctx.principal),
      }),
    );
  }

  /* ---- every ERP child NO live model carries: append it, when it fits ---- */
  const tierVivo = vivo.kit.tier_variation_list?.[0];
  const tierLegivel =
    vivo.kit.tier_variation_list?.length === 1 &&
    opcoesVivas.length > 0 &&
    opcoesVivas.every((o) => opcaoDoTierKit(o) !== null);
  // Through the ONE option fold the create SENDS with (`opcaoDoTierKit`:
  // trimmed, case kept — `'Azul'` ≡ `' Azul '`, `'Azul'` ≢ `'azul'`), the tier
  // planner's own duplicate rule (`planoKit.ts`'s `combinacao-duplicada`). It is
  // seeded with the LIVE options and grows with every append of THIS body, so
  // two new children folding to one text append only the first (R6-M04).
  const opcoesUsadas = new Set(opcoesVivas.flatMap((o) => opcaoDoTierKit(o) ?? []));
  const opcoesNovas: string[] = [];
  const anexos: string[] = [];
  for (const filhoId of filhosSemModelo) {
    const anexo = anexoDoFilho({
      ctx,
      plano,
      filhoId,
      temReceitaNaoPublicavel: (receitaDe.get(filhoId)?.length ?? 0) > 0,
      modelosNoKit: vivo.kit.model_list.length + anexos.length,
      tierLegivel,
      opcoesUsadas,
    });
    if (!anexo.ok) {
      naoAnexados.add(filhoId);
      avisos.push(avisoNaoAnexada(filhoId, anexo.motivo));
      continue;
    }
    modelList.push({
      model_id: 0,
      tier_index: [opcoesVivas.length + opcoesNovas.length],
      original_price: anexo.preco,
      ...(anexo.sku === null ? {} : { model_sku: anexo.sku }),
      component_list: linhasDoAnexo(anexo.linhas),
    });
    opcoesNovas.push(anexo.opcao);
    opcoesUsadas.add(anexo.opcao);
    anexos.push(filhoId);
  }

  /* ---- the refusal set (§2.6): content rows + a BOUND child's price ------ */
  const problemas: ProblemaDeBloqueio[] = [
    ...plano.problemas,
    ...problemasDePrecoDoKit(ctx, ligados),
  ];

  let corpo: ShopeeUpdateKitItemRequest | null = null;
  if (problemas.length === 0) {
    const c = plano.conteudo;
    if (
      c === undefined ||
      c.itemName === null ||
      c.description === null ||
      c.imageIds === null ||
      c.imageIds.length === 0 ||
      c.weight === null
    ) {
      // Every one of these is a refusal row of the plan; reaching here with one
      // missing and no refusal is a defect of this module's caller.
      throw new Error(
        `[shopee/kits] republicação do kit ${kitId} sem conteúdo completo e sem recusa — ` +
          'as fotos foram resolvidas?',
      );
    }
    // V2R1-07: K's SKU when the scan and the import could use it; else the
    // LIVE one goes back (`sku-do-kit-nao-enviado` is already in the plan's warnings).
    const itemSku = plano.sku ?? textoVerbatim(vivo.kit.item_sku);
    const nomeDoTier = textoVerbatim(tierVivo?.name);
    // The live options VERBATIM, then the new ones — never option images (R-8).
    const tier: ShopeeKitTierRequest | null =
      anexos.length === 0
        ? null
        : {
            ...(nomeDoTier === null ? {} : { name: nomeDoTier }),
            option_list: [
              ...opcoesVivas.flatMap((o) => (o === null ? [] : [o])),
              ...opcoesNovas,
            ].map((option) => ({ option })),
          };
    corpo = {
      item_id: vivo.itemId,
      item_setting: {
        item_name: c.itemName,
        images: { image_id_list: c.imageIds },
        description_type: 'normal',
        description: c.description,
        logistic_info: c.logisticInfo,
        weight: c.weight,
        ...(c.dimension === null ? {} : { dimension: c.dimension }),
        ...(itemSku === null ? {} : { item_sku: itemSku }),
        // ⚠️ No `unlisted` — pausing is step 11's `unlist_item` (R-s(4)).
        ...(modelList.length === 0 ? {} : { model_list: modelList }),
        // P2-c: an append needs the WHOLE tier resent with its new options.
        ...(tier === null ? {} : { tier_variation_list: [tier] as const }),
      },
    };
  }

  return {
    problemas,
    avisos,
    ligacoes,
    precisaCompletar,
    corpo,
    anexos,
    naoAnexados,
    naoPublicaveis,
  };
}

/**
 * Whether ONE ERP child no live model carries can be APPENDED (§2.6), and with
 * what. In order: a recipe that did not resolve fully or carries a recipe row
 * (`receitaNaoResolvida`), a second axis (`doisEixos`), a 10th model
 * (`variacoesDemais`), no option text of its own in a readable tier
 * (`semOpcao`), then its price — null, or outside the served band. Every "no"
 * is a skipped append with a warning; the update still goes out.
 */
function anexoDoFilho(a: {
  readonly ctx: ContextoKit;
  readonly plano: PlanoKit;
  readonly filhoId: string;
  readonly temReceitaNaoPublicavel: boolean;
  /** The live models plus the ones this body already appends. */
  readonly modelosNoKit: number;
  readonly tierLegivel: boolean;
  readonly opcoesUsadas: ReadonlySet<string>;
}):
  | { readonly ok: false; readonly motivo: MotivoNaoAnexada }
  | {
      readonly ok: true;
      readonly opcao: string;
      readonly preco: number;
      readonly sku: string | null;
      readonly linhas: readonly LinhaComponenteKitShopee[];
    } {
  const filho = a.ctx.filhos.find((f) => f.produtoId === a.filhoId);
  const projecao = a.plano.modelos.find((m) => m.filhoId === a.filhoId);
  if (filho === undefined || projecao?.projecaoCompleta !== true || a.temReceitaNaoPublicavel) {
    return { ok: false, motivo: MOTIVO_VARIACAO_NAO_ANEXADA.receitaNaoResolvida };
  }
  if (a.ctx.gruposDistintos > 1)
    return { ok: false, motivo: MOTIVO_VARIACAO_NAO_ANEXADA.doisEixos };
  if (a.modelosNoKit + 1 > SHOPEE_KIT_MAX_MODELOS) {
    return { ok: false, motivo: MOTIVO_VARIACAO_NAO_ANEXADA.variacoesDemais };
  }
  const opcao = opcaoDoTierKit(filho.variante);
  if (!a.tierLegivel || opcao === null || a.opcoesUsadas.has(opcao)) {
    return { ok: false, motivo: MOTIVO_ANEXO_IMPOSSIVEL.semOpcao };
  }
  if (filho.preco === null) return { ok: false, motivo: MOTIVO_ANEXO_IMPOSSIVEL.semPreco };
  if (problemasDePrecoDoKit(a.ctx, new Set([a.filhoId])).length > 0) {
    return { ok: false, motivo: MOTIVO_ANEXO_IMPOSSIVEL.precoForaDaFaixa };
  }
  return {
    ok: true,
    opcao,
    preco: filho.preco,
    sku: textoVerbatim(filho.sku),
    linhas: projecao.linhas,
  };
}

/**
 * One LIVE model, resent: its id, `tier_index: [live.tier_index[0]]`, the bound
 * child's price and SKU (the live ones when unbound or blank), and its LIVE
 * `component_list` VERBATIM — never re-encoded from the ERP (P2-c). `null` when
 * there is nothing verbatim to resend (no tier index, an unreadable quantity).
 */
function modeloReenviado(
  modelo: ShopeeKitModel,
  filho: { readonly preco: number | null; readonly sku: string | null } | null,
): ShopeeUpdateKitModelRequest | null {
  const tier = modelo.tier_index[0];
  if (tier === undefined) return null;
  if (
    modelo.component_list.length === 0 ||
    modelo.component_list.some((c) => c.quantity === null)
  ) {
    return null;
  }
  const preco = filho === null ? modelo.original_price : filho.preco;
  const sku = (filho === null ? null : textoVerbatim(filho.sku)) ?? textoVerbatim(modelo.model_sku);
  return {
    model_id: modelo.model_id,
    tier_index: [tier],
    ...(preco === null ? {} : { original_price: preco }),
    ...(sku === null ? {} : { model_sku: sku }),
    component_list: linhasDeReenvioDoKit(modelo),
  };
}

/* -------------------------------------------------------------------------- */
/*                               republicarKit                                */
/* -------------------------------------------------------------------------- */

/**
 * The `kit-atualizar` applier (§2.6): plan → (deleted target ⇒ the fact +
 * `listagem-removida`) → the completion of an interrupted create → the refusal
 * gate → ONE `update_kit_item` → read-back + #2 + rows + fold-gated stamps →
 * the aviso decision.
 *
 * @throws ShopeePublishBlockedError on a non-recipe refusal — AFTER the
 *   completion, which may have written #2 and the missing rows.
 * @throws ShopeePublishRejectedError when Shopee refuses `update_kit_item`
 *   (etapa `update_kit_item`); our own guard, a rate limit and a dead grant keep
 *   their own class.
 */
export async function republicarKit(
  deps: KitDeps,
  ctx: ContextoKit,
  fotos: FotosResolvidas | null,
): Promise<ResultadoPublicacaoKit> {
  const alvo = ctx.alvo;
  if (ctx.arma.arma !== 'kit-atualizar' || alvo === null) {
    throw new Error('[shopee/kits] republicarKit fora do braço kit-atualizar (sem vínculo-alvo)');
  }
  const linkDocId = alvo.linkDocId;
  const itemId = itemIdEnderecavel(alvo.raw.item_id);
  if (itemId === null || ctx.vivo === null) {
    // The dispatcher routes only a native link with a positive `item_id` here,
    // and `prepararKit` reads it live whenever it has one.
    throw new Error(
      `[shopee/kits] o vínculo ${linkDocId} do kit ${ctx.produto.id} não tem item_id legível`,
    );
  }
  const plano = planejarKit(ctx, fotos);

  /* ---- (1) the target reads deleted: the fact is written, nothing sent ---- */
  if (kitVivoRemovido(ctx.vivo, deps.nowMs)) {
    await escreverLeituraDoKit(deps, {
      produtoId: ctx.produto.id,
      linkDocId,
      leitura: { kind: 'status', itemStatus: ctx.vivo.status },
    });
    throw new ShopeePublishBlockedError({
      produtoId: ctx.produto.id,
      itemId,
      problemas: [problemaKitRemovido({ itemId, linkDocId }), ...plano.problemas],
    });
  }
  const kit = ctx.vivo.kit;
  if (kit === null) {
    // `prepararKit`'s live read answers `kit: null` with a live status only
    // when the base row says the listing is NOT a kit (`tag.kit` false) — a
    // native-kit link over a plain listing, which no writer produces.
    throw new Error(
      `[shopee/kits] o item ${String(itemId)} do vínculo ${linkDocId} não é servido como kit pela Shopee`,
    );
  }

  const rep = planejarRepublicacaoDoKit(ctx, plano, { itemId, linkDocId, kit });
  let chamadasShopee = 0;

  /* ---- (2) the completion of an interrupted create comes FIRST (S2C-06) --- */
  if (rep.precisaCompletar) {
    const antes = await completarKit(deps, ctx, plano, { linkDocId, itemId, ligacao: 'opcao' });
    chamadasShopee += antes.chamadasShopee;
  }

  /* ---- (3) the refusal gate: non-recipe rows only (§2.6) ------------------- */
  // `corpo` is null exactly when a refusal holds (`planejarRepublicacaoDoKit`).
  const corpo = rep.corpo;
  if (corpo === null) {
    const [primeiro, ...resto] = rep.problemas;
    if (primeiro === undefined)
      throw new Error('[shopee/kits] republicação sem corpo e sem recusa');
    throw new ShopeePublishBlockedError({
      produtoId: ctx.produto.id,
      itemId,
      problemas: [primeiro, ...resto],
    });
  }

  /* ---- (4) ONE update_kit_item — its 200 proves nothing (P2-c) ------------- */
  try {
    await deps.client.updateKitItem(corpo);
  } catch (err) {
    // A rate limit and a dead grant are ShopeeApiErrors with their own HTTP
    // mapping; a network failure, our own guard and anything not Shopee's
    // propagate untouched (rule 6). The republish is idempotent: the operator
    // re-runs the same command.
    if (
      err instanceof ShopeeApiError &&
      !(err instanceof ShopeeRateLimitError) &&
      !(err instanceof ShopeeReauthRequiredError)
    ) {
      throw new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.updateKitItem,
        // VERBATIM, module prefix and all.
        shopeeCode: err.code,
        produtoId: ctx.produto.id,
        itemId,
        problemas: problemasDaRecusaKit(err) ?? problemasDeErroShopee(err),
      });
    }
    throw err;
  }
  chamadasShopee += 1;

  /* ---- (5) read-back, #2, rows, stamps ONLY on a fold-equal read-back ----- */
  const conclusao = await completarKit(deps, ctx, plano, { linkDocId, itemId, ligacao: 'opcao' });
  chamadasShopee += conclusao.chamadasShopee;

  const avisos = juntarAvisos(rep, conclusao.avisos);
  const naoAnexadosNaLeitura = new Set(
    conclusao.avisos.flatMap((a) =>
      a.codigo === 'variacao-nao-anexada' && a.produtoId !== null ? [a.produtoId] : [],
    ),
  );
  const anexados = rep.anexos.filter((f) => !naoAnexadosNaLeitura.has(f)).length;

  /* ---- (6) ONE aviso decision, AFTER the stamps --------------------------- */
  const decisao = await reavaliarAvisoDeReceitaKit(
    deps.db,
    { integracaoId: ctx.integracaoId, kitProdutoId: ctx.produto.id },
    MOTIVO_RESOLUCAO_RECEITA_KIT.republicadoIgual,
    { agoraUs: agoraUsDe({ nowMs: deps.nowMs }), increment: deps.increment },
  );

  const resultado: ResultadoPublicacaoKit = {
    arma: 'kit-atualizar',
    desfecho: 'atualizado',
    produtoId: ctx.produto.id,
    itemId,
    linkDocId,
    estadoAnuncio: conclusao.escrita.estadoAnuncio,
    itemStatus: conclusao.escrita.itemStatus,
    kitNativo: conclusao.escrita.kitNativo,
    modelos: {
      vinculados: conclusao.modelos.vinculados,
      anexados,
      semFilho: conclusao.modelos.semFilho,
    },
    antecessor: null,
    avisos,
    // The DECISION, not proof an open row closed — criarKit's figure.
    avisosResolvidos: decisao === 'resolvido' ? 1 : 0,
    chamadasShopee,
    recusa: null,
    comando: null,
  };
  registrarRepublicacao(resultado);
  return resultado;
}

/**
 * The republish's warnings, then the read-back's — without saying one thing
 * twice. The read-back re-binds and re-folds what the republish already
 * judged, so its `receita-divergente` / `modelo-sem-filho` usually repeat one
 * already said (dropped as exact duplicates); its `variacao-nao-anexada` for a
 * child the republish deliberately did not append carries the WRONG reason
 * ("o kit já existia…") and is dropped; and a child already warned
 * `receita-nao-publicavel` is not ALSO told to `--recriar`.
 */
function juntarAvisos(rep: PlanoDeRepublicacao, daLeitura: readonly AvisoKit[]): AvisoKit[] {
  const saida: AvisoKit[] = [...rep.avisos];
  const chave = (a: AvisoKit): string => `${a.codigo}\u0000${a.produtoId ?? ''}\u0000${a.mensagem}`;
  const vistos = new Set(saida.map(chave));
  for (const aviso of daLeitura) {
    const filho = aviso.produtoId;
    if (aviso.codigo === 'variacao-nao-anexada' && filho !== null && rep.naoAnexados.has(filho)) {
      continue;
    }
    if (aviso.codigo === 'receita-divergente' && filho !== null && rep.naoPublicaveis.has(filho)) {
      continue;
    }
    if (vistos.has(chave(aviso))) continue;
    vistos.add(chave(aviso));
    saida.push(aviso);
  }
  return saida;
}

/** ONE line per republish: ids, counts and enum tokens only. */
function registrarRepublicacao(r: ResultadoPublicacaoKit): void {
  // eslint-disable-next-line no-console -- expected on every republish; a warn nobody can act on is what hides the real ones
  console.info('[shopee/kits] republicação de kit nativo', {
    produtoId: r.produtoId,
    itemId: r.itemId,
    linkDocId: r.linkDocId,
    estadoAnuncio: r.estadoAnuncio,
    kitNativo: r.kitNativo,
    modelos: r.modelos,
    avisos: r.avisos.map((a) => a.codigo),
    avisosResolvidos: r.avisosResolvidos,
    chamadasShopee: r.chamadasShopee,
  });
}
