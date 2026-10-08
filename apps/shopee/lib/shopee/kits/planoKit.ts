/**
 * Step 19 (#1527) — the PURE half of a native-kit publish (reconcile §2.5.2,
 * §2.5.3, §2.6's refusal set): phase A, the plan, and the "ensure the new kit
 * exists" classifier. No IO, no clock, no Firestore, no Shopee call.
 *
 * ## The three entry points
 *
 * - {@link problemasDaFaseA} — the Firestore-only refusals. `prepararKit.ts`
 *   calls it right after its Firestore reads and BEFORE the first Shopee read:
 *   on a create arm any miss there throws, so the duplicate scan never runs on a
 *   null, padded or shared SKU. On `kit-atualizar` it answers only the rows a
 *   republish still refuses on (§2.6, L4(3)).
 * - {@link decidirKitNovo} — L9's "ensure the new kit exists" over the L6 scan
 *   and the conta's link docs (R-14): create it, complete the one already
 *   linked, or refuse (ONE aggregated refusal, every hit named).
 * - {@link planejarKit} — everything else a run decides before writing: the
 *   per-child projections, the bands (only when `get_kit_item_limit` is SERVED),
 *   the main component (ONE per kit, P2-a), the warnings, and — on a create that
 *   passes — the `add_kit_item` body.
 *
 * ## Which rows refuse, per arm (R-c, §2.6)
 *
 * - **create arms** (criar, recriar, converter) refuse on every row; when the
 *   scan says the new kit already exists and is linked (`completar`, a resume)
 *   nothing is sent, so the content rows are DROPPED, every recipe row becomes
 *   the warning `receita-nao-publicavel`, and the principal is not evaluated
 *   (L1: it is read back).
 * - **`kit-atualizar`** refuses only on the non-recipe rows; a SKU the scan and
 *   the import could not use becomes the warning `sku-do-kit-nao-enviado` (the
 *   republish resends the LIVE `item_sku`), and the per-bound-child rows
 *   (prices, recipe warnings, appends) are `republicarKit.ts`'s, which knows the
 *   binding. For it the plan carries two extra fields (PR 5's republish hooks):
 *   `receita` — every recipe row per child, which the republish turns into a
 *   warning for a BOUND child and into a skipped append for an unbound one — and
 *   `conteudo` — the item-level fields the update resends, decided HERE by the
 *   same readers the create uses, so the republish holds no second copy of the
 *   name, description, cover, weight, dimension or logistics rule (#1369).
 *
 * ⚠️ Every refusal is spelled through `MOTIVO_PUBLICACAO_BLOQUEADA` and never as
 * a quoted slug: `anuncios/errosPublicacao.test.ts` (O7) reads this file as the
 * producer of the nineteen kit-core members and asserts exactly that.
 *
 * ⚠️ L3: a component with `limitarEstoque: false` is SENT like every other one
 * (Shopee derives kit stock from all of them); it surfaces as the warning
 * `componente-nao-limita-estoque`, never as a refusal or an omission.
 */
import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  type ShopeeAddKitItemRequest,
  type ShopeeKitItemLimit,
  type ShopeeKitModelRequest,
  type ShopeeKitTierRequest,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  NOME_TIER_KIT_UNICO,
  OPCAO_TIER_KIT_UNICO,
  SHOPEE_KIT_MAX_MODELOS,
  chaveReceitaKitErp,
  componentesShopeeDoKit,
  ehKitNativoAtivo,
  ehVinculoSubstituido,
  escolherPrincipalDoKit,
  mesmoEnderecoDeComponente,
  problemasDeEstruturaDoKit,
  type EnderecoShopeeDoComponente,
  type LinhaComponenteKitShopee,
  type MotivoEstruturaKit,
  type MotivoFalhaComponenteKit,
} from '@delfrance/schemas';

import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  limitarMensagemProblema,
  type MotivoPublicacaoBloqueada,
  type ProblemaDeBloqueio,
} from '../anuncios/errosPublicacao';
import { construirLogistica } from '../anuncios/logisticaPublicacao';
import {
  dimensaoParaPublicar,
  pesoParaPublicar,
  type ProdutoParaPublicar,
} from '../anuncios/montagemAnuncio';
import type { FotosResolvidas } from '../anuncios/planoPublicacao';
import { estadoDoAnuncio } from '../anuncios/statusAnuncio';
import { skuDoItemShopee } from '../produtos/resolveProduto';
import { faixa, type FaixaDto } from '../taxonomia/limites';
import { CAP_FOTOS_KIT, STATUS_BUSCA_KIT } from './constantesKit';
import type { AchadoKitPorSku } from './localizarKitPorSku';
import type { AvisoKit, ContextoKit, VinculoDaConta } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** L9 "ensure the new kit exists": what a create arm does about the NEW kit. */
export type GarantiaDeKitNovo =
  | { readonly acao: 'criar' }
  | { readonly acao: 'completar'; readonly linkDocId: string; readonly itemId: number }
  | { readonly acao: 'recusar'; readonly problemas: readonly ProblemaDeBloqueio[] };

/** One kit model as planned — one per ERP child, in tier order. */
export interface ModeloDoPlanoKit {
  readonly filhoId: string;
  /** The option's position in the ONE tier — `tier_index: [tierIndex]` on a create. */
  readonly tierIndex: number;
  /**
   * The child's projection: SUMMED by Shopee address, and on a create that
   * passes, carrying the kit's ONE `main_component` flag (on the first model that
   * holds the principal). The rows the fold gate compares a read-back against.
   */
  readonly linhas: readonly LinhaComponenteKitShopee[];
  /**
   * `true` ⇔ every ERP component of the child resolved (and there is at least
   * one). Only a complete projection may be compared or stamped: a partial one
   * would fold DISTINCT for a reason that is not a recipe edit.
   */
  readonly projecaoCompleta: boolean;
}

/** What {@link planejarKit} decided. Nothing in it has been sent. */
export interface PlanoKit {
  /** Every refusal of THIS arm (empty ⇔ the run may proceed). */
  readonly problemas: readonly ProblemaDeBloqueio[];
  readonly avisos: readonly AvisoKit[];
  /** Create arms with a scan; `null` on `kit-atualizar` (no scan, L10(4)) or when no scan ran. */
  readonly kitNovo: GarantiaDeKitNovo | null;
  /** The `add_kit_item` body — non-null ONLY when `kitNovo` is `criar` and nothing refuses. */
  readonly corpo: ShopeeAddKitItemRequest | null;
  readonly modelos: readonly ModeloDoPlanoKit[];
  /**
   * The kit's main component: on a create that passes, the one flagged in
   * `corpo`; otherwise `ctx.principal` as read (the live main on a republish,
   * the completed kit's main on a resume).
   */
  readonly principal: EnderecoShopeeDoComponente | null;
  /** K's SKU when non-empty and trim-clean — what `item_sku` carries; `null` = not sendable. */
  readonly sku: string | null;
  /**
   * `kit-atualizar` ONLY (absent on a create arm): every RECIPE row of every
   * child — a component that did not resolve, an empty recipe, a one-component
   * model with quantity 1, a model outside the served component band. None of
   * them refuses a republish (L4(3)): `republicarKit.ts` turns each into the
   * warning `receita-nao-publicavel` for a BOUND child, and into a skipped
   * append (`variacao-nao-anexada`) for an unbound one.
   */
  readonly receita?: readonly LinhaDeReceitaDoKit[];
  /**
   * `kit-atualizar` ONLY (absent on a create arm): the item-level fields the
   * update resends (§2.6), each `null` when it cannot be built — and then a
   * refusal in `problemas` already says why.
   */
  readonly conteudo?: ConteudoDoKitAtualizado;
}

/** One recipe row of one child: it refuses a create, and only WARNS on a republish or a resume. */
export interface LinhaDeReceitaDoKit {
  readonly filhoId: string;
  /** The component the row is about, when it is about one. */
  readonly componenteId: string | null;
  readonly problema: ProblemaDeBloqueio;
}

/**
 * The item-level content a republish resends — the create's readers, applied to
 * the republish's inputs: the LIVE name and description first (the stored
 * link's, D2 §8), K's measures, the resolved cover, step 11's channel builder
 * over the stored logistics.
 */
export interface ConteudoDoKitAtualizado {
  readonly itemName: string | null;
  readonly description: string | null;
  /** `null` = the photo pass was skipped (a carried phase-A miss, a deleted kit) — never "no photo". */
  readonly imageIds: readonly string[] | null;
  readonly logisticInfo: ShopeeAddKitItemRequest['item_setting']['logistic_info'];
  readonly weight: number | null;
  readonly dimension: ReturnType<typeof dimensaoParaPublicar>;
}

/**
 * Phase A's input: the Firestore-only slice of the context, plus the rung-2
 * query. `familiaDeUm` and `grupo` are accepted so `prepararKit` can hand its
 * Firestore half as one object; phase A decides nothing on them.
 */
export type EntradaDaFaseA = Pick<
  ContextoKit,
  'arma' | 'produto' | 'filhos' | 'familiaDeUm' | 'grupo' | 'gruposDistintos' | 'descricao'
> & {
  /**
   * The target link (`kit-atualizar`): its LIVE `item_name`/`description` come
   * first on a republish (D2 §8). Absent ⇒ K's own `nome`/description.
   */
  readonly alvo?: ContextoKit['alvo'];
  /**
   * The ids the rung-2 query answered — `produtos where sku == K.sku and
   * paiId == null limit(2)`, the very query step 9's parent rung runs (R-14).
   * Create arms only; `null` = not run (`kit-atualizar`, or the plan's re-run),
   * which skips the `kit-sku-repetido` row.
   */
  readonly raizesComOSku: readonly string[] | null;
};

/** The conta's native-kit links of K, as {@link decidirKitNovo} reads them. */
export interface VinculosNativosDoKit {
  /** item_id → linkDocId of every `ehKitNativoAtivo` link, minus the excluded one. */
  readonly nossos: ReadonlyMap<number, string>;
  /** item_id → linkDocId of every superseded, not removed, native-kit link (minus the excluded one). */
  readonly substituidos: ReadonlyMap<number, string>;
  /** superseded linkDocId → the link that replaced it (`substituidoPorLinkDocId`). */
  readonly sucessorDe: ReadonlyMap<string, string>;
}

/* -------------------------------------------------------------------------- */
/*                              Small readers                                 */
/* -------------------------------------------------------------------------- */

/** A create arm: criar, and (PR 6) recriar and converter. Only `kit-atualizar` is not. */
function ehArmaDeCriacao(arma: ContextoKit['arma']): boolean {
  return arma.arma !== 'kit-atualizar';
}

/** Trimmed and non-empty, or `null` — blank means ABSENT. */
function textoUtilizavel(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const limpo = bruto.trim();
  return limpo.length > 0 ? limpo : null;
}

/**
 * The tier OPTION text a child's variante is SENT as — trimmed, `null` when
 * blank. ONE definition for the writer ({@link planejarTier}: the create's tier
 * and its `combinacao-duplicada` rule) and the binder (`aplicarKit.ts`'s
 * `ligarModelosDoKit`, whose option pass compares what the create SENT). The
 * fold's scope (R2-F1): `'Azul'` ≡ `' Azul '`, `'Azul'` ≢ `'azul'`.
 */
export function opcaoDoTierKit(variante: unknown): string | null {
  return textoUtilizavel(variante);
}

function numeroOuNull(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null;
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

function bloqueio(
  campo: string | null,
  motivo: MotivoPublicacaoBloqueada,
  mensagem: string,
): ProblemaDeBloqueio {
  return { campo, motivo, mensagem: limitarMensagemProblema(mensagem) };
}

/**
 * Where K's STORED SKU stands against step 9's rung-2 fold — the ONE definer of
 * what an imported kit's SKU is, `skuDoItemShopee` (`produtos/resolveProduto.ts`),
 * asked rather than re-derived (R2-F3):
 * - `'sem-sku'` — it folds to `''` (absent, empty or blank);
 * - `'com-espacos'` — it folds to something ELSE than itself, so the scan and the
 *   import, which compare the FOLDED SKU, could never find K by it;
 * - `'ok'` — a fixed point of the fold: what K stores is what the import reads.
 *
 * Phase A's `kit-sem-sku` / `kit-sku-com-espacos`, the republish's
 * `sku-do-kit-nao-enviado`, {@link skuEnviavel} and `prepararKit`'s rung-2 read
 * all ask THIS, so a wider fold (inner whitespace, NFC) moves every guard with it
 * instead of leaving a trim-clean SKU the scan can no longer match.
 */
export function situacaoDoSkuDoKit(sku: string | null): 'sem-sku' | 'com-espacos' | 'ok' {
  const dobrado = skuDoItemShopee({ item_sku: sku });
  if (dobrado === '') return 'sem-sku';
  return dobrado === sku ? 'ok' : 'com-espacos';
}

/** K's SKU as `item_sku` may carry it: a fixed point of step 9's fold, else `null`. */
function skuEnviavel(sku: string | null): string | null {
  return situacaoDoSkuDoKit(sku) === 'ok' ? sku : null;
}

/**
 * K projected for step 11's two measure readers (`pesoParaPublicar`,
 * `dimensaoParaPublicar`) — the ONE weight and dimension rule, never a second
 * copy. Only the measure fields and the freight flag are read off K; the
 * collections step 11 projects for its own item body (`precos`, `fotos`,
 * `componentesKit`, `variacoesUid`) come to a kit from {@link ContextoKit.filhos}
 * and the resolved photos instead, so they stay empty here.
 */
function produtoParaMedidas(produto: ContextoKit['produto']): ProdutoParaPublicar {
  const raw = produto.raw;
  return {
    id: produto.id,
    nome: textoUtilizavel(raw.nome) ?? '',
    sku: produto.sku,
    gtin: null,
    paiId: null,
    ehKit: raw.ehKit === true,
    ehKitVirtual: raw.ehKitVirtual === true,
    ehUsado: raw.ehUsado === true,
    ofereceFreteGratis: raw.ofereceFreteGratis === true,
    crossdocking: numeroOuNull(raw.crossdocking),
    pesoBrutoKg: numeroOuNull(raw.pesoBrutoKg),
    pesoLiquidoKg: numeroOuNull(raw.pesoLiquidoKg),
    alturaCm: numeroOuNull(raw.alturaCm),
    larguraCm: numeroOuNull(raw.larguraCm),
    profundidadeCm: numeroOuNull(raw.profundidadeCm),
    precos: null,
    variacoesUid: [],
    componentesKit: null,
    fotos: [],
  };
}

/** The listing name: K's `nome` on a create; the LIVE `item_name` first on a republish (D2 §8). */
function nomeDoKit(
  e: Pick<ContextoKit, 'arma' | 'produto'> & { readonly alvo?: ContextoKit['alvo'] },
): string | null {
  const doProduto = textoUtilizavel(e.produto.raw.nome);
  if (ehArmaDeCriacao(e.arma)) return doProduto;
  return textoUtilizavel(e.alvo?.raw.item_name) ?? doProduto;
}

/** The description: `extraData.descricao` on a create; the LIVE one first on a republish. */
function descricaoDoKit(
  e: Pick<ContextoKit, 'arma' | 'descricao'> & { readonly alvo?: ContextoKit['alvo'] },
): string | null {
  const doProduto = textoUtilizavel(e.descricao);
  if (ehArmaDeCriacao(e.arma)) return doProduto;
  return textoUtilizavel(e.alvo?.raw.description) ?? doProduto;
}

/** A stored `componentesKit` with no entry at all. */
function semComponentes(componentes: ContextoKit['filhos'][number]['componentesKit']): boolean {
  return componentes === null || Object.keys(componentes).length === 0;
}

/**
 * A stored `componentesKit`, read tolerantly and NOT parsed — the shape every
 * fingerprint reader folds (`@delfrance/data`'s aviso decision, the
 * `apps/functions` trigger, step 9's R-t). Anything not a map is `null`.
 * `prepararKit` keeps each child's on `FilhoDoKit.componentesKitArmazenado`; the
 * família-de-um mirror check reads K's through it.
 */
export function mapaDeKitArmazenado(
  bruto: unknown,
): NonNullable<ContextoKit['filhos'][number]['componentesKitArmazenado']> | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  return bruto as NonNullable<ContextoKit['filhos'][number]['componentesKitArmazenado']>;
}

/**
 * THE fingerprint of a child's recipe as the WRITER stamps it
 * (`receitaKitConferida`) — `chaveReceitaKitErp` of the STORED map, the same input
 * every reader folds, so a stamp of an unchanged recipe always equals the
 * reader's "current" (R1-RT7-02 / R3-03). The parsed map is NOT that input: an
 * entry stored without `quantidade` parses to 1 but folds to `null`. Only a
 * hand-built child with no stored map falls back to the parsed one.
 */
export function chaveReceitaArmazenadaDoFilho(
  filho: Pick<ContextoKit['filhos'][number], 'componentesKit' | 'componentesKitArmazenado'>,
): string {
  return chaveReceitaKitErp(
    filho.componentesKitArmazenado === undefined
      ? filho.componentesKit
      : filho.componentesKitArmazenado,
  );
}

/** Whether `valor` sits inside `banda`; an absent end is NO bound (step 11's rule). */
function dentroDaFaixa(valor: number, banda: FaixaDto | null): boolean {
  if (banda === null) return true;
  if (banda.min !== null && valor < banda.min) return false;
  if (banda.max !== null && valor > banda.max) return false;
  return true;
}

function descreverFaixa(banda: FaixaDto): string {
  const min = banda.min === null ? '—' : String(banda.min);
  const max = banda.max === null ? '—' : String(banda.max);
  return `${min}..${max}`;
}

/** The served kit limits, or `null` — every band below applies ONLY when served (R-f). */
function limitesServidos(ctx: Pick<ContextoKit, 'limites'>): ShopeeKitItemLimit | null {
  return ctx.limites?.estado === 'servido' ? ctx.limites.limites : null;
}

/**
 * How many of K's photos a kit sends (R-3, OP-10): `min(CAP_FOTOS_KIT, the
 * served `item_image_count_limit.max`)`, and {@link CAP_FOTOS_KIT} whenever the
 * band is not served or its max is absent or not positive. ONE rule for the two
 * sites that must agree — `prepararKit`'s upload cap (what `upload_image` fetches)
 * and `planejarKit`'s cover slice (what the body sends) — so the upload never
 * fetches N photos while the body slices to M.
 */
export function tetoDeFotosDoKit(servidos: ShopeeKitItemLimit | null): number {
  const maximo = servidos === null ? null : faixa(servidos.item_image_count_limit)?.max;
  return typeof maximo === 'number' && maximo > 0 ? Math.min(CAP_FOTOS_KIT, maximo) : CAP_FOTOS_KIT;
}

/* -------------------------------------------------------------------------- */
/*                       The sentences (pt-BR, ids only)                      */
/* -------------------------------------------------------------------------- */

/** A component resolution miss → its refusal. One table, spelled through the constant. */
const RECUSA_DA_FALHA_DE_COMPONENTE = {
  [MOTIVO_PUBLICACAO_BLOQUEADA.componenteNaoPublicado]: {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.componenteNaoPublicado,
    frase: (cid: string) =>
      `o componente ${cid} não tem anúncio nesta conta Shopee — publique-o (ou importe-o) antes do kit`,
  },
  [MOTIVO_PUBLICACAO_BLOQUEADA.componenteSemModelo]: {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.componenteSemModelo,
    frase: (cid: string) =>
      `o componente ${cid} tem variações na Shopee, mas o ERP não sabe qual variação compõe o kit — ` +
      'use a variação (não o produto pai) como componente, ou reimporte o anúncio dele',
  },
  [MOTIVO_PUBLICACAO_BLOQUEADA.componenteEKitNativo]: {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.componenteEKitNativo,
    frase: (cid: string) =>
      `o componente ${cid} é ele próprio um kit nativo da Shopee — kit de kits não é suportado`,
  },
  [MOTIVO_PUBLICACAO_BLOQUEADA.componenteAnuncioInativo]: {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.componenteAnuncioInativo,
    frase: (cid: string) => `o anúncio do componente ${cid} não está ativo nem pausado na Shopee`,
  },
} as const satisfies Record<
  MotivoFalhaComponenteKit,
  { readonly motivo: MotivoPublicacaoBloqueada; readonly frase: (cid: string) => string }
>;

/**
 * The two PER-MODEL rows `planejarKit` takes from `problemasDeEstruturaDoKit`.
 * The kit-level ones (`kit-sem-unidade-vendavel`, `kit-variacoes-demais`) and
 * an empty recipe (`kit-sem-componentes`) are phase A's, decided on the ERP
 * data before any read — taking them again here would report them twice.
 */
const ESTRUTURA_POR_MODELO: ReadonlySet<MotivoEstruturaKit> = new Set<MotivoEstruturaKit>([
  MOTIVO_PUBLICACAO_BLOQUEADA.kitComponenteUnicoQuantidade,
  MOTIVO_PUBLICACAO_BLOQUEADA.componentesForaDaFaixa,
]);

/** One end of a band, for a sentence: `—` when the category states none. */
function pontaDaFaixa(n: number | null | undefined): string {
  return typeof n === 'number' ? String(n) : '—';
}

/**
 * `vinculo-substituido` (L8): the link was replaced by a native kit and publish
 * no longer targets it. Shared by the duplicate scan (a hit on K's OWN
 * superseded kit — never "importe-o", S3F-09) and the dispatcher (PR 7), so
 * the two cannot word it apart. The leading ids say WHICH link "este anúncio"
 * is: a create arm names no `--link` of its own.
 */
export function problemaVinculoSubstituido(a: {
  readonly linkDocId: string;
  readonly itemId: number | null;
  /** The link that replaced it (`substituidoPorLinkDocId`), when known. */
  readonly novoLinkDocId: string | null;
}): ProblemaDeBloqueio {
  const qual =
    a.itemId === null
      ? `vínculo ${a.linkDocId}: `
      : `vínculo ${a.linkDocId} (item ${String(a.itemId)}): `;
  const frase =
    a.novoLinkDocId === null
      ? 'este anúncio foi substituído por outro kit nativo e não é mais publicado pelo ERP — ' +
        'publique sem --link; '
      : `este anúncio foi substituído pelo kit nativo ${a.novoLinkDocId} e não é mais publicado ` +
        `pelo ERP — publique sem --link (ou com --link ${a.novoLinkDocId}); `;
  return bloqueio(
    'linkDocId',
    MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido,
    qual +
      frase +
      'se ele ainda estiver ativo na Shopee, exclua-o no Seller Centre (para um kit antigo cuja ' +
      'exclusão falhou, --recriar com este --link tenta excluí-lo de novo)',
  );
}

/**
 * `vinculos-ambiguos` — 2+ LIVE native-kit links of the produto in this conta
 * (native only: two live ordinary listings keep step 11's pick, L10(3)). Shared
 * with the dispatcher (PR 7). Each link is named with its item.
 */
export function problemaVinculosAmbiguos(
  vinculos: readonly { readonly linkDocId: string; readonly itemId: number | null }[],
): ProblemaDeBloqueio {
  const ids = vinculos
    .map((v) => (v.itemId === null ? v.linkDocId : `${v.linkDocId} (item ${String(v.itemId)})`))
    .join(', ');
  return bloqueio(
    'linkDocId',
    MOTIVO_PUBLICACAO_BLOQUEADA.vinculosAmbiguos,
    `o produto tem ${String(vinculos.length)} kits nativos ativos nesta conta (${ids}) — informe ` +
      'qual com --link; se uma recriação foi interrompida, termine-a com --link <kit antigo> ' +
      '--recriar (se o --link apontar o kit novo, nada é excluído e a resposta diz qual é o antigo)',
  );
}

function problemaKitJaExiste(achados: readonly AchadoKitPorSku[]): ProblemaDeBloqueio {
  const ids = achados.map((a) => String(a.itemId)).join(', ');
  const vinculados = achados
    .filter((a) => a.vinculo !== null)
    .map(
      (a) => ` (item ${String(a.itemId)} já vinculado ao produto ${a.vinculo?.produtoId ?? '—'})`,
    )
    .join('');
  return bloqueio(
    'sku',
    MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee,
    `já existe na Shopee um kit com o SKU deste produto (item ${ids}) — importe-o ` +
      `(importar:anuncio) em vez de criar outro${vinculados}`,
  );
}

function problemaBuscaIncompleta(): ProblemaDeBloqueio {
  return bloqueio(
    'sku',
    MOTIVO_PUBLICACAO_BLOQUEADA.buscaDeKitIncompleta,
    'a busca de kit duplicado não terminou (mais de 10 000 anúncios) — nada foi criado',
  );
}

/**
 * `listagem-removida`, the KIT sentence (§2.5.2 "Reused"): the native kit a link
 * names reads deleted on Shopee. Shared by the republish (its live read, PR 5)
 * and the dispatcher (a stored `removido` native link, PR 7), so the two cannot
 * word it apart. Recreating it is the operator's explicit `--recriar` (L4(4)).
 */
export function problemaKitRemovido(a: {
  readonly itemId: number | null;
  readonly linkDocId: string;
}): ProblemaDeBloqueio {
  return bloqueio(
    null,
    MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida,
    `o kit nativo ${a.itemId === null ? '—' : String(a.itemId)} foi excluído na Shopee — ` +
      `publique com --link ${a.linkDocId} --recriar para criar um novo`,
  );
}

/**
 * Does the target kit's LIVE read say it is gone? Through step 11's ONE status
 * fold (`statusAnuncio.ts`): an ABSENT row (a purged kit, S2C-07) and the delete
 * statuses are `removido`; everything else — `BANNED` and `REVIEWING` included,
 * which Shopee itself answers for — is not. `null` (nothing was read) is not a
 * verdict. The clock only separates `agendado` from `pausado`, never `removido`.
 */
export function kitVivoRemovido(vivo: ContextoKit['vivo'], agoraMs: number): boolean {
  if (vivo === null) return false;
  const estado = estadoDoAnuncio(
    vivo.status === null
      ? { kind: 'ausente' }
      : { kind: 'lido', itemStatus: vivo.status, deboost: null, agendadoParaMs: null },
    agoraMs,
  ).estado;
  return estado === ESTADO_ANUNCIO_SHOPEE.removido;
}

/**
 * `receita-nao-publicavel` — a recipe row that cannot reach Shopee, on a run
 * that sends no recipe (a create-arm resume, a republish): the kit keeps the
 * recipe it has. ⚠️ NO `--recriar` advice — a recriar would refuse on the very
 * same row. Shared by the plan's resume branch and the republish.
 */
export function avisoReceitaNaoPublicavel(linha: LinhaDeReceitaDoKit): AvisoKit {
  const alvoDaLinha =
    linha.componenteId === null
      ? linha.problema.motivo
      : `${linha.problema.motivo}: ${linha.componenteId}`;
  return {
    codigo: 'receita-nao-publicavel',
    produtoId: linha.filhoId,
    mensagem:
      `a composição da variação ${linha.filhoId} no ERP não pode ir para a Shopee ` +
      `(${alvoDaLinha}) — o kit continua com a receita atual; corrija o componente ou a ` +
      'composição no ERP',
  };
}

/**
 * The PRICE rows of a kit's children — `sem-preco` (a família de um's member,
 * campo `original_price`) / `filho-sem-preco` (campo `filhos.{id}`), then
 * `preco-fora-da-faixa` only when the kit limits are SERVED for the principal's
 * category (R-f, R-g). ONE wording for both arms: a create prices EVERY child
 * (`filhoIds === null`); a republish only the BOUND ones (§2.6 — an unbound
 * child is an append candidate, decided there).
 */
export function problemasDePrecoDoKit(
  ctx: Pick<ContextoKit, 'produto' | 'filhos' | 'familiaDeUm' | 'limites'>,
  filhoIds: ReadonlySet<string> | null,
): ProblemaDeBloqueio[] {
  const kitId = ctx.produto.id;
  const servidos = limitesServidos(ctx);
  const bandaDePreco = servidos === null ? null : faixa(servidos.price_limit);
  const problemas: ProblemaDeBloqueio[] = [];
  for (const filho of ctx.filhos) {
    if (filhoIds !== null && !filhoIds.has(filho.produtoId)) continue;
    const campo = ctx.familiaDeUm ? 'original_price' : `filhos.${filho.produtoId}`;
    if (filho.preco === null) {
      problemas.push(
        ctx.familiaDeUm
          ? bloqueio(
              campo,
              MOTIVO_PUBLICACAO_BLOQUEADA.semPreco,
              `o kit ${kitId} não tem preço na tabela normal da conta (variação única ` +
                `${filho.produtoId})`,
            )
          : bloqueio(
              campo,
              MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
              `a variação ${filho.produtoId} do kit não tem preço na tabela normal da conta`,
            ),
      );
      continue;
    }
    if (bandaDePreco !== null && !dentroDaFaixa(filho.preco, bandaDePreco)) {
      problemas.push(
        bloqueio(
          campo,
          MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa,
          `o preço ${String(filho.preco)} da variação ${filho.produtoId} está fora da faixa ` +
            `da categoria do componente principal (${descreverFaixa(bandaDePreco)})`,
        ),
      );
    }
  }
  return problemas;
}

/* -------------------------------------------------------------------------- */
/*                                  Phase A                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Firestore-only refusals (R-c, R-14), EVERY miss listed — never the first
 * one. Order: the three SKU rows, `kit-sem-unidade-vendavel`, the four content
 * rows, then the structure rows.
 *
 * Create arms: all eleven rows. `kit-atualizar`: only `sem-nome`,
 * `sem-descricao`, `sem-peso` and `sem-dimensoes` — the SKU rows protect the
 * scan and the import (create-only; a republish warns `sku-do-kit-nao-enviado`
 * and resends the live SKU instead), and the structure rows decide what a
 * republish APPENDS, never whether it runs (§2.6).
 *
 * ⚠️ `produto.sku` is read AS STORED: a padded SKU must reach this function
 * padded, or `kit-sku-com-espacos` cannot fire.
 */
export function problemasDaFaseA(e: EntradaDaFaseA): readonly ProblemaDeBloqueio[] {
  const criacao = ehArmaDeCriacao(e.arma);
  const kitId = e.produto.id;
  const problemas: ProblemaDeBloqueio[] = [];

  if (criacao) {
    const situacao = situacaoDoSkuDoKit(e.produto.sku);
    if (situacao === 'sem-sku') {
      problemas.push(
        bloqueio(
          'sku',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitSemSku,
          `o kit ${kitId} não tem SKU — a Shopee, a busca de kit duplicado e a importação usam o SKU`,
        ),
      );
    } else if (situacao === 'com-espacos') {
      problemas.push(
        bloqueio(
          'sku',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuComEspacos,
          `o SKU do kit ${kitId} começa ou termina com espaço — corrija-o antes de publicar (a ` +
            'Shopee e a importação comparam o SKU sem os espaços das pontas, então o ERP não ' +
            'acharia este produto pelo SKU)',
        ),
      );
    } else if (e.raizesComOSku !== null) {
      // Step 9's parent rung binds only on EXACTLY one root with this SKU; any
      // other root here would make the L9 recovery import mint a new produto.
      const outros = e.raizesComOSku.filter((id) => id !== kitId);
      if (outros.length > 0) {
        problemas.push(
          bloqueio(
            'sku',
            MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuRepetido,
            `outro produto pai (${[...outros].sort(compararTexto).join(', ')}) tem o mesmo SKU ` +
              `do kit ${kitId} — a importação da Shopee acha o kit pelo SKU e não saberia a qual ` +
              'produto ligá-lo; deixe o SKU único antes de publicar',
          ),
        );
      }
    }
    if (e.filhos.length === 0) {
      problemas.push(
        bloqueio(
          'filhoUnicoId',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitSemUnidadeVendavel,
          `o kit ${kitId} não tem variação vendável — salve o produto no ERP para criar a ` +
            'variação única antes de publicar',
        ),
      );
    }
  }

  if (nomeDoKit(e) === null) {
    problemas.push(
      bloqueio('item_name', MOTIVO_PUBLICACAO_BLOQUEADA.semNome, 'o produto não tem nome'),
    );
  }
  if (descricaoDoKit(e) === null) {
    problemas.push(
      bloqueio(
        'description',
        MOTIVO_PUBLICACAO_BLOQUEADA.semDescricao,
        'o produto não tem descrição',
      ),
    );
  }
  const medidas = produtoParaMedidas(e.produto);
  if (pesoParaPublicar(medidas) === null) {
    problemas.push(
      bloqueio(
        'weight',
        MOTIVO_PUBLICACAO_BLOQUEADA.semPeso,
        'o produto não tem peso bruto nem líquido utilizável',
      ),
    );
  }
  if (dimensaoParaPublicar(medidas) === null) {
    problemas.push(
      bloqueio(
        'dimension',
        MOTIVO_PUBLICACAO_BLOQUEADA.semDimensoes,
        'altura, largura e profundidade são todas obrigatórias no Brasil e alguma está ausente',
      ),
    );
  }

  if (criacao) {
    for (const filho of e.filhos) {
      if (!semComponentes(filho.componentesKit)) continue;
      problemas.push(
        bloqueio(
          'componentesKit',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitSemComponentes,
          `a variação ${filho.produtoId} do kit não tem componentes`,
        ),
      );
    }
    const n = e.filhos.length;
    if (n > SHOPEE_KIT_MAX_MODELOS) {
      problemas.push(
        bloqueio(
          'filhos',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitVariacoesDemais,
          `a Shopee aceita no máximo ${String(SHOPEE_KIT_MAX_MODELOS)} variações num kit; este ` +
            `tem ${String(n)}`,
        ),
      );
    }
    if (n >= 2 && e.gruposDistintos !== 1) {
      problemas.push(
        bloqueio(
          'grupoDeVariacoesUid',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitDoisEixos,
          `a Shopee aceita kit com UM eixo de variação; este varia em ${String(e.gruposDistintos)} grupos`,
        ),
      );
    }
  }
  return problemas;
}

/* -------------------------------------------------------------------------- */
/*                     The conta's native links and the scan                  */
/* -------------------------------------------------------------------------- */

/**
 * Split the conta's links of K into what {@link decidirKitNovo} reads.
 * `excluirLinkDocId` = the recriar's TARGET (its old kit carries the same SKU
 * and is never "the new one"); `null` otherwise. Links are walked in id order,
 * so two links naming one `item_id` resolve to the lexically-first, every run.
 */
export function vinculosNativosDoKit(
  vinculos: readonly VinculoDaConta[],
  excluirLinkDocId: string | null,
): VinculosNativosDoKit {
  const nossos = new Map<number, string>();
  const substituidos = new Map<number, string>();
  const sucessorDe = new Map<string, string>();
  const ordenados = [...vinculos].sort((a, b) => compararTexto(a.id, b.id));
  for (const v of ordenados) {
    if (v.id === excluirLinkDocId) continue;
    const itemId = itemIdEnderecavel(v.raw.item_id);
    if (itemId === null) continue;
    if (ehKitNativoAtivo(v.raw)) {
      if (!nossos.has(itemId)) nossos.set(itemId, v.id);
      continue;
    }
    if (
      v.raw.kitNativo === true &&
      ehVinculoSubstituido(v.raw) &&
      v.raw.estadoAnuncio !== ESTADO_ANUNCIO_SHOPEE.removido
    ) {
      if (!substituidos.has(itemId)) substituidos.set(itemId, v.id);
      const novo = v.raw.substituidoPorLinkDocId;
      if (typeof novo === 'string' && novo !== '') sucessorDe.set(v.id, novo);
    }
  }
  return { nossos, substituidos, sucessorDe };
}

const STATUS_DE_KIT_EXISTENTE: ReadonlySet<string> = new Set<string>(STATUS_BUSCA_KIT);

/**
 * R-14 / L9 "ensure the new kit exists". Pure.
 *
 * - `nossos` = item_id → linkDocId of K's `ehKitNativoAtivo` links for the conta,
 *   MINUS the recriar target;
 * - `nossosVivos` = the base-info status of each `nossos` id the scan did NOT
 *   list (`null` = deleted/absent);
 * - `substituidosDeK` = item_id → linkDocId of K's superseded (not removed)
 *   native links for the conta;
 * - `sucessorDe` (optional) = superseded linkDocId → the link that replaced it,
 *   so `vinculo-substituido` can name the successor.
 *
 * `!completo` ⇒ `busca-de-kit-incompleta`. Otherwise ONE aggregated refusal
 * (V2R1-06) when any hit is not ours, carrying every kind at once:
 * `vinculo-substituido` for EACH hit on K's own superseded kit (never
 * "importe-o", S3F-09) AND `kit-ja-existe-na-shopee` listing EVERY other hit —
 * never a return on the first hit. OURS = (hits ∩ nossos) ∪ { n ∈ nossos :
 * nossosVivos.get(n) ∈ STATUS_BUSCA_KIT } — the LINK is authoritative: a linked
 * kit the list does not show yet still exists (S2C-02); a `nossos` id whose
 * status read `null` is dropped (the applier writes `removido` on that link).
 * OURS 0 ⇒ `criar`; 1 ⇒ `completar`; ≥ 2 ⇒ `vinculos-ambiguos`.
 */
export function decidirKitNovo(
  busca: { readonly completo: boolean; readonly achados: readonly AchadoKitPorSku[] },
  nossos: ReadonlyMap<number, string>,
  nossosVivos: ReadonlyMap<number, string | null>,
  substituidosDeK: ReadonlyMap<number, string>,
  sucessorDe: ReadonlyMap<string, string> = new Map<string, string>(),
): GarantiaDeKitNovo {
  if (!busca.completo) return { acao: 'recusar', problemas: [problemaBuscaIncompleta()] };

  const nossosAchados = new Set<number>();
  const estrangeiros: AchadoKitPorSku[] = [];
  const proprioSubstituido: { readonly itemId: number; readonly linkDocId: string }[] = [];
  for (const achado of busca.achados) {
    if (nossos.has(achado.itemId)) {
      nossosAchados.add(achado.itemId);
      continue;
    }
    const substituido = substituidosDeK.get(achado.itemId);
    if (substituido !== undefined) {
      proprioSubstituido.push({ itemId: achado.itemId, linkDocId: substituido });
      continue;
    }
    estrangeiros.push(achado);
  }

  const ours: { readonly itemId: number; readonly linkDocId: string }[] = [];
  for (const [itemId, linkDocId] of nossos) {
    const status = nossosVivos.get(itemId);
    const existe =
      nossosAchados.has(itemId) ||
      (typeof status === 'string' && STATUS_DE_KIT_EXISTENTE.has(status));
    if (existe) ours.push({ itemId, linkDocId });
  }
  ours.sort((a, b) => a.itemId - b.itemId);

  const problemas: ProblemaDeBloqueio[] = [];
  for (const s of [...proprioSubstituido].sort((a, b) => a.itemId - b.itemId)) {
    problemas.push(
      problemaVinculoSubstituido({
        linkDocId: s.linkDocId,
        itemId: s.itemId,
        novoLinkDocId: sucessorDe.get(s.linkDocId) ?? null,
      }),
    );
  }
  if (estrangeiros.length > 0) {
    problemas.push(problemaKitJaExiste([...estrangeiros].sort((a, b) => a.itemId - b.itemId)));
  }
  if (ours.length >= 2) problemas.push(problemaVinculosAmbiguos(ours));
  if (problemas.length > 0) return { acao: 'recusar', problemas };

  const unico = ours[0];
  if (unico === undefined) return { acao: 'criar' };
  return { acao: 'completar', linkDocId: unico.linkDocId, itemId: unico.itemId };
}

/* -------------------------------------------------------------------------- */
/*                                  The plan                                  */
/* -------------------------------------------------------------------------- */

/** The ONE tier of the kit: its name, one option per child, and the content rows it raised. */
interface TierDoKit {
  readonly nome: string;
  /** Option text per child, in tier order (= `ctx.filhos` order). */
  readonly opcoes: readonly string[];
  readonly problemas: readonly ProblemaDeBloqueio[];
}

/**
 * The tier (L2, R-8): a família de um (or a lone child with no axis) is the
 * sentinel pair `'Kit'` / `'Padrão'` (L10(1)); otherwise the ONE grupo's name and
 * each child's variante, in child order — one option per child, `tier_index:
 * [i]` = its position. A child of a multi-child kit with no variante cannot be
 * placed (`variacao-sem-vinculo`), and two children whose variantes are the same
 * text once trimmed would claim one option (`combinacao-duplicada`).
 */
function planejarTier(ctx: ContextoKit): TierDoKit {
  const n = ctx.filhos.length;
  const unico = ctx.filhos[0];
  if (
    n === 1 &&
    unico !== undefined &&
    (ctx.familiaDeUm || ctx.grupo === null || opcaoDoTierKit(unico.variante) === null)
  ) {
    return { nome: NOME_TIER_KIT_UNICO, opcoes: [OPCAO_TIER_KIT_UNICO], problemas: [] };
  }
  const problemas: ProblemaDeBloqueio[] = [];
  const opcoes: string[] = [];
  const donoDaOpcao = new Map<string, string>();
  for (const filho of ctx.filhos) {
    const opcao = opcaoDoTierKit(filho.variante);
    if (opcao === null || ctx.grupo === null) {
      problemas.push(
        bloqueio(
          `filhos.${filho.produtoId}`,
          MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          `a variação ${filho.produtoId} não tem variante no grupo ` +
            `${ctx.grupo?.id ?? '—'} — o kit precisa de uma opção por variação`,
        ),
      );
      opcoes.push('');
      continue;
    }
    const dono = donoDaOpcao.get(opcao);
    if (dono !== undefined) {
      problemas.push(
        bloqueio(
          `filhos.${filho.produtoId}`,
          MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada,
          `as variações ${dono} e ${filho.produtoId} do kit caem na mesma opção da Shopee — ` +
            'duas variações ocupariam um único modelo',
        ),
      );
    } else {
      donoDaOpcao.set(opcao, filho.produtoId);
    }
    opcoes.push(opcao);
  }
  return { nome: ctx.grupo?.nome ?? '', opcoes, problemas };
}

/** The component band (`component_count_limit_of_single_model`), only when served. */
function faixaDeComponentes(servidos: ShopeeKitItemLimit | null): {
  readonly faixa: FaixaDto;
  readonly paraEstrutura: { readonly min: number; readonly max: number };
} | null {
  if (servidos === null) return null;
  const banda = faixa(servidos.component_count_limit_of_single_model);
  if (banda === null || (banda.min === null && banda.max === null)) return null;
  return {
    faixa: banda,
    paraEstrutura: {
      min: banda.min ?? 0,
      max: banda.max ?? Number.POSITIVE_INFINITY,
    },
  };
}

/** The component that `principal` names, for a sentence: its produtoId, else its Shopee address. */
function rotuloDoPrincipal(ctx: ContextoKit): string {
  const principal = ctx.principal;
  if (principal === null) return '—';
  const ids = [...ctx.resolucao]
    .filter(([, r]) => r.ok && mesmoEnderecoDeComponente(r.endereco, principal))
    .map(([id]) => id)
    .sort(compararTexto);
  const primeiro = ids[0];
  if (primeiro !== undefined) return primeiro;
  return principal.modelId === null
    ? `item ${String(principal.itemId)}`
    : `item ${String(principal.itemId)} modelo ${String(principal.modelId)}`;
}

/**
 * OP-8: the `--principal` the operator NAMED that did not RESOLVE to a Shopee
 * address in this conta — absent from the resolution, or resolved `ok: false` —
 * refuses `principal-invalido`, naming it. Without this a named-but-unresolved
 * principal reads `principalPedido: null`, i.e. "not sent", and a one-item kit
 * silently takes its item's main while a two-item one asks for a principal the
 * operator already gave. `null` when none was named, or it resolved (a resolved
 * one is judged against the composition by `escolherPrincipalDoKit`).
 *
 * Create arms only: `prepararKit` throws it before the scan (no `get_item_list`,
 * no `upload_image` is spent on a run that cannot send), and `planejarKit`
 * re-evaluates it so a hand-built context can never default past it. A
 * republish never evaluates it: its main is READ BACK (L1) and `--principal` is
 * only compared (`principal-diferente`).
 */
export function problemaDoPrincipalSolicitado(
  ctx: Pick<ContextoKit, 'arma' | 'filhos' | 'resolucao' | 'principalSolicitado'>,
): ProblemaDeBloqueio | null {
  const id = ctx.principalSolicitado ?? null;
  if (id === null || !ehArmaDeCriacao(ctx.arma)) return null;
  const resolvido = ctx.resolucao.get(id);
  if (resolvido !== undefined && resolvido.ok) return null;
  const naReceita = ctx.filhos.some((f) => Object.keys(f.componentesKit ?? {}).includes(id));
  return bloqueio(
    'principal',
    MOTIVO_PUBLICACAO_BLOQUEADA.principalInvalido,
    naReceita
      ? `o componente principal ${id} não tem anúncio utilizável nesta conta Shopee — corrija o ` +
          'componente ou informe outro (--principal)'
      : `o componente principal ${id} não faz parte da composição do kit`,
  );
}

/**
 * The plan of one kit run (reconcile §2.5.3; the per-arm partition in the
 * module docblock). Pure: `ctx` is everything `prepararKit` read; `fotos` is the
 * resolved cover, or `null` when the run skipped the upload (a phase-A or scan
 * refusal, or a resume) — `null` is "not resolved", never "no photo", so
 * `sem-fotos` is evaluated only on a non-null value (V2R2-06).
 *
 * Phase A is RE-RUN here (so a dry run lists every miss in one place) but on a
 * create arm it cannot fire — `prepararKit` already threw on it.
 */
export function planejarKit(ctx: ContextoKit, fotos: FotosResolvidas | null): PlanoKit {
  const criacao = ehArmaDeCriacao(ctx.arma);
  const kitId = ctx.produto.id;
  const faseA = problemasDaFaseA({ ...ctx, raizesComOSku: null });
  const avisos: AvisoKit[] = [];
  const servidos = limitesServidos(ctx);
  const sku = skuEnviavel(ctx.produto.sku);

  /* ---- the SKU on a republish: kept live, warned (V2R1-07) ---------------- */
  if (!criacao && sku === null) {
    const motivo =
      situacaoDoSkuDoKit(ctx.produto.sku) === 'sem-sku'
        ? MOTIVO_PUBLICACAO_BLOQUEADA.kitSemSku
        : MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuComEspacos;
    avisos.push({
      codigo: 'sku-do-kit-nao-enviado',
      produtoId: kitId,
      mensagem:
        `o SKU do kit ${kitId} no ERP está vazio ou tem espaços nas pontas (${motivo}); a ` +
        'publicação manteve o SKU que está na Shopee — corrija o SKU no ERP',
    });
  }

  /* ---- a família de um: the member's recipe wins over K's mirror ---------- */
  const membro = ctx.filhos[0];
  if (ctx.familiaDeUm && ctx.filhos.length === 1 && membro !== undefined) {
    // Both sides through the ONE stored-map fold — never K's raw map against the
    // member's PARSED one (an absent `quantidade` would read null vs 1).
    const doKit = chaveReceitaKitErp(mapaDeKitArmazenado(ctx.produto.raw.componentesKit));
    const doMembro = chaveReceitaArmazenadaDoFilho(membro);
    if (doKit !== doMembro) {
      avisos.push({
        codigo: 'receita-espelho-divergente',
        produtoId: kitId,
        mensagem:
          `a composição do kit ${kitId} difere da da variação única ${membro.produtoId}; ` +
          'foi usada a da variação',
      });
    }
  }

  /* ---- each child's projection (its OWN recipe, L2) ----------------------- */
  const modelos: ModeloDoPlanoKit[] = [];
  const receita: LinhaDeReceitaDoKit[] = [];
  const naoLimitam = new Set<string>();
  ctx.filhos.forEach((filho, tierIndex) => {
    const projecao = componentesShopeeDoKit(filho.componentesKit, ctx.resolucao);
    if (!criacao && semComponentes(filho.componentesKit)) {
      // A create refuses an empty recipe in phase A; a republish only warns
      // (bound) or skips the append (unbound) — so here it is a recipe ROW.
      receita.push({
        filhoId: filho.produtoId,
        componenteId: null,
        problema: bloqueio(
          'componentesKit',
          MOTIVO_PUBLICACAO_BLOQUEADA.kitSemComponentes,
          `a variação ${filho.produtoId} do kit não tem componentes`,
        ),
      });
    }
    for (const falha of projecao.falhas) {
      const recusa = RECUSA_DA_FALHA_DE_COMPONENTE[falha.motivo];
      receita.push({
        filhoId: filho.produtoId,
        componenteId: falha.produtoId,
        problema: bloqueio(
          `componentesKit.${falha.produtoId}`,
          recusa.motivo,
          recusa.frase(falha.produtoId),
        ),
      });
    }
    for (const cid of projecao.naoLimitam) naoLimitam.add(cid);
    modelos.push({
      filhoId: filho.produtoId,
      tierIndex,
      linhas: projecao.linhas,
      projecaoCompleta: projecao.falhas.length === 0 && projecao.linhas.length > 0,
    });
  });

  /* ---- the per-model structure (both arms: a recipe ROW either way) ------- */
  const bandaDeComponentes = faixaDeComponentes(servidos);
  const estrutura = problemasDeEstruturaDoKit({
    // Only a COMPLETE projection is measured: a row missing because its
    // component did not resolve is that component's refusal, not a band miss.
    modelos: modelos.filter((m) => m.projecaoCompleta),
    faixaDeComponentes: bandaDeComponentes?.paraEstrutura ?? null,
  });
  for (const linha of estrutura) {
    if (!ESTRUTURA_POR_MODELO.has(linha.motivo) || linha.filhoId === null) continue;
    const mensagem =
      linha.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.kitComponenteUnicoQuantidade
        ? `a variação ${linha.filhoId} tem um único componente com quantidade 1 — um kit de ` +
          'um componente precisa de quantidade 2 ou mais'
        : 'a categoria do componente principal aceita de ' +
          `${pontaDaFaixa(bandaDeComponentes?.faixa.min)} a ` +
          `${pontaDaFaixa(bandaDeComponentes?.faixa.max)} componentes por variação; a variação ` +
          `${linha.filhoId} está fora`;
    receita.push({
      filhoId: linha.filhoId,
      componenteId: null,
      problema: bloqueio('componentesKit', linha.motivo, mensagem),
    });
  }

  /* ---- create arms: the L3 warnings, the tier ----------------------------- */
  const conteudo: ProblemaDeBloqueio[] = [];
  let tier: TierDoKit | null = null;
  if (criacao) {
    for (const cid of [...naoLimitam].sort(compararTexto)) {
      avisos.push({
        codigo: 'componente-nao-limita-estoque',
        produtoId: cid,
        mensagem:
          `o componente ${cid} está com «Limita estoque» desligado; a Shopee conta todos os ` +
          'componentes, então pode mostrar MENOS kits do que o ERP (nunca mais)',
      });
    }

    tier = planejarTier(ctx);
    conteudo.push(...tier.problemas);
  }

  /* ---- content rows: name and description bands (served only) ------------ */
  const nome = nomeDoKit(ctx);
  if (nome !== null && servidos !== null) {
    const banda = faixa(servidos.item_name_length_limit);
    if (banda !== null && !dentroDaFaixa(nome.length, banda)) {
      conteudo.push(
        bloqueio(
          'item_name',
          MOTIVO_PUBLICACAO_BLOQUEADA.nomeForaDaFaixa,
          `o nome tem ${String(nome.length)} caracteres, fora da faixa da categoria do ` +
            `componente principal (${descreverFaixa(banda)}) — nunca truncado`,
        ),
      );
    }
  }
  const descricao = descricaoDoKit(ctx);
  const limiteDescricao = servidos?.description_limit ?? null;
  if (descricao !== null && limiteDescricao !== null) {
    const banda: FaixaDto = {
      min: limiteDescricao.description_length_min,
      max: limiteDescricao.description_length_max,
    };
    if (!dentroDaFaixa(descricao.length, banda)) {
      conteudo.push(
        bloqueio(
          'description',
          MOTIVO_PUBLICACAO_BLOQUEADA.descricaoForaDaFaixa,
          `a descrição tem ${String(descricao.length)} caracteres, fora da faixa da categoria ` +
            `do componente principal (${descreverFaixa(banda)})`,
        ),
      );
    }
  }

  /* ---- create arms: each child's price (a republish prices BOUND children,
   *      through the same `problemasDePrecoDoKit`, in `republicarKit.ts`) ---- */
  if (criacao) conteudo.push(...problemasDePrecoDoKit(ctx, null));

  /* ---- the cover (cap 9, and the served count) ---------------------------- */
  let imagens: readonly string[] = [];
  if (fotos !== null) {
    imagens = fotos.item.imageIds.slice(0, tetoDeFotosDoKit(servidos));
    if (imagens.length === 0) {
      conteudo.push(
        bloqueio(
          'image',
          MOTIVO_PUBLICACAO_BLOQUEADA.semFotos,
          'nenhuma foto utilizável — a Shopee exige ao menos uma imagem no anúncio',
        ),
      );
    }
  }

  /* ---- logistics (step 11's ONE channel builder) -------------------------- */
  const medidas = produtoParaMedidas(ctx.produto);
  const peso = pesoParaPublicar(medidas);
  const dimensao = dimensaoParaPublicar(medidas);
  const armazenado = ctx.alvo?.raw.logistic_info;
  const logistica = construirLogistica({
    canais: ctx.canais,
    armazenado: Array.isArray(armazenado) ? (armazenado as readonly unknown[]) : null,
    pesoKg: peso,
    dimensaoCm: dimensao,
    ofereceFreteGratis: medidas.ofereceFreteGratis,
  });
  conteudo.push(...logistica.problemas);

  /* ---- kit-atualizar: only the non-recipe rows refuse (§2.6) -------------- */
  if (!criacao) {
    return {
      problemas: [...faseA, ...conteudo],
      avisos,
      kitNovo: null,
      corpo: null,
      modelos,
      principal: ctx.principal,
      sku,
      // The republish decides, per child, what each recipe row becomes — it
      // knows the binding; the plan only lists them (none refuses, L4(3)).
      receita,
      conteudo: {
        itemName: nome,
        description: descricao,
        imageIds: fotos === null ? null : imagens,
        logisticInfo: logistica.logistic_info,
        weight: peso,
        dimension: dimensao,
      },
    };
  }

  /* ---- create arms: ensure the new kit exists (L9, R-14) ------------------ */
  let kitNovo: GarantiaDeKitNovo | null = null;
  if (ctx.busca !== null) {
    const v = vinculosNativosDoKit(ctx.vinculos, ctx.alvo?.linkDocId ?? null);
    kitNovo = decidirKitNovo(ctx.busca, v.nossos, ctx.nossosVivos, v.substituidos, v.sucessorDe);
  }

  // OP-8: a NAMED principal that did not resolve refuses on every create path —
  // a resume included, because the recriar's delete gate compares it.
  const principalNaoResolvido = problemaDoPrincipalSolicitado(ctx);
  const doPrincipalSolicitado = principalNaoResolvido === null ? [] : [principalNaoResolvido];

  if (kitNovo?.acao === 'completar') {
    // A resume sends nothing: the content rows guard nothing and are DROPPED;
    // a recipe row cannot strand a live kit, so it is a warning (V2R1-07); the
    // principal is read back, never evaluated (L1, S1F-06) — only a named one
    // that does not resolve refuses (OP-8).
    for (const linha of receita) avisos.push(avisoReceitaNaoPublicavel(linha));
    return {
      problemas: [...faseA, ...doPrincipalSolicitado],
      avisos,
      kitNovo,
      corpo: null,
      modelos,
      principal: ctx.principal,
      sku,
    };
  }

  // One refusal per (motivo, campo): a component missing from three children is
  // ONE thing to fix.
  const receitaUnica: ProblemaDeBloqueio[] = [];
  const vistos = new Set<string>();
  for (const linha of receita) {
    const chave = `${linha.problema.motivo}\u0000${linha.problema.campo ?? ''}\u0000${
      linha.componenteId === null ? linha.filhoId : ''
    }`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    receitaUnica.push(linha.problema);
  }

  if (kitNovo?.acao === 'recusar') {
    return {
      problemas: [
        ...faseA,
        ...kitNovo.problemas,
        ...receitaUnica,
        ...doPrincipalSolicitado,
        ...conteudo,
      ],
      avisos,
      kitNovo,
      corpo: null,
      modelos,
      principal: ctx.principal,
      sku,
    };
  }

  /* ---- criar (or no scan): ONE main per kit (L1, P2-a) -------------------- */
  const problemasDoPrincipal: ProblemaDeBloqueio[] = [...doPrincipalSolicitado];
  let modelosFinais: readonly ModeloDoPlanoKit[] = modelos;
  let principal = ctx.principal;
  const escolha = escolherPrincipalDoKit(
    modelos.map((m) => m.linhas),
    ctx.principal,
  );
  if (principalNaoResolvido !== null) {
    // The named principal is already refused; never default past it (OP-8).
  } else if (escolha.ok) {
    principal = escolha.principal;
    modelosFinais = modelos.map((m, i) => ({ ...m, linhas: escolha.modelos[i] ?? m.linhas }));
  } else if (escolha.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio) {
    problemasDoPrincipal.push(
      bloqueio(
        'principal',
        MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio,
        'o kit tem componentes de mais de um anúncio da Shopee — informe o componente principal ' +
          '(--principal); a Shopee copia dele categoria, atributos e marca e não deixa trocar depois',
      ),
    );
  } else if (modelos.some((m) => m.linhas.length > 0)) {
    // A recipe with no resolved row at all has no candidate either; its recipe
    // rows are then what the operator acts on, so `principal-invalido` is said
    // only about a principal absent from a composition that HAS rows.
    problemasDoPrincipal.push(
      bloqueio(
        'principal',
        MOTIVO_PUBLICACAO_BLOQUEADA.principalInvalido,
        `o componente principal ${rotuloDoPrincipal(ctx)} não faz parte da composição do kit`,
      ),
    );
  }

  const problemas = [...faseA, ...receitaUnica, ...problemasDoPrincipal, ...conteudo];
  const corpo =
    kitNovo?.acao === 'criar' && problemas.length === 0 && tier !== null
      ? montarCorpo({
          nome,
          descricao,
          imagens,
          logistica: logistica.logistic_info,
          peso,
          dimensao,
          sku,
          tier,
          modelos: modelosFinais,
          filhos: ctx.filhos,
          pausado: ctx.statusPedido === SHOPEE_ITEM_STATUS_WRITABLE.unlist,
        })
      : null;

  return { problemas, avisos, kitNovo, corpo, modelos: modelosFinais, principal, sku };
}

/** The `add_kit_item` body of a create that passed every row. `null` if a piece is missing. */
function montarCorpo(a: {
  readonly nome: string | null;
  readonly descricao: string | null;
  readonly imagens: readonly string[];
  readonly logistica: ShopeeAddKitItemRequest['item_setting']['logistic_info'];
  readonly peso: number | null;
  readonly dimensao: ReturnType<typeof dimensaoParaPublicar>;
  readonly sku: string | null;
  readonly tier: TierDoKit;
  readonly modelos: readonly ModeloDoPlanoKit[];
  readonly filhos: ContextoKit['filhos'];
  /** OP-9: `--status UNLIST` on a create ⇒ `unlisted: true`; otherwise the key is not sent. */
  readonly pausado: boolean;
}): ShopeeAddKitItemRequest | null {
  if (a.nome === null || a.descricao === null || a.peso === null || a.sku === null) return null;
  if (a.imagens.length === 0) return null;
  const modelList: ShopeeKitModelRequest[] = [];
  for (const modelo of a.modelos) {
    const filho = a.filhos.find((f) => f.produtoId === modelo.filhoId);
    if (filho === undefined || filho.preco === null) return null;
    const tierIndex: readonly [number] = [modelo.tierIndex];
    const modelSku = textoUtilizavel(filho.sku) === null ? null : filho.sku;
    modelList.push({
      tier_index: tierIndex,
      original_price: filho.preco,
      component_list: modelo.linhas,
      ...(modelSku === null ? {} : { model_sku: modelSku }),
    });
  }
  const tier: ShopeeKitTierRequest = {
    name: a.tier.nome,
    option_list: a.tier.opcoes.map((option) => ({ option })),
  };
  return {
    item_setting: {
      item_name: a.nome,
      images: { image_id_list: a.imagens },
      description_type: 'normal',
      description: a.descricao,
      logistic_info: a.logistica,
      weight: a.peso,
      ...(a.dimensao === null ? {} : { dimension: a.dimensao }),
      item_sku: a.sku,
      tier_variation_list: [tier],
      model_list: modelList,
      // OP-9: the operator's `--status UNLIST` creates the kit paused. NORMAL
      // sends NO key — Shopee's default, the body both probes measured — so the
      // unmeasured flag rides only the run that asked for it (register 305).
      ...(a.pausado ? { unlisted: true } : {}),
    },
    // DTS syncs from the main component by design (D2 §8).
    sync_setting: { auto_sync_dts: true },
  };
}
