/**
 * The box/bag estimator — moved here from
 * `apps/web/app/(app)/pedidos/_components/tabs/frete/dimensoesPedido.ts` (#371 /
 * PR #1153) so BOTH consumers can reach it: the pedido Frete tab in `apps/web`,
 * and the kit rollup task in `apps/functions` (#1152). It was pure from the
 * start and imports nothing browser-shaped, so the move is a relocation.
 *
 * Two additions on the way: the {@link EstimarDimensoesOptions.fatorOcupacao}
 * knob (see {@link FATOR_OCUPACAO}), and {@link itensDeComponentesKit}, which is
 * what lets a kit reuse this estimator instead of growing a second algorithm.
 *
 * ⚠️ Say "dimensões", not "medidas", for anything new in this area —
 * `tabelaDeMedidas` is the moda size-chart collection and the words collide.
 * {@link ProdutoMedidas} is the one exception: it predates the rule, is already
 * `Produto`-prefixed, and renaming it would churn unrelated call sites.
 */
import type { ComponentesKit } from '../collection/embedded/kit';

/** A box, in centimetres, on the `Dimensoes` wire axes. */
export interface DimensoesCm {
  altura: number;
  largura: number;
  comprimento: number;
}

/**
 * `Dimensoes.padrao()` (`.old/packages/pedido/lib/src/models.dart:1077-1083`),
 * raised to the legal minimum — the legacy 10cm comprimento sits below the
 * 11cm Correios floor for a caixa/pacote. Used whenever no item resolves a
 * full set of dimensions.
 */
export const DIMENSOES_PADRAO: DimensoesCm = { altura: 10, largura: 10, comprimento: 11 };

/**
 * The produto fields the freight estimators need — weight for `pesoPedido`,
 * the three dimensions for {@link estimarDimensoes}, and `paiId` for the
 * variation→parent fallback both use. Callers batch-fetch these keyed by
 * produto id, including any parent a variation needs (`loadProdutoPesoMap` in
 * `apps/web`, `carregarDimensoes` in `apps/functions`).
 */
export interface ProdutoMedidas {
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  /** ⚠️ The third axis is `profundidadeCm` on produto, `comprimento` on the wire. */
  alturaCm: number | null;
  larguraCm: number | null;
  profundidadeCm: number | null;
  paiId: string | null;
}

/**
 * One thing to fit in the box: a produto id and how many of it. A pedido item
 * and a `componentesKit` entry both reduce to this shape.
 */
export interface ItemDimensoes {
  produtoUid: string | null | undefined;
  quantidade: number | null | undefined;
}

/**
 * A pedido item's `produtoUid` can be a legacy full path (`produtos/p2`, the
 * old Flutter ODM convention) instead of a bare id — the same fixup
 * `productIdsFromPedidos` applies (`lib/pedido/downloadAnexos.ts`) and the one
 * legacy `getPesoPedido` itself does (`.split('/').last`, per issue #371's
 * legacy-context comment). Every produtoUid lookup goes through this so a
 * legacy row still resolves its produto instead of silently falling back to
 * the 1kg/unit default.
 */
export function normalizeProdutoId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw;
  return id || null;
}

/**
 * Packing efficiency for mixed items — you never fill a box to 100%. The
 * legacy used the same 0.7 (`.old/packages/pedido/lib/src/models.dart:2835`).
 *
 * It inflates the declared volume ~43%, which matters less than it looks:
 * Correios only bills *peso cubado* (`C x L x A / 6000`) once it exceeds the
 * real weight, i.e. above ~30.000 cm3. Below that this factor affects whether
 * the parcel is ACCEPTED, not what it costs.
 *
 * ⚠️ It must be applied EXACTLY ONCE per parcel, which is why it is a parameter
 * and not a constant folded into the arithmetic. A kit's stored dimensions are
 * themselves produced by this estimator and are then fed BACK into it as a
 * pedido line, so the kit-level call passes `fatorOcupacao: 1` — a kit's
 * components are packed together deliberately, not loosely, and the pedido level
 * still applies the allowance. Applying it at both levels declares ~2x the
 * volume actually needed and can push a single-kit order into a larger bag or
 * over the {@link LIMITE_SEM_SOBRETAXA_CM} surcharge line (#1152).
 */
export const FATOR_OCUPACAO = 0.7;

/**
 * Most carriers surcharge a parcel with ANY side over 60cm, so 60 is a target
 * to stay under, not a legal limit. {@link LIMITE_LEGAL_CM} and
 * {@link LIMITE_SOMA_CM} are the real Correios ceilings for a caixa/pacote
 * (https://www2.correios.com.br/sistemas/precosprazos/Formato.cfm).
 */
export const LIMITE_SEM_SOBRETAXA_CM = 60;
export const LIMITE_LEGAL_CM = 100;
export const LIMITE_SOMA_CM = 200;

/** Correios minimums for a caixa/pacote. */
export const MIN_ALTURA_CM = 0.4;
export const MIN_LARGURA_CM = 6;
export const MIN_COMPRIMENTO_CM = 11;
export const MIN_SOMA_CM = 17.4;

/** Envelopes de seguranca stocked here, `largura x comprimento`. */
export const SACOS_PADRAO: readonly Readonly<{ largura: number; comprimento: number }>[] = [
  { largura: 12, comprimento: 18 },
  { largura: 19, comprimento: 25 },
  { largura: 20, comprimento: 30 },
  { largura: 26, comprimento: 36 },
  { largura: 32, comprimento: 40 },
  { largura: 40, comprimento: 50 },
  { largura: 50, comprimento: 60 },
  { largura: 50, comprimento: 70 },
];

/**
 * Past this thickness a bag stops behaving like an envelope — it is a parcel
 * in a plastic wrapper, and a box both protects better and quotes no worse.
 */
export const ESPESSURA_MAX_SACO_CM = 8;

export type AvisoDimensoes =
  /** No item resolved a full set of dimensions — {@link DIMENSOES_PADRAO} used. */
  | 'semDimensoes'
  /** Fits, but a side is over 60cm, so expect a carrier surcharge. */
  | 'excedeu60'
  /** Beyond what Correios accepts — clamped; the pedido needs splitting. */
  | 'excedeuLimiteLegal';

export type Embalagem = 'saco' | 'caixa';

export interface EstimativaDimensoes {
  dimensoes: DimensoesCm;
  embalagem: Embalagem;
  aviso: AvisoDimensoes | null;
}

export interface EstimarDimensoesOptions {
  /** Defaults to {@link FATOR_OCUPACAO}; a kit rollup passes `1`. */
  fatorOcupacao?: number;
}

const volumeDe = (d: DimensoesCm) => d.altura * d.largura * d.comprimento;

/**
 * `>=` with a relative epsilon. The growth below raises an axis to EXACTLY the
 * volume required, so a bare `>=` compares two numbers that differ only in
 * float error — and a box that is 1e-10 short would be rejected, dropping a
 * perfectly good fit through to the next tier.
 */
const cabe = (disponivel: number, exigido: number) => disponivel >= exigido * (1 - 1e-9);
const somaDe = (d: DimensoesCm) => d.altura + d.largura + d.comprimento;

/**
 * Resolve one produto's box: its own three dimensions when ALL are present and
 * `> 0`, else its parent's.
 *
 * ⚠️ This is the THIRD distinct resolution rule in this area and they are not
 * interchangeable. `pesoPedido` consults the parent only when both own weights
 * are null-or-zero; the legacy `getDimensoes` (`models.dart:2797`) uses the
 * parent **unconditionally** whenever `paiId` is set — which throws away a
 * variation's real box. This rule mirrors the weight half instead: own data
 * wins, the parent is only a fallback.
 */
function medidasDo(
  produto: ProdutoMedidas | null | undefined,
  porId: Readonly<Record<string, ProdutoMedidas | null | undefined>>,
): DimensoesCm | null {
  const completo = (p: ProdutoMedidas | null | undefined): DimensoesCm | null => {
    if (!p) return null;
    // produto stores the third axis as `profundidadeCm`; the Volume wire calls
    // it `comprimento`. Renamed here, exactly as the legacy did (:2814 → :2940).
    const { alturaCm: a, larguraCm: l, profundidadeCm: c } = p;
    if (a == null || l == null || c == null) return null;
    if (a <= 0 || l <= 0 || c <= 0) return null;
    return { altura: a, largura: l, comprimento: c };
  };
  return completo(produto) ?? (produto?.paiId ? completo(porId[produto.paiId]) : null);
}

/**
 * Grow a box from `pisos` until it holds `volume`, never exceeding `cap` on a
 * side nor `somaMax` in total. `null` when that cannot be done.
 *
 * Every free axis grows by the SAME factor each pass, which keeps the box as
 * cube-like as its item floors allow — and a cube-like box has the smallest
 * possible largest-side, exactly what matters when any side over 60cm costs
 * money. (The legacy does the opposite: it fills altura to the cap, then
 * largura, then comprimento, driving one side up as fast as possible.)
 */
function ajustarCaixa(
  pisos: DimensoesCm,
  volume: number,
  cap: number,
  somaMax: number,
): DimensoesCm | null {
  const d: [number, number, number] = [pisos.altura, pisos.largura, pisos.comprimento];
  if (d.some((v) => v > cap)) return null;
  if (d[0] + d[1] + d[2] > somaMax) return null;

  /** How far axis `i` may grow: its own cap, and whatever the sum still allows. */
  const teto = (i: number) => {
    const outros = d.reduce((acc, v, j) => (j === i ? acc : acc + v), 0);
    return Math.min(cap, somaMax - outros);
  };

  for (let passo = 0; passo < 32; passo++) {
    const atual = d[0] * d[1] * d[2];
    if (cabe(atual, volume)) break;
    const livres = [0, 1, 2].filter((i) => d[i]! < teto(i));
    if (livres.length === 0) return null;

    const fator = Math.pow(volume / atual, 1 / livres.length);
    let progrediu = false;
    for (const i of livres) {
      // `teto` is recomputed per axis, so raising one never pushes the sum over.
      const novo = Math.min(teto(i), d[i]! * fator);
      if (novo > d[i]! + 1e-9) progrediu = true;
      d[i] = novo;
    }
    if (!progrediu) return null;
  }

  const caixa = { altura: d[0], largura: d[1], comprimento: d[2] };
  return cabe(volumeDe(caixa), volume) ? caixa : null;
}

/** The floor each axis may never go below, in the same shape as a box. */
const MINIMOS: DimensoesCm = {
  altura: MIN_ALTURA_CM,
  largura: MIN_LARGURA_CM,
  comprimento: MIN_COMPRIMENTO_CM,
};
const EIXOS = ['altura', 'largura', 'comprimento'] as const;

/**
 * Whole centimetres (a box must CONTAIN the volume, and real cartons are
 * integers), then the legal minimums — and finally the legal SUM.
 *
 * ⚠️ The minimums clamp **up**, so on a very flat box they can push the sum past
 * the ceiling the growth above carefully respected: a 2cm axis becomes 11cm and
 * `98 + 98 + 2` turns into `98 + 98 + 11 = 207`. Give the excess back from the
 * largest axis — most room, least proportional loss — never taking any axis
 * below its own minimum. Every exit goes through here, so this is the one place
 * the sum contract can be enforced for good.
 */
function finalizar(d: DimensoesCm): DimensoesCm {
  const caixa: DimensoesCm = {
    altura: Math.max(MIN_ALTURA_CM, Math.ceil(d.altura)),
    largura: Math.max(MIN_LARGURA_CM, Math.ceil(d.largura)),
    comprimento: Math.max(MIN_COMPRIMENTO_CM, Math.ceil(d.comprimento)),
  };

  for (let passo = 0; passo < 64 && somaDe(caixa) > LIMITE_SOMA_CM; passo++) {
    const alvo = EIXOS.filter((e) => caixa[e] > MINIMOS[e]).sort((a, b) => caixa[b] - caixa[a])[0];
    if (!alvo) break;
    const excesso = somaDe(caixa) - LIMITE_SOMA_CM;
    caixa[alvo] = Math.max(MINIMOS[alvo], caixa[alvo] - excesso);
  }

  if (somaDe(caixa) >= MIN_SOMA_CM) return caixa;
  return { ...caixa, comprimento: caixa.comprimento + (MIN_SOMA_CM - somaDe(caixa)) };
}

/**
 * The warning a finished box earns, derived from the box itself rather than from
 * which branch produced it.
 *
 * Deriving it is what keeps the bag path honest: `SACOS_PADRAO` stocks 50×60 and
 * 50×70, so a mailer can carry a 70cm side, and hardcoding `aviso: null` there
 * meant the one operator packing a long flat item was the only one never told
 * about the surcharge.
 *
 * A box that no longer holds the volume — because {@link finalizar} had to trim
 * it back under the legal sum — is reported as over the limit, since that is
 * exactly what it is.
 */
function classificar(dimensoes: DimensoesCm, volumeExigido: number): AvisoDimensoes | null {
  if (!cabe(volumeDe(dimensoes), volumeExigido)) return 'excedeuLimiteLegal';
  const maior = Math.max(dimensoes.altura, dimensoes.largura, dimensoes.comprimento);
  return maior > LIMITE_SEM_SOBRETAXA_CM ? 'excedeu60' : null;
}

/**
 * Smallest stocked bag that holds the pedido. A bag has a fixed footprint and
 * a thickness that grows with the contents — `espessura = volume / area` —
 * never thinner than the chunkiest single item.
 */
function escolherSaco(
  volume: number,
  maiorLado: number,
  ladoMedio: number,
  menorLado: number,
): DimensoesCm | null {
  const candidatos = [...SACOS_PADRAO].sort(
    (a, b) => a.largura * a.comprimento - b.largura * b.comprimento,
  );
  for (const saco of candidatos) {
    const maiorAresta = Math.max(saco.largura, saco.comprimento);
    const menorAresta = Math.min(saco.largura, saco.comprimento);
    // The worst item on each axis must lie flat in the footprint (rotated if
    // that helps).
    if (maiorLado > maiorAresta || ladoMedio > menorAresta) continue;
    const espessura = Math.max(volume / (saco.largura * saco.comprimento), menorLado);
    if (espessura > ESPESSURA_MAX_SACO_CM) continue;
    return { altura: espessura, largura: saco.largura, comprimento: saco.comprimento };
  }
  return null;
}

/**
 * Estimate the box (or bag) a set of items ships in — the re-derived half of
 * #371, replacing `Volume.padrao`'s hardcoded 10x10x10cm.
 *
 * `itens` must already exclude staged-for-deletion rows. `produtoMedidasById`
 * is the batched map from `loadProdutoPesoMap`, keyed by NORMALIZED produto id
 * and carrying any parent a dimensionless variation needs.
 *
 * A row contributes only when its produto resolves all three dimensions `> 0`;
 * rows with `quantidade <= 0` are skipped entirely (legacy parity — and note
 * this differs from `pesoPedido`, which coerces such a quantidade to 1).
 * Nothing resolvable → {@link DIMENSOES_PADRAO} with `aviso: 'semDimensoes'`.
 */
export function estimarDimensoes(
  itens: readonly ItemDimensoes[],
  produtoMedidasById: Readonly<Record<string, ProdutoMedidas | null | undefined>>,
  opts?: EstimarDimensoesOptions,
): EstimativaDimensoes {
  const fatorOcupacao = opts?.fatorOcupacao ?? FATOR_OCUPACAO;
  let volume = 0;
  const pisos: DimensoesCm = { altura: 0, largura: 0, comprimento: 0 };
  // Per-item extents, sorted within each item, so a bag footprint is checked
  // against the worst REAL item rather than a per-axis maximum no single item
  // actually has.
  let maiorLado = 0;
  let ladoMedio = 0;
  let menorLado = 0;

  for (const item of itens) {
    const quantidade = item.quantidade;
    if (quantidade == null || !Number.isFinite(quantidade) || quantidade <= 0) continue;
    const produtoId = normalizeProdutoId(item.produtoUid);
    if (!produtoId) continue;
    const medidas = medidasDo(produtoMedidasById[produtoId], produtoMedidasById);
    if (!medidas) continue;

    volume += volumeDe(medidas) * quantidade;
    pisos.altura = Math.max(pisos.altura, medidas.altura);
    pisos.largura = Math.max(pisos.largura, medidas.largura);
    pisos.comprimento = Math.max(pisos.comprimento, medidas.comprimento);

    const lados = [medidas.altura, medidas.largura, medidas.comprimento].sort((x, y) => y - x);
    maiorLado = Math.max(maiorLado, lados[0]!);
    ladoMedio = Math.max(ladoMedio, lados[1]!);
    menorLado = Math.max(menorLado, lados[2]!);
  }

  if (volume <= 0) {
    return { dimensoes: DIMENSOES_PADRAO, embalagem: 'caixa', aviso: 'semDimensoes' };
  }
  volume /= fatorOcupacao;

  const saco = escolherSaco(volume, maiorLado, ladoMedio, menorLado);
  if (saco) {
    const dimensoes = finalizar(saco);
    return { dimensoes, embalagem: 'saco', aviso: classificar(dimensoes, volume) };
  }

  // `Math.ceil` in `finalizar` can add up to 1cm per axis, so hold 3cm of the
  // sum allowance back rather than rounding our way past the legal limit.
  const somaMax = LIMITE_SOMA_CM - 3;
  const semSobretaxa = ajustarCaixa(pisos, volume, LIMITE_SEM_SOBRETAXA_CM, somaMax);
  if (semSobretaxa) {
    const dimensoes = finalizar(semSobretaxa);
    return { dimensoes, embalagem: 'caixa', aviso: classificar(dimensoes, volume) };
  }

  const legal = ajustarCaixa(pisos, volume, LIMITE_LEGAL_CM, somaMax);
  if (legal) {
    const dimensoes = finalizar(legal);
    return { dimensoes, embalagem: 'caixa', aviso: classificar(dimensoes, volume) };
  }

  // Beyond what Correios accepts in one parcel. The pedido does NOT fit, so
  // there is no "right" box — return the LARGEST legal one, keeping the item's
  // proportions, and let the caller tell the operator to split the pedido.
  // (Returning the item floors here would hand back a tiny box for an
  // oversized order, which reads as a correct estimate and is not one.)
  const maximo = [pisos.altura, pisos.largura, pisos.comprimento].map((v) =>
    Math.min(Math.max(v, 1), LIMITE_LEGAL_CM),
  );
  for (let passo = 0; passo < 8; passo++) {
    const soma = maximo[0]! + maximo[1]! + maximo[2]!;
    if (Math.abs(soma - somaMax) < 0.01) break;
    const escala = somaMax / soma;
    for (let i = 0; i < 3; i++) maximo[i] = Math.min(maximo[i]! * escala, LIMITE_LEGAL_CM);
  }
  return {
    dimensoes: finalizar({ altura: maximo[0]!, largura: maximo[1]!, comprimento: maximo[2]! }),
    embalagem: 'caixa',
    aviso: 'excedeuLimiteLegal',
  };
}

/**
 * The shipping package a marketplace is told about, in the units and the
 * precision the wire demands: whole centimetres and whole grams.
 *
 * ⚠️ Not {@link DimensoesCm}. That one is a box in real numbers, produced by
 * {@link estimarDimensoes} to answer "what will this fit in"; this one is a
 * DECLARATION, and its integrality is a validation rule of the receiving API
 * rather than a rounding convenience.
 */
export interface DimensoesPacote {
  alturaCm: number;
  larguraCm: number;
  profundidadeCm: number;
  pesoG: number;
}

/** A produto's own dimension/weight fields — the input {@link dimensoesDoPacote} reads. */
export type MedidasDoPacote = Pick<
  ProdutoMedidas,
  'alturaCm' | 'larguraCm' | 'profundidadeCm' | 'pesoBrutoKg' | 'pesoLiquidoKg'
>;

/**
 * The package a produto declares to a marketplace, or `null` when the produto
 * does not carry one.
 *
 * ⚠️ **Shared on purpose, exactly like {@link resolveCondicaoAnuncio}.** Two very
 * different callers need the same answer and any drift between them is
 * invisible: `apps/mercado-livre` turns it into the `SELLER_PACKAGE_*`
 * attributes of an item payload, and the produto's Mercado Livre tab shows the
 * operator what those attributes will say. One side is a wire value and the
 * other a screen — the failure mode is a screen that promises `10 cm` while the
 * payload ships `11 cm`, which nothing can catch. It lives here rather than in
 * the channel package because the channel package's root entry is not
 * browser-safe.
 *
 * **All four or nothing.** ML rejects a partial set outright
 * (`item.attribute.missing.seller.package.dimensions` — *"the attributes
 * seller_package_height, seller_package_length, seller_package_width,
 * seller_package_weight are all required"*), so a produto missing one axis
 * declares no package at all rather than three quarters of one. The caller is
 * expected to TELL the operator, not to invent the fourth: the legacy app filled
 * 10×10×10 cm and 0.25 kg, which publishes a measurement nobody took and which
 * ML's own realism check (`item.attribute.invalid.seller.package.dimensions`)
 * may reject anyway.
 *
 * **Gross weight wins.** `pesoBrutoKg ?? pesoLiquidoKg` — what ships is the
 * product plus its packaging, and that is what the carrier bills. `WEIGHT`, the
 * separate product-spec attribute, is the NET weight and is derived elsewhere;
 * the two are deliberately different numbers.
 *
 * **No parent fallback**, unlike {@link medidasDo}. A produto declares its own
 * package or declares none — inheriting a parent's box would silently ship the
 * parent's measurements for a variation that is a different size, and the
 * publish path this feeds already runs against the produto it is publishing.
 */
export function dimensoesDoPacote(
  medidas: MedidasDoPacote | null | undefined,
): DimensoesPacote | null {
  if (!medidas) return null;
  const { alturaCm, larguraCm, profundidadeCm } = medidas;
  const pesoKg = medidas.pesoBrutoKg ?? medidas.pesoLiquidoKg;
  if (alturaCm == null || larguraCm == null || profundidadeCm == null || pesoKg == null) {
    return null;
  }
  // Centimetres round UP: the package has to CONTAIN the product, and declaring
  // 5cm for a 5.5cm item is the error that costs a reship. Grams round to
  // nearest — the carrier bills the true weight, not a padded one.
  //
  // Everything floors at 1. `0 cm`/`0 g` is not a package, and a marketplace
  // that validates dimensions for realism rejects it; a produto weighing 0.0004
  // kg used to round to a flat zero.
  const cm = (v: number) => Math.max(1, Math.ceil(v));
  return {
    alturaCm: cm(alturaCm),
    larguraCm: cm(larguraCm),
    profundidadeCm: cm(profundidadeCm),
    pesoG: Math.max(1, Math.round(pesoKg * 1000)),
  };
}

/**
 * Which of the four inputs {@link dimensoesDoPacote} needed and did not get, in
 * the order they appear on the produto's "Dimensões e peso" tab — so a screen
 * can name the empty fields instead of saying "incompleto".
 *
 * Empty when the package resolves. `Peso` covers both weight fields, since
 * either one satisfies it.
 */
export function dimensoesDoPacoteFaltando(
  medidas: MedidasDoPacote | null | undefined,
): Array<'Peso' | 'Altura' | 'Largura' | 'Profundidade'> {
  if (dimensoesDoPacote(medidas) != null) return [];
  const faltando: Array<'Peso' | 'Altura' | 'Largura' | 'Profundidade'> = [];
  if ((medidas?.pesoBrutoKg ?? medidas?.pesoLiquidoKg) == null) faltando.push('Peso');
  if (medidas?.alturaCm == null) faltando.push('Altura');
  if (medidas?.larguraCm == null) faltando.push('Largura');
  if (medidas?.profundidadeCm == null) faltando.push('Profundidade');
  return faltando;
}

/**
 * `componentesKit` reshaped into the item list {@link estimarDimensoes} takes.
 * The map KEY is the component produto id, and only `quantidade` is consumed —
 * `limitarEstoque` constrains stock, never volume.
 */
export function itensDeComponentesKit(
  componentes: ComponentesKit | null | undefined,
): ItemDimensoes[] {
  return Object.entries(componentes ?? {}).map(([produtoUid, kit]) => ({
    produtoUid,
    quantidade: kit.quantidade,
  }));
}
