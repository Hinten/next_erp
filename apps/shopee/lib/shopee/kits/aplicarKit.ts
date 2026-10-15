/**
 * The native-kit CREATE applier (step 19, #1527) — L9's "ensure the new kit
 * exists", and the completion every create path shares.
 *
 * ## No intent document, no state machine (L9)
 *
 * Nothing about a create's progress is stored. Each run re-derives what is
 * missing from Shopee reads plus the link docs (`prepararKit` reads them,
 * `planoKit.ts`'s `decidirKitNovo` decides), does only that, and is safe to run
 * again:
 *
 * | `plano.kitNovo` | this module does |
 * |---|---|
 * | `recusar` | throws `ShopeePublishBlockedError` with every miss — nothing sent |
 * | `completar` | {@link completarKit} `'opcao'` on the kit ALREADY linked — Shopee READS only |
 * | `criar` | `add_kit_item` EXACTLY once → the ONE link write → {@link completarKit} `'tier-enviado'` |
 *
 * ## `add_kit_item` is not idempotent — and a failure is classified, never retried
 *
 * A failed create goes through `recusaKit.ts`'s `desfechoDeCriacaoDeKit`:
 *
 * - `nao-criado` — our own guard, a rate limit, a dead grant, or a KNOWN
 *   permanent kit refusal. NOTHING is written. A Shopee refusal becomes a
 *   `ShopeePublishRejectedError` (422, etapa `add_kit_item`, its `problemas`
 *   from the kit classifier first, then step 11's) — the rejected class because
 *   the kit classifier's motivos are WIRE-only and may never ride a
 *   `ShopeePublishBlockedError`. Our own guard, the rate limit and the dead grant
 *   keep their own error class (and so their own HTTP mapping).
 * - `incerto` — anything that does not prove nothing was created (a transient,
 *   a network failure, an unknown refusal, a 2xx whose body did not parse).
 *   NOTHING is written; the result is `desfecho: 'incerto'` with `recusa`, and
 *   Shopee's sentence is `console.warn`ed VERBATIM with ids only (registers
 *   281/287 settle on it). The re-run's SKU scan finds the kit if it exists and
 *   refuses "importe-o"; step 9's import then links it on the SAME produto.
 *
 * ⚠️ A non-`ShopeeError` thrown by the call is OUR bug, not Shopee's answer: it
 * is rethrown (rule 6), never folded into `incerto`.
 *
 * ## The completion (rule 7: tier 0 everywhere, no multi-document atomic write)
 *
 * {@link completarKit} reads the kit back the way L9 lists it — `get_item_base_info`
 * + `get_kit_item_info` (`lerAnuncioShopee`, unchanged, which also reads the
 * components' `has_model`) and then an EXPLICIT `get_model_list` (its ids are
 * cross-checked against the kit page's, register 283, and its `model_status` goes
 * on new rows). Then #2 (`escreverLeituraDoKit`: `kitNativo = ehKitDe(read)`),
 * then one row per (link, model) under the CHILD (`escreverVariacoesDoKit`).
 *
 * The fingerprint `receitaKitConferida` = `chaveReceitaKitErp(child's STORED
 * recipe)` (`chaveReceitaArmazenadaDoFilho` — the unparsed map every reader
 * folds, R1-RT7-02) is stamped ONLY when THAT child's read-back model folds EQUAL to the projection
 * (`mesmaReceitaKitShopee`) — never on a write's 200: Shopee answers 200 to a
 * kit quantity change it silently ignores (P2-c). A child that folds DISTINCT
 * gets `null` (a new row) or keeps its old stamp, plus the warning
 * `receita-divergente`, so the L4 aviso decision OPENS for it.
 *
 * What the fold treats as equal is the schemas module's (`receitaKitShopee.ts`):
 * row order, duplicate addresses summed, a plain component's hidden model id vs
 * no model when its item has no variations, the main flag. Distinct: a quantity,
 * a component added or removed, model A vs B of a varied item. Pinned here by
 * `aplicarKit.test.ts`'s M91 pair (equal read-back stamped, a quantity near-miss
 * not stamped).
 *
 * ## Binding a live model to a child
 *
 * {@link ligarModelosDoKit}: ROWS FIRST — a live model that already has a row on
 * the link being completed binds to that row's owner, whatever the variante says
 * now (V2R1-03). Then `'tier-enviado'` binds by the `tier_index` the create SENT
 * (R-l: never by response position — the read-back may serve the models in any
 * order), and `'opcao'` (a resume) by the tier option text, then by `model_sku`;
 * a lone child's single model (a família de um, or the `'Padrão'` sentinel)
 * binds to it. The option compare is the fold the create and the append SENT
 * with (`planoKit.ts`'s `opcaoDoTierKit`): `'Azul'` ≡ `' Azul '`, `'Azul'` ≢
 * `'azul'` — pinned by `aplicarKit.test.ts`'s R2-F1 pair. A live model matching no
 * child ⇒ `modelo-sem-filho` (no row); a child matching no live model ⇒
 * `variacao-nao-anexada` — never appended on this path.
 *
 * Next-free and clock-free: `deps.nowMs` is the one clock and the aviso's µs
 * comes from `avisos/autorizacao.ts`'s `agoraUsDe`.
 */
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  ShopeeApiError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeKitItem,
  type ShopeeKitModel,
} from '@delfrance/integrations-shopee';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  OPCAO_TIER_KIT_UNICO,
  mesmaReceitaKitShopee,
  mesmoEnderecoDeComponente,
  type LinhaKitShopeeLida,
} from '@delfrance/schemas';

import {
  ETAPA_PUBLICACAO,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  type ProblemaDeBloqueio,
} from '../anuncios/errosPublicacao';
import { problemasDeErroShopee } from '../anuncios/problemasPublicacao';
import { agoraUsDe } from '../avisos/autorizacao';
import { ehKitDe, temModelosDe, type ItemLido } from '../produtos/itemLido';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { itensDosComponentesDoKit } from '../produtos/temModelosDosComponentes';
import { STATUS_BUSCA_KIT } from './constantesKit';
import {
  chaveReceitaArmazenadaDoFilho,
  opcaoDoTierKit,
  vinculosNativosDoKit,
  type PlanoKit,
} from './planoKit';
import { classificarRecusaKit, desfechoDeCriacaoDeKit, problemasDaRecusaKit } from './recusaKit';
import {
  comandoDeRetomada,
  type AvisoKit,
  type ContextoKit,
  type FilhoDoKit,
  type KitDeps,
  type ResultadoPublicacaoKit,
} from './resultadoKit';
import {
  escreverLeituraDoKit,
  escreverVariacoesDoKit,
  escreverVinculoDoKit,
  type LeituraDoKitEscrita,
  type LinhaDeVariacaoDoKit,
} from './vinculosKit';

/* -------------------------------------------------------------------------- */
/*                                The warnings                                */
/* -------------------------------------------------------------------------- */

/**
 * `receita-divergente` — the sentence the completion AND the republish emit
 * (§2.6). Exported so `republicarKit.ts` reuses it instead of a second copy.
 */
export function avisoReceitaDivergente(filhoId: string, linkDocId: string): AvisoKit {
  return {
    codigo: 'receita-divergente',
    produtoId: filhoId,
    mensagem:
      `a composição da variação ${filhoId} mudou no ERP; a Shopee não permite alterá-la — o kit ` +
      `continua com a receita antiga; use --link ${linkDocId} --recriar para criar um kit novo`,
  };
}

/** The four reasons `variacao-nao-anexada` may give (§2.5.3). */
export const MOTIVO_VARIACAO_NAO_ANEXADA = {
  variacoesDemais: 'a Shopee aceita no máximo 9 variações',
  doisEixos: 'o kit varia em mais de um eixo',
  receitaNaoResolvida: 'a composição dela não pôde ser resolvida',
  kitJaExistia: 'o kit já existia na Shopee sem ela — publique de novo para anexá-la',
} as const;

/** `variacao-nao-anexada` — an ERP child no live kit model carries. */
export function avisoVariacaoNaoAnexada(
  filhoId: string,
  motivo: (typeof MOTIVO_VARIACAO_NAO_ANEXADA)[keyof typeof MOTIVO_VARIACAO_NAO_ANEXADA],
): AvisoKit {
  return {
    codigo: 'variacao-nao-anexada',
    produtoId: filhoId,
    mensagem: `a variação ${filhoId} não foi anexada ao kit: ${motivo}`,
  };
}

/** `modelo-sem-filho` — a live kit model no ERP child matches; no row is written for it. */
export function avisoModeloSemFilho(itemId: number, modelId: number): AvisoKit {
  return {
    codigo: 'modelo-sem-filho',
    produtoId: null,
    mensagem:
      `o modelo ${String(modelId)} do kit ${String(itemId)} na Shopee não corresponde a nenhuma ` +
      'variação do ERP — nenhum vínculo foi gravado para ele',
  };
}

/* -------------------------------------------------------------------------- */
/*                         The live rows, as the fold reads them               */
/* -------------------------------------------------------------------------- */

/**
 * A live kit model's `component_list` → the schemas fold's row shape (the
 * adapter `LinhaKitShopeeLida`'s docblock asks the app for). Exported so the
 * republish reads live rows through the SAME adapter.
 *
 * ⚠️ `quantity: null` reads as `0` — a row Shopee sent without a quantity can
 * never fold equal to an ERP row, which is the safe direction (no stamp).
 */
export function linhasLidasDoModeloKit(modelo: ShopeeKitModel): LinhaKitShopeeLida[] {
  return modelo.component_list.map((c) => ({
    component_item_id: c.component_item_id,
    component_model_id: c.component_model_id ?? null,
    quantity: c.quantity ?? 0,
    main_component: c.main_component === true,
  }));
}

/* -------------------------------------------------------------------------- */
/*                              Binding (pure)                                */
/* -------------------------------------------------------------------------- */

/** One live kit model and the child it binds to (`null` ⇒ `modelo-sem-filho`). */
export interface LigacaoDeModeloKit {
  readonly modelo: ShopeeKitModel;
  readonly filhoId: string | null;
}

/**
 * Bind every live kit model to an ERP child (§2.5.3 / §2.6). Pure.
 *
 * Passes, in order — each binds only a model still unbound to a child still
 * unclaimed, so no child ever owns two models through a rule:
 * 1. ROWS: a row on THIS link (`linhasDoLink`, already filtered by the link
 *    being completed) with the model's id binds it to the row's owner;
 * 2. `'tier-enviado'`: the child whose SENT tier index equals the model's
 *    `tier_index[0]`;
 * 3. `'opcao'`: a LONE child's single free model ⇒ that child when it is a
 *    família de um or the model's option is the `'Padrão'` sentinel the create
 *    sends for a lone child with no usable axis (R3-01); then the child whose
 *    variante equals the model's tier option text THROUGH THE SENT FOLD
 *    (`opcaoDoTierKit`: trimmed, case kept — R2-F1); then the child whose `sku`
 *    equals the model's `model_sku` (exact, non-empty).
 */
export function ligarModelosDoKit(a: {
  readonly modelos: readonly ShopeeKitModel[];
  /** The ONE tier's option texts, by index (`tier_variation_list[0]`). */
  readonly opcoes: readonly (string | null)[];
  readonly filhos: readonly FilhoDoKit[];
  readonly familiaDeUm: boolean;
  readonly linhasDoLink: readonly {
    readonly produtoId: string;
    readonly raw: Record<string, unknown>;
  }[];
  readonly ligacao: 'tier-enviado' | 'opcao';
  /** `'tier-enviado'` only: child produtoId → the tier index the create SENT. */
  readonly tierPorFilho: ReadonlyMap<string, number>;
}): {
  readonly ligacoes: readonly LigacaoDeModeloKit[];
  readonly filhosSemModelo: readonly string[];
} {
  const ids = new Set(a.filhos.map((f) => f.produtoId));
  const dono = new Map<number, string>();
  const reivindicados = new Set<string>();

  // (1) rows first — the row is a FACT and decides its owner.
  // `ids.has` is DEFENSIVE (R6-M13 AK1): rows are read under `ctx.filhos` today,
  // but this export's input does not promise it, and a foreign owner binds no child.
  for (const modelo of a.modelos) {
    const linha = a.linhasDoLink.find(
      (l) => l.raw.model_id === modelo.model_id && ids.has(l.produtoId),
    );
    if (linha === undefined) continue;
    dono.set(modelo.model_id, linha.produtoId);
    reivindicados.add(linha.produtoId);
  }

  const livres = (): ShopeeKitModel[] => a.modelos.filter((m) => !dono.has(m.model_id));
  const ligar = (modelo: ShopeeKitModel, filho: FilhoDoKit | undefined): void => {
    if (filho === undefined || reivindicados.has(filho.produtoId)) return;
    dono.set(modelo.model_id, filho.produtoId);
    reivindicados.add(filho.produtoId);
  };

  if (a.ligacao === 'tier-enviado') {
    for (const modelo of livres()) {
      const tier = modelo.tier_index[0];
      ligar(
        modelo,
        a.filhos.find((f) => tier !== undefined && a.tierPorFilho.get(f.produtoId) === tier),
      );
    }
  } else {
    const restantes = livres();
    const membro = a.filhos[0];
    const unico = restantes.length === 1 ? restantes[0] : undefined;
    // The ONE model a lone child was SENT as: a família de um's, or the
    // `'Kit'`/`'Padrão'` sentinel `planejarTier` sends for any lone child with no
    // usable axis (R3-01) — whatever the child's variante says now.
    if (
      a.filhos.length === 1 &&
      membro !== undefined &&
      unico !== undefined &&
      (a.familiaDeUm || opcaoDoModelo(unico, a.opcoes) === OPCAO_TIER_KIT_UNICO)
    ) {
      ligar(unico, membro);
    }
    for (const modelo of livres()) {
      const opcao = opcaoDoModelo(modelo, a.opcoes);
      if (opcao === null) continue;
      // R2-F1: BOTH sides through the fold the create and the append SENT with
      // (`opcaoDoTierKit`, trimmed, case kept) — a padded variante was sent
      // trimmed, so a raw compare could never re-bind it.
      ligar(
        modelo,
        a.filhos.find(
          (f) => opcaoDoTierKit(f.variante) === opcao && !reivindicados.has(f.produtoId),
        ),
      );
    }
    for (const modelo of livres()) {
      const sku = modelo.model_sku;
      if (typeof sku !== 'string' || sku === '') continue;
      ligar(
        modelo,
        a.filhos.find((f) => f.sku !== null && f.sku === sku && !reivindicados.has(f.produtoId)),
      );
    }
  }

  return {
    ligacoes: a.modelos.map((modelo) => ({ modelo, filhoId: dono.get(modelo.model_id) ?? null })),
    filhosSemModelo: a.filhos.map((f) => f.produtoId).filter((id) => !reivindicados.has(id)),
  };
}

/** A live model's tier option text, through the SENT fold; `null` when it has none. */
function opcaoDoModelo(modelo: ShopeeKitModel, opcoes: readonly (string | null)[]): string | null {
  const tier = modelo.tier_index[0];
  return tier === undefined ? null : opcaoDoTierKit(opcoes[tier] ?? null);
}

/* -------------------------------------------------------------------------- */
/*                               completarKit                                 */
/* -------------------------------------------------------------------------- */

/** What one completion did. */
export interface ConclusaoDoKit {
  readonly leitura: ItemLido;
  readonly avisos: readonly AvisoKit[];
  readonly modelos: ResultadoPublicacaoKit['modelos'];
  /** What #2 wrote (the fold of the read-back) — the result's state fields. */
  readonly escrita: LeituraDoKitEscrita;
  /** Shopee calls this completion spent (the read-back, per CALL). */
  readonly chamadasShopee: number;
}

/**
 * The completion every create path shares: read back, #2, rows, stamps.
 * Idempotent — a re-run re-reads, re-writes the same #2, finds every row it
 * wrote and re-stamps it.
 *
 * The fold gate uses the plan's per-child projections (`plano.modelos[].linhas`,
 * the rows a create SENT); one that did not resolve fully
 * (`projecaoCompleta: false` — a `receita-nao-publicavel` resume) is never
 * stamped and never called divergent. `'tier-enviado'` binds by the plan's
 * `tierIndex` (a fresh create), `'opcao'` by §2.6's rule (a resume): ROWS FIRST —
 * `ctx.linhasDaConta` whose `linkDocId === a.linkDocId` (the link being
 * COMPLETED, not ctx's target) bind their model to the row's owner — then
 * option/SKU only for a live model with no row.
 */
export async function completarKit(
  deps: KitDeps,
  ctx: ContextoKit,
  plano: PlanoKit,
  a: {
    readonly linkDocId: string;
    readonly itemId: number;
    readonly ligacao: 'tier-enviado' | 'opcao';
  },
): Promise<ConclusaoDoKit> {
  const kitProdutoId = ctx.produto.id;

  /* ---- (1) the read-back: base + kit page (+ the components' has_model). */
  const leitura = await lerAnuncioShopee(deps.client, a.itemId);
  let chamadasShopee = chamadasDaLeitura(leitura);

  /* ---- (2) the explicit model list (L9's third read, S3F-10). */
  const lista = await deps.client.getModelList({ itemId: a.itemId });
  chamadasShopee += 1;
  const modelosLidos = leitura.kit?.model_list ?? [];
  conferirIdsDosModelos(ctx, a.itemId, modelosLidos, lista.model);
  if (leitura.kit === null) {
    console.error('[shopee/kits] a leitura de volta do kit não trouxe a página do kit', {
      integracaoId: ctx.integracaoId,
      produtoId: kitProdutoId,
      itemId: a.itemId,
      kit: ehKitDe(leitura.base),
    });
  }
  const statusPorModelo = new Map<number, string | null>(
    lista.model.map((m) => [m.model_id, m.model_status ?? null]),
  );

  /* ---- (3) #2 — kitNativo = ehKitDe(read). */
  const escrita = await escreverLeituraDoKit(deps, {
    produtoId: kitProdutoId,
    linkDocId: a.linkDocId,
    leitura: { kind: 'item', item: leitura },
  });

  /* ---- (4) bind every live model to a child. */
  const linhasDoLink = ctx.linhasDaConta.filter((l) => l.linkDocId === a.linkDocId);
  const tierPorFilho = new Map<string, number>(
    plano.modelos.map((m) => [m.filhoId, m.tierIndex] as const),
  );
  const { ligacoes, filhosSemModelo } = ligarModelosDoKit({
    modelos: modelosLidos,
    opcoes: opcoesDoTier(leitura.kit),
    filhos: ctx.filhos,
    familiaDeUm: ctx.familiaDeUm,
    linhasDoLink,
    ligacao: a.ligacao,
    tierPorFilho,
  });

  /* ---- (5) per bound pair: fold, stamp, row. */
  const temModelos = autoridadeDeModelos(ctx, leitura);
  const avisos: AvisoKit[] = [];
  const linhas: LinhaDeVariacaoDoKit[] = [];
  let vinculados = 0;
  let semFilho = 0;
  for (const { modelo, filhoId } of ligacoes) {
    if (filhoId === null) {
      semFilho += 1;
      avisos.push(avisoModeloSemFilho(a.itemId, modelo.model_id));
      continue;
    }
    vinculados += 1;
    const filho = ctx.filhos.find((f) => f.produtoId === filhoId);
    // The plan's projection of THIS child — the rows the create sent (main flag
    // aside, which the fold ignores). Only a COMPLETE one is compared: a partial
    // projection folds distinct for a reason that is not a recipe edit.
    const projecao = plano.modelos.find((m) => m.filhoId === filhoId);
    const resolvida = projecao?.projecaoCompleta === true;
    const igual =
      projecao !== undefined &&
      resolvida &&
      mesmaReceitaKitShopee(projecao.linhas, linhasLidasDoModeloKit(modelo), temModelos);
    if (resolvida && !igual) avisos.push(avisoReceitaDivergente(filhoId, a.linkDocId));
    linhas.push({
      filhoId,
      modelId: modelo.model_id,
      tierIndex: modelo.tier_index,
      modelStatus: statusPorModelo.get(modelo.model_id) ?? null,
      // R1-RT7-02 / R3-03: the STORED map, the input every reader folds — never
      // the parsed one (an absent `quantidade` parses to 1 but folds to null).
      receitaKitConferida:
        igual && filho !== undefined ? chaveReceitaArmazenadaDoFilho(filho) : null,
    });
  }
  for (const filhoId of filhosSemModelo) {
    avisos.push(avisoVariacaoNaoAnexada(filhoId, MOTIVO_VARIACAO_NAO_ANEXADA.kitJaExistia));
  }
  if (a.ligacao === 'tier-enviado' && (semFilho > 0 || filhosSemModelo.length > 0)) {
    // A fresh create sent one model per child; a read-back that does not mirror
    // it is Shopee's anomaly, not the operator's — ids only.
    console.error('[shopee/kits] a leitura de volta não espelha os modelos enviados', {
      integracaoId: ctx.integracaoId,
      produtoId: kitProdutoId,
      itemId: a.itemId,
      semFilho,
      filhosSemModelo,
    });
  }

  await escreverVariacoesDoKit(deps, {
    linkProdutoId: kitProdutoId,
    linkDocId: a.linkDocId,
    linhasDaConta: ctx.linhasDaConta,
    linhas,
  });

  return {
    leitura,
    avisos,
    modelos: { vinculados, anexados: 0, semFilho },
    escrita,
    chamadasShopee,
  };
}

/** The ONE tier's option texts, by index; `[]` when the kit page carries none. */
function opcoesDoTier(kit: ShopeeKitItem | null): (string | null)[] {
  const tier = kit?.tier_variation_list?.[0];
  return tier === undefined ? [] : tier.option_list.map((o) => o.option ?? null);
}

/**
 * The `has_model` authority for the fold: the context's (the same map the
 * projection was RESOLVED with), filled by the read-back's for any component
 * item the context never saw. Both sides of the fold must read ONE authority.
 */
function autoridadeDeModelos(ctx: ContextoKit, leitura: ItemLido): ReadonlyMap<number, boolean> {
  const mapa = new Map<number, boolean>(leitura.temModelosDosComponentes ?? []);
  for (const [itemId, temModelos] of ctx.temModelos) mapa.set(itemId, temModelos);
  return mapa;
}

/**
 * How many Shopee calls `lerAnuncioShopee` spent — per CALL, like every
 * `chamadasShopee` in this app: one `get_item_base_info`, then for a kit one
 * `get_kit_item_info` plus one batched `get_item_base_info` per 50 distinct
 * component items, else one `get_model_list` for an item with models.
 */
function chamadasDaLeitura(leitura: ItemLido): number {
  if (ehKitDe(leitura.base) && leitura.kit !== null) {
    const distintos = new Set(
      itensDosComponentesDoKit(leitura.kit).filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    return 2 + Math.ceil(distintos.size / SHOPEE_ITEM_BASE_INFO_MAX_IDS);
  }
  return temModelosDe(leitura) ? 2 : 1;
}

/** Register 283: the kit page and `get_model_list` must name the same models. Ids only. */
function conferirIdsDosModelos(
  ctx: ContextoKit,
  itemId: number,
  doKit: readonly ShopeeKitModel[],
  daLista: readonly { readonly model_id: number }[],
): void {
  const kit = new Set(doKit.map((m) => m.model_id));
  const lista = new Set(daLista.map((m) => m.model_id));
  const soNoKit = [...kit].filter((id) => !lista.has(id)).sort((x, y) => x - y);
  const soNaLista = [...lista].filter((id) => !kit.has(id)).sort((x, y) => x - y);
  if (soNoKit.length === 0 && soNaLista.length === 0) return;
  console.error('[shopee/kits] get_model_list e get_kit_item_info divergem nos modelos do kit', {
    integracaoId: ctx.integracaoId,
    produtoId: ctx.produto.id,
    itemId,
    soNoKit,
    soNaLista,
  });
}

/* -------------------------------------------------------------------------- */
/*                              garantirKitNovo                               */
/* -------------------------------------------------------------------------- */

/** L9's "ensure the new kit exists", done. */
export interface GarantiaCumprida {
  readonly desfecho: 'criado' | 'retomado' | 'incerto';
  /** `null` only on `incerto`. */
  readonly linkDocId: string | null;
  readonly itemId: number | null;
  /** The NEW kit's read-back (the recriar's liveness gate); `null` only on `incerto`. */
  readonly leitura: ItemLido | null;
  /** The plan's warnings, then the completion's. */
  readonly avisos: readonly AvisoKit[];
  readonly modelos: ResultadoPublicacaoKit['modelos'];
  readonly recusa: ResultadoPublicacaoKit['recusa'];
  /** What #2 wrote; `null` only on `incerto`. */
  readonly escrita: LeituraDoKitEscrita | null;
  /** Shopee calls the applier spent (`add_kit_item` + the read-back), per CALL. */
  readonly chamadasShopee: number;
}

/**
 * L9 "ensure the new kit exists": `plano.kitNovo` `criar` ⇒ `add_kit_item` + the
 * link write + {@link completarKit} `'tier-enviado'`; `completar` ⇒
 * {@link completarKit} `'opcao'` on the kit already linked; `recusar` ⇒
 * `ShopeePublishBlockedError` with every miss (the plan's and the scan's).
 *
 * Before acting it writes the ONE fact a create-arm run may write before
 * `add_kit_item` (S2C-02): a linked native kit the scan did not list and whose
 * batched base-info status says it is gone gets `removido` on its link — a fact
 * READ, not progress. On `incerto` it writes nothing else and returns at once:
 * every applier stops there (V2R2-04).
 */
export async function garantirKitNovo(
  deps: KitDeps,
  ctx: ContextoKit,
  plano: PlanoKit,
): Promise<GarantiaCumprida> {
  const kitNovo = plano.kitNovo;
  if (kitNovo === null) {
    throw new Error(
      '[shopee/kits] garantirKitNovo chamado sem decisão de kit novo (arma sem criação)',
    );
  }

  await escreverNossosApagados(deps, ctx);

  if (kitNovo.acao === 'recusar') {
    throw bloqueio(ctx, unirProblemas(plano.problemas, kitNovo.problemas));
  }
  if (plano.problemas.length > 0) throw bloqueio(ctx, plano.problemas);

  if (kitNovo.acao === 'completar') {
    const conclusao = await completarKit(deps, ctx, plano, {
      linkDocId: kitNovo.linkDocId,
      itemId: kitNovo.itemId,
      ligacao: 'opcao',
    });
    return {
      desfecho: 'retomado',
      linkDocId: kitNovo.linkDocId,
      itemId: kitNovo.itemId,
      leitura: conclusao.leitura,
      avisos: [...plano.avisos, ...conclusao.avisos],
      modelos: conclusao.modelos,
      recusa: null,
      escrita: conclusao.escrita,
      chamadasShopee: conclusao.chamadasShopee,
    };
  }

  const corpo = plano.corpo;
  if (corpo === null) {
    throw new Error('[shopee/kits] plano de criação de kit sem corpo de add_kit_item');
  }

  let itemId: number;
  try {
    // ⚠️ EXACTLY once per run, never retried in-call: not idempotent.
    const resposta = await deps.client.addKitItem(corpo);
    itemId = resposta.response.item_id;
  } catch (err) {
    // A non-Shopee throw is our own bug — never folded into "maybe created".
    if (!(err instanceof ShopeeError)) throw err;
    if (desfechoDeCriacaoDeKit(err) === 'nao-criado') throw recusaDaCriacao(ctx, err);
    return incerto(ctx, plano, err);
  }

  const linkDocId = await escreverVinculoDoKit(deps, {
    produtoId: ctx.produto.id,
    itemId,
    corpo,
  });
  const conclusao = await completarKit(deps, ctx, plano, {
    linkDocId,
    itemId,
    ligacao: 'tier-enviado',
  });
  return {
    desfecho: 'criado',
    linkDocId,
    itemId,
    leitura: conclusao.leitura,
    avisos: [...plano.avisos, ...conclusao.avisos],
    modelos: conclusao.modelos,
    recusa: null,
    escrita: conclusao.escrita,
    chamadasShopee: 1 + conclusao.chamadasShopee,
  };
}

/**
 * S2C-02: every `nossos` link the scan did not list whose batched status is
 * not one a live kit carries (`STATUS_BUSCA_KIT`) — deleted, or absent — is
 * written `removido` before the run acts, so the dispatcher stops counting it.
 */
async function escreverNossosApagados(deps: KitDeps, ctx: ContextoKit): Promise<void> {
  if (ctx.nossosVivos.size === 0) return;
  const vivos: ReadonlySet<string> = new Set(STATUS_BUSCA_KIT);
  // The SAME `nossos` the plan's `decidirKitNovo` read — one definition.
  const { nossos } = vinculosNativosDoKit(ctx.vinculos, ctx.alvo?.linkDocId ?? null);
  for (const [itemId, status] of ctx.nossosVivos) {
    if (status !== null && vivos.has(status)) continue;
    const linkDocId = nossos.get(itemId);
    if (linkDocId === undefined) continue;
    await escreverLeituraDoKit(deps, {
      produtoId: ctx.produto.id,
      linkDocId,
      leitura: { kind: 'status', itemStatus: status },
    });
  }
}

/** Every miss, the plan's first, without repeating one the plan already holds. */
function unirProblemas(
  doPlano: readonly ProblemaDeBloqueio[],
  daBusca: readonly ProblemaDeBloqueio[],
): ProblemaDeBloqueio[] {
  const chave = (p: ProblemaDeBloqueio): string => `${p.motivo}|${p.campo ?? ''}|${p.mensagem}`;
  const vistos = new Set(doPlano.map(chave));
  return [...doPlano, ...daBusca.filter((p) => !vistos.has(chave(p)))];
}

function bloqueio(
  ctx: ContextoKit,
  problemas: readonly ProblemaDeBloqueio[],
): ShopeePublishBlockedError {
  const [primeiro, ...resto] = problemas;
  if (primeiro === undefined) {
    throw new Error('[shopee/kits] recusa de kit sem nenhum problema');
  }
  return new ShopeePublishBlockedError({
    produtoId: ctx.produto.id,
    itemId: itemIdDoAlvo(ctx),
    problemas: [primeiro, ...resto],
  });
}

/** The target link's `item_id` when it has one (recriar/converter); `null` on a first create. */
function itemIdDoAlvo(ctx: ContextoKit): number | null {
  const itemId = ctx.alvo?.raw.item_id;
  return typeof itemId === 'number' && Number.isSafeInteger(itemId) && itemId > 0 ? itemId : null;
}

/**
 * A `nao-criado` failure, as the route will answer it. A Shopee refusal is a
 * 422 `ShopeePublishRejectedError` at etapa `add_kit_item`; our own guard
 * (`ShopeeConfigError`), a rate limit and a dead grant keep their own class, so
 * their own HTTP mapping (a 429 is not "the kit was refused").
 */
function recusaDaCriacao(ctx: ContextoKit, err: ShopeeError): ShopeeError {
  if (
    err instanceof ShopeeApiError &&
    !(err instanceof ShopeeRateLimitError) &&
    !(err instanceof ShopeeReauthRequiredError)
  ) {
    return new ShopeePublishRejectedError({
      etapa: ETAPA_PUBLICACAO.addKitItem,
      // VERBATIM, module prefix and all.
      shopeeCode: err.code,
      produtoId: ctx.produto.id,
      itemId: null,
      problemas: problemasDaRecusaKit(err) ?? problemasDeErroShopee(err),
    });
  }
  return err;
}

/** An `incerto` create: nothing written, Shopee's own words kept for the operator and the register. */
function incerto(ctx: ContextoKit, plano: PlanoKit, err: ShopeeError): GarantiaCumprida {
  const api = err instanceof ShopeeApiError ? err : null;
  const recusa = {
    codigo: api?.code ?? err.name,
    fraseShopee: api?.providerMessage ?? null,
    motivo: api === null ? null : classificarRecusaKit(api),
  };
  // Shopee's sentence VERBATIM, beside ids only — the settle method of
  // registers 281/287 (a transient vs a permanent `product.error_busi`).
  console.warn('[shopee/kits] add_kit_item sem desfecho certo — nada foi gravado', {
    integracaoId: ctx.integracaoId,
    produtoId: ctx.produto.id,
    codigo: recusa.codigo,
    motivo: recusa.motivo,
    requestId: api?.requestId ?? null,
    fraseShopee: recusa.fraseShopee,
  });
  return {
    desfecho: 'incerto',
    linkDocId: null,
    itemId: null,
    leitura: null,
    avisos: plano.avisos,
    modelos: { vinculados: 0, anexados: 0, semFilho: 0 },
    recusa,
    escrita: null,
    chamadasShopee: 1,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  criarKit                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `kit-criar` applier = {@link garantirKitNovo} → the L4 aviso decision
 * (`reavaliarAvisoDeReceitaKit`, motivo `kit-recriado`, AFTER the stamps).
 * On `incerto` it returns the 202 shape at once — `recusa` + `comando`, ids
 * `null` — and writes nothing, the aviso decision included (V2R2-04).
 */
export async function criarKit(
  deps: KitDeps,
  ctx: ContextoKit,
  plano: PlanoKit,
): Promise<ResultadoPublicacaoKit> {
  const garantia = await garantirKitNovo(deps, ctx, plano);
  const chamadasDaBusca = ctx.busca?.chamadas ?? 0;

  if (garantia.desfecho === 'incerto') {
    const resultado: ResultadoPublicacaoKit = {
      arma: 'kit-criar',
      desfecho: 'incerto',
      produtoId: ctx.produto.id,
      itemId: null,
      linkDocId: null,
      estadoAnuncio: null,
      itemStatus: null,
      kitNativo: null,
      modelos: garantia.modelos,
      antecessor: null,
      avisos: garantia.avisos,
      avisosResolvidos: 0,
      chamadasShopee: chamadasDaBusca + garantia.chamadasShopee,
      recusa: garantia.recusa,
      comando: comandoDeRetomada('kit-criar', {
        integracaoId: ctx.integracaoId,
        produtoId: ctx.produto.id,
        linkDocId: null,
        // The id the operator TYPED when the context carries it (OP-8), so the
        // re-run is literally the same command; else mapped back from the address.
        principal: ctx.principalSolicitado ?? idDoPrincipalPedido(ctx),
        // OP-9: a paused create's re-run must ask for a paused create again.
        ...(ctx.statusPedido === undefined ? {} : { status: ctx.statusPedido }),
      }),
    };
    registrarCriacao(resultado);
    return resultado;
  }

  const decisao = await reavaliarAvisoDeReceitaKit(
    deps.db,
    { integracaoId: ctx.integracaoId, kitProdutoId: ctx.produto.id },
    MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
    { agoraUs: agoraUsDe({ nowMs: deps.nowMs }), increment: deps.increment },
  );

  const resultado: ResultadoPublicacaoKit = {
    arma: 'kit-criar',
    desfecho: garantia.desfecho,
    produtoId: ctx.produto.id,
    itemId: garantia.itemId,
    linkDocId: garantia.linkDocId,
    estadoAnuncio: garantia.escrita?.estadoAnuncio ?? null,
    itemStatus: garantia.escrita?.itemStatus ?? null,
    kitNativo: garantia.escrita?.kitNativo ?? null,
    modelos: garantia.modelos,
    antecessor: null,
    avisos: garantia.avisos,
    // The DECISION, not proof an open row closed (an all-equal fresh create
    // resolves too) — the figure the route and the CLI print.
    avisosResolvidos: decisao === 'resolvido' ? 1 : 0,
    chamadasShopee: chamadasDaBusca + garantia.chamadasShopee,
    recusa: null,
    comando: null,
  };
  registrarCriacao(resultado);
  return resultado;
}

/**
 * The `--principal` produtoId to print in the re-run command. The context
 * holds it RESOLVED (`principalPedido`), so it is mapped back through
 * `ctx.resolucao`: every component id resolving to that one Shopee address
 * names the SAME principal on a re-run, and the lexically-first is printed.
 */
function idDoPrincipalPedido(ctx: ContextoKit): string | null {
  const alvo = ctx.principalPedido;
  if (alvo === null) return null;
  const ids: string[] = [];
  for (const [produtoId, r] of ctx.resolucao) {
    if (r.ok && mesmoEnderecoDeComponente(r.endereco, alvo)) ids.push(produtoId);
  }
  ids.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return ids[0] ?? null;
}

/** ONE line per create: ids, counts and enum tokens only. */
function registrarCriacao(r: ResultadoPublicacaoKit): void {
  // eslint-disable-next-line no-console -- expected on every create; a warn nobody can act on is what hides the real ones
  console.info('[shopee/kits] criação de kit nativo', {
    produtoId: r.produtoId,
    desfecho: r.desfecho,
    itemId: r.itemId,
    linkDocId: r.linkDocId,
    estadoAnuncio: r.estadoAnuncio,
    kitNativo: r.kitNativo,
    modelos: r.modelos,
    avisos: r.avisos.map((a) => a.codigo),
    avisosResolvidos: r.avisosResolvidos,
    chamadasShopee: r.chamadasShopee,
    recusa: r.recusa === null ? null : { codigo: r.recusa.codigo, motivo: r.recusa.motivo },
  });
}
