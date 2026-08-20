import {
  DIMENSOES_PADRAO,
  normalizeProdutoId,
  type DimensoesCm,
  type PesoPedidoItem,
  type ProdutoMedidas,
} from './pesoPedido';

export type { DimensoesCm };

/**
 * Packing efficiency for mixed items — you never fill a box to 100%. The
 * legacy used the same 0.7 (`.old/packages/pedido/lib/src/models.dart:2835`).
 *
 * It inflates the declared volume ~43%, which matters less than it looks:
 * Correios only bills *peso cubado* (`C x L x A / 6000`) once it exceeds the
 * real weight, i.e. above ~30.000 cm3. Below that this factor affects whether
 * the parcel is ACCEPTED, not what it costs.
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
 * Estimate the box (or bag) a pedido ships in — the re-derived half of #371,
 * replacing `Volume.padrao`'s hardcoded 10x10x10cm.
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
export function dimensoesPedido(
  itens: readonly PesoPedidoItem[],
  produtoMedidasById: Readonly<Record<string, ProdutoMedidas | null | undefined>>,
): EstimativaDimensoes {
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
  volume /= FATOR_OCUPACAO;

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
